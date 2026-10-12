import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';

export interface RunShare {
  id: string; tokenHash: string; runId: string; expiresAt: string; revokedAt: string | null; createdAt: string;
}
export interface RunShareStore {
  create(share: RunShare): Promise<void>;
  find(tokenHash: string): Promise<RunShare | undefined>;
  list(runId: string): Promise<RunShare[]>;
  revoke(runId: string, id: string, at: string): Promise<boolean>;
}
export const hashShareToken = (token: string): string => createHash('sha256').update(token).digest('hex');
export function shareTtlConfig(): { defaultSeconds: number; maxSeconds: number } {
  const read = (name: string, fallback: number): number => {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 31536000) throw new Error(`${name} must be an integer between 1 and 31536000`);
    return value;
  };
  const maxSeconds = read('AEEIS_SHARE_MAX_TTL_SECONDS', 30 * 86400);
  return { defaultSeconds: Math.min(read('AEEIS_SHARE_TTL_SECONDS', 7 * 86400), maxSeconds), maxSeconds };
}
export function newRunShare(runId: string, ttlSeconds: number): { token: string; share: RunShare } {
  const token = randomBytes(32).toString('base64url');
  return { token, share: { id: `share_${randomUUID()}`, tokenHash: hashShareToken(token), runId,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(), revokedAt: null, createdAt: new Date().toISOString() } };
}
export function activeShare(share: RunShare | undefined): share is RunShare {
  return Boolean(share && !share.revokedAt && Date.parse(share.expiresAt) > Date.now());
}
export class InMemoryRunShareStore implements RunShareStore {
  private shares = new Map<string, RunShare>();
  async create(share: RunShare): Promise<void> { this.shares.set(share.tokenHash, structuredClone(share)); }
  async find(hash: string): Promise<RunShare | undefined> { const share = this.shares.get(hash); return share && structuredClone(share); }
  async list(runId: string): Promise<RunShare[]> { return [...this.shares.values()].filter(s => s.runId === runId).map(s => structuredClone(s)); }
  async revoke(runId: string, id: string, at: string): Promise<boolean> {
    const share = [...this.shares.values()].find(s => s.runId === runId && s.id === id);
    if (!share) return false;
    share.revokedAt ??= at; return true;
  }
}
/** Shares use the Run repository's single-process writer lock and atomic replacement convention. */
export class FileRunShareStore implements RunShareStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}
  private get path(): string { return join(this.directory, '.run-shares.json'); }
  private async read(): Promise<RunShare[]> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as RunShare[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private mutate<T>(change: (shares: RunShare[]) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const shares = await this.read(), result = change(shares);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(shares)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const dir = await open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      return result;
    });
    this.queue = next.catch(() => undefined); return next;
  }
  async create(share: RunShare): Promise<void> { await this.mutate(shares => { shares.push(structuredClone(share)); }); }
  async find(hash: string): Promise<RunShare | undefined> { await this.queue; return (await this.read()).find(s => s.tokenHash === hash); }
  async list(runId: string): Promise<RunShare[]> { await this.queue; return (await this.read()).filter(s => s.runId === runId); }
  revoke(runId: string, id: string, at: string): Promise<boolean> {
    return this.mutate(shares => { const share = shares.find(s => s.runId === runId && s.id === id); if (!share) return false; share.revokedAt ??= at; return true; });
  }
}
// Adapter bootstrap migrations in this repository run under withPostgresMigrationLock.
// Keep this SQL in sync with src/adapters/migrations/001-run-shares.sql.
export const runSharesMigration = `CREATE TABLE IF NOT EXISTS aeeis_run_shares (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  run_id text NOT NULL REFERENCES aeeis_runs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS aeeis_run_shares_run_idx ON aeeis_run_shares(run_id, created_at);`;
type ShareRow = { id: string; token_hash: string; run_id: string; expires_at: Date; revoked_at: Date | null; created_at: Date };
const fromRow = (row: ShareRow): RunShare => ({ id: row.id, tokenHash: row.token_hash, runId: row.run_id, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, createdAt: row.created_at.toISOString() });
export class PostgresRunShareStore implements RunShareStore {
  constructor(private pool: pg.Pool) {}
  async create(s: RunShare): Promise<void> { await this.pool.query('INSERT INTO aeeis_run_shares(id,token_hash,run_id,expires_at,revoked_at,created_at) VALUES($1,$2,$3,$4,$5,$6)', [s.id, s.tokenHash, s.runId, s.expiresAt, s.revokedAt, s.createdAt]); }
  async find(hash: string): Promise<RunShare | undefined> { const result = await this.pool.query<ShareRow>('SELECT * FROM aeeis_run_shares WHERE token_hash=$1', [hash]); return result.rows[0] && fromRow(result.rows[0]); }
  async list(runId: string): Promise<RunShare[]> { return (await this.pool.query<ShareRow>('SELECT * FROM aeeis_run_shares WHERE run_id=$1 ORDER BY created_at DESC', [runId])).rows.map(fromRow); }
  async revoke(runId: string, id: string, at: string): Promise<boolean> { return Boolean((await this.pool.query('UPDATE aeeis_run_shares SET revoked_at=COALESCE(revoked_at,$3) WHERE run_id=$1 AND id=$2', [runId, id, at])).rowCount); }
}
