import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { encodeRunEventCursor, type RunRepository, type RunEventScanRecord } from './runtime/repository.js';
import type { AgentRun, Event } from './runtime/contracts.js';

const runId = z.string().regex(/^run_[a-f0-9-]{36}$/);
const nameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
const cursorSchema = z.object({
  afterId: runId.optional(), throughId: runId.optional(),
  // afterId stays before this Run until every captured event is attempted.
  resume: z.object({ runId, offset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const checkpointSchema = z.object({ revision: z.number().int().nonnegative(), cursor: cursorSchema }).strict();
const stateSchema = z.record(nameSchema, checkpointSchema);
export type RunScanCheckpoint = z.infer<typeof checkpointSchema>;
export type RunScanState = z.infer<typeof cursorSchema>;

/** Checkpoints are scheduling hints, never evidence that a signal succeeded.
 * CAS protects newer progress from stale workers; canonical attempts and
 * candidate IDs continue to provide at-least-once replay correctness. */
export interface RunScanCursorStore {
  init(): Promise<void>;
  get(name: string): Promise<RunScanCheckpoint>;
  advance(name: string, expectedRevision: number, cursor: RunScanState): Promise<boolean>;
  close(): Promise<void>;
}

/** Local single-writer deployment, guarded by the Run repository writer lock. */
export class FileRunScanCursorStore implements RunScanCursorStore {
  private queue: Promise<unknown> = Promise.resolve();
  private state: Record<string, RunScanCheckpoint> = {};
  private loaded = false;
  constructor(private readonly path: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { this.state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = {}; }
    this.loaded = true;
  }
  async init(): Promise<void> { await this.serial(() => this.load()); }
  async get(name: string): Promise<RunScanCheckpoint> {
    nameSchema.parse(name);
    return this.serial(async () => { await this.load(); return structuredClone(this.state[name] ?? { revision: 0, cursor: {} }); });
  }
  async advance(name: string, expectedRevision: number, cursor: RunScanState): Promise<boolean> {
    nameSchema.parse(name);
    const checkpoint = checkpointSchema.parse({ revision: expectedRevision + 1, cursor });
    return this.serial(async () => {
      await this.load();
      if ((this.state[name]?.revision ?? 0) !== expectedRevision) return false;
      const next = { ...this.state, [name]: checkpoint };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path);
        const directory = await open(dirname(this.path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
        this.state = next;
        return true;
      } catch (error) { this.loaded = false; throw error; }
      finally { await unlink(temp).catch(() => undefined); }
    });
  }
  async close(): Promise<void> { await this.queue; }
}

export class PostgresRunScanCursorStore implements RunScanCursorStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'run-scan-cursors', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_run_scan_cursors (
        name text PRIMARY KEY, revision integer NOT NULL, cursor jsonb NOT NULL
      )`);
    });
  }
  async get(name: string): Promise<RunScanCheckpoint> {
    nameSchema.parse(name);
    const result = await this.pool.query('SELECT revision, cursor FROM aeeis_run_scan_cursors WHERE name=$1', [name]);
    return result.rows[0] ? checkpointSchema.parse(result.rows[0]) : { revision: 0, cursor: {} };
  }
  async advance(name: string, expectedRevision: number, cursor: RunScanState): Promise<boolean> {
    nameSchema.parse(name);
    const checkpoint = checkpointSchema.parse({ revision: expectedRevision + 1, cursor });
    const result = expectedRevision === 0
      ? await this.pool.query('INSERT INTO aeeis_run_scan_cursors(name, revision, cursor) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING RETURNING revision', [name, checkpoint.revision, checkpoint.cursor])
      : await this.pool.query('UPDATE aeeis_run_scan_cursors SET revision=$2, cursor=$3 WHERE name=$1 AND revision=$4 RETURNING revision', [name, checkpoint.revision, checkpoint.cursor, expectedRevision]);
    return result.rows.length === 1;
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export interface RunEventBatch {
  entries: Array<{ run: AgentRun; event: Event }>;
  /** Call only after all entries have been attempted. Failed entries are
   * revisited next sweep; a crash before this commit replays this batch. */
  commit(): Promise<boolean>;
}

export interface RunEventScannerOptions {
  /** Read the bounded event projection and load full Run state only for Runs
   * that actually contain events. The canonical Run remains authoritative. */
  useEventProjection?: boolean;
}

export class RunEventScanner {
  constructor(private readonly repository: RunRepository, private readonly store: RunScanCursorStore, private readonly name: string, private readonly pageSize = 25, private readonly options: RunEventScannerOptions = {}) {
    nameSchema.parse(name);
    if (!repository.scanPage) throw new Error('Run repository must support bounded scans');
    if (options.useEventProjection && (!repository.scanEventsPage || !repository.eventsPage)) throw new Error('Run repository must support event projection scans');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('Run scan page size must be between 1 and 200');
  }
  async batch(maxEvents: number): Promise<RunEventBatch> {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new Error('Run scan event limit must be between 1 and 1000');
    const checkpoint = await this.store.get(this.name);
    const previous = checkpoint.cursor;
    const projection = this.options.useEventProjection;
    const page = projection
      ? await this.repository.scanEventsPage!({
        ...(previous.afterId ? { afterId: previous.afterId } : {}),
        ...(previous.throughId ? { throughId: previous.throughId } : {}), limit: this.pageSize,
      })
      : await this.repository.scanPage!({
      ...(previous.afterId ? { afterId: previous.afterId } : {}),
      ...(previous.throughId ? { throughId: previous.throughId } : {}), limit: this.pageSize,
    });
    let next: RunScanState = { ...previous, ...(page.throughId ? { throughId: page.throughId } : {}) };
    const entries: RunEventBatch['entries'] = [];
    let complete = true;
    for (const scanned of page.runs) {
      if (projection) {
        const record = scanned as RunEventScanRecord;
        const resume = previous.resume?.runId === record.id ? previous.resume : undefined;
        const endOffset = resume ? Math.min(resume.endOffset, record.lastEventSeq) : record.lastEventSeq;
        if (endOffset === 0) { next.afterId = record.id; if (next.resume?.runId === record.id) delete next.resume; continue; }
        const limit = maxEvents - entries.length;
        if (limit <= 0) { complete = false; break; }
        const afterSeq = resume?.offset ?? 0;
        const eventsPage = await this.repository.eventsPage!(record.id, { owner: record.owner, tenantId: record.tenantId }, limit, encodeRunEventCursor(afterSeq));
        const events = eventsPage.events.filter(event => event.seq <= endOffset);
        if (events.length) {
          const run = await this.repository.get(record.id, { owner: record.owner, tenantId: record.tenantId });
          for (const event of events) entries.push({ run, event });
        }
        const lastSeq = events.at(-1)?.seq ?? afterSeq;
        const hasRemaining = Boolean(eventsPage.nextCursor) || lastSeq < endOffset;
        if (hasRemaining) {
          next = { ...(next.afterId ? { afterId: next.afterId } : {}), ...(next.throughId ? { throughId: next.throughId } : {}), resume: { runId: record.id, offset: lastSeq, endOffset } };
          complete = false;
          break;
        }
        next.afterId = record.id;
        if (next.resume?.runId === record.id) delete next.resume;
        continue;
      }
      const run = scanned as AgentRun;
      // Newly inserted IDs before a partial Run can still be visited. Keep its
      // resume position until we reach it, even across a page boundary.
      const offset = previous.resume?.runId === run.id ? previous.resume.offset : 0;
      const endOffset = previous.resume?.runId === run.id ? Math.min(previous.resume.endOffset, run.events.length) : run.events.length;
      let index = offset;
      while (index < endOffset && entries.length < maxEvents) {
        entries.push({ run, event: run.events[index]! }); index++;
      }
      if (index < endOffset) {
        // If this page gained a Run before the partial Run, restarting the
        // latter at zero is safe: domain idempotency prevents duplicate work.
        next = { ...(next.afterId ? { afterId: next.afterId } : {}), ...(next.throughId ? { throughId: next.throughId } : {}), resume: { runId: run.id, offset: index, endOffset } };
        complete = false;
        break;
      }
      next.afterId = run.id;
      if (next.resume && next.resume.runId <= run.id) delete next.resume;
    }
    if (complete && page.done) next = {};
    // Do not publish an unattempted batch or advance on read/processing errors.
    return { entries, commit: () => this.store.advance(this.name, checkpoint.revision, next) };
  }
}
