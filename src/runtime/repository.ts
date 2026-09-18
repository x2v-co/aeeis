import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import type { AgentRun } from './contracts.js';

export interface RunRepository {
  create(run: AgentRun): Promise<void>;
  get(id: string): Promise<AgentRun>;
  list(): Promise<AgentRun[]>;
  mutate(id: string, change: (run: AgentRun) => void): Promise<AgentRun>;
  close(): Promise<void>;
}
export class NotFound extends Error {}
function validateId(id: string): void {
  if (!/^run_[a-f0-9-]{36}$/.test(id)) throw new NotFound('Unknown run');
}

// Single-process local adapter. The lock prevents two API processes from sharing a directory.
// Mutations write a complete run aggregate (state, receipts, artifacts) in one replacement.
export class FileRunRepository implements RunRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  constructor(private directory: string) { this.lockPath = join(directory, '.writer.lock'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid repository lock; inspect before recovery');
      try { process.kill(pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(this.lockPath); return this.init(); }
        throw e;
      }
      throw new Error('Data directory already has a live writer');
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private path(id: string): string { validateId(id); return join(this.directory, `${id}.json`); }
  private async save(run: AgentRun): Promise<void> {
    const path = this.path(run.id), temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(run)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  create(run: AgentRun): Promise<void> {
    return this.serial(async () => {
      try { await this.get(run.id); throw new Error('Run already exists'); }
      catch (e) { if (!(e instanceof NotFound)) throw e; }
      await this.save(run);
    });
  }
  async get(id: string): Promise<AgentRun> {
    try { return JSON.parse(await readFile(this.path(id), 'utf8')) as AgentRun; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound('Unknown run'); throw e; }
  }
  async list(): Promise<AgentRun[]> {
    const { readdir } = await import('node:fs/promises');
    const ids = (await readdir(this.directory)).filter(n => /^run_[a-f0-9-]{36}\.json$/.test(n));
    return Promise.all(ids.map(n => this.get(n.slice(0, -5))));
  }
  mutate(id: string, change: (run: AgentRun) => void): Promise<AgentRun> {
    return this.serial(async () => {
      const run = await this.get(id);
      change(run); run.revision++; run.updatedAt = new Date().toISOString();
      await this.save(run); return run;
    });
  }
  async close(): Promise<void> { await this.queue; await unlink(this.lockPath); }
}

export class PostgresRunRepository implements RunRepository {
  private pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS aeeis_runs (
      id text PRIMARY KEY, revision integer NOT NULL, state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  }
  async create(run: AgentRun): Promise<void> {
    await this.pool.query('INSERT INTO aeeis_runs(id, revision, state) VALUES($1, $2, $3)', [run.id, run.revision, run]);
  }
  async get(id: string): Promise<AgentRun> {
    validateId(id);
    const result = await this.pool.query('SELECT state FROM aeeis_runs WHERE id=$1', [id]);
    if (!result.rows[0]) throw new NotFound('Unknown run');
    return result.rows[0].state as AgentRun;
  }
  async list(): Promise<AgentRun[]> {
    const result = await this.pool.query('SELECT state FROM aeeis_runs ORDER BY updated_at DESC');
    return result.rows.map(r => r.state as AgentRun);
  }
  async mutate(id: string, change: (run: AgentRun) => void): Promise<AgentRun> {
    validateId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT state FROM aeeis_runs WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new NotFound('Unknown run');
      const run = result.rows[0].state as AgentRun;
      change(run); run.revision++; run.updatedAt = new Date().toISOString();
      await client.query('UPDATE aeeis_runs SET revision=$2, state=$3, updated_at=now() WHERE id=$1', [id, run.revision, run]);
      await client.query('COMMIT'); return run;
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
