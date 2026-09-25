import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import type { AgentRun } from './contracts.js';
import { withPostgresMigrationLock } from '../adapters/postgres-migration.js';
import { scopedRecent, validateCollectionLimit } from '../adapters/collection-query.js';

export interface RunRepository {
  create(run: AgentRun): Promise<void>;
  get(id: string, scope?: Ownership): Promise<AgentRun>;
  list(scope?: Ownership, limit?: number): Promise<AgentRun[]>;
  /** Lightweight dependency probe that must not load the Run history. */
  health?(): Promise<void>;
  /** Tenant-bounded discovery used by Room-shared read views. */
  listByTenant?(tenantId: string, limit?: number): Promise<AgentRun[]>;
  /** Stable keyset page for long-lived history views. */
  page?(scope: Ownership, limit: number, cursor?: string): Promise<RunPage>;
  /** Storage-side shared read page. The repository applies tenant, goal and
   * privacy predicates before LIMIT so Room-shared history does not require
   * loading the entire tenant into the API process. */
  pageVisible?(scope: Ownership, readableGoalIds: readonly string[], limit: number, cursor?: string): Promise<RunPage>;
  /** Paginated event projection for timeline/changefeed consumers. */
  eventsPage?(id: string, scope: Ownership, limit: number, cursor?: string): Promise<RunEventsPage>;
  /** Bounded cyclic background scan; immutable IDs avoid chasing own writes. */
  scanPage?(query: RunScanQuery): Promise<RunScanPage>;
  /** Bounded metadata scan for consumers that can read the event projection. */
  scanEventsPage?(query: RunScanQuery): Promise<RunEventScanPage>;
  /** Bounded scan for Runs whose durable state may need crash recovery. */
  scanRecoveryPage?(query: RunScanQuery): Promise<RunRecoveryScanPage>;
  /** Low-latency hint for consumers; durable scanners remain the recovery path. */
  subscribeChanges?(handler: (change: RunChange) => void | Promise<void>): Promise<() => Promise<void>>;
  /** Holds the Run lock through the callback and commit. Async callbacks must
   * not re-enter this repository; external ledger writes remain recoverable. */
  mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun>;
  close(): Promise<void>;
}
export interface RunChange { runId: string; owner: string; tenantId: string; lastEventSeq: number; updatedAt: string }
export interface RunScanQuery { afterId?: string; throughId?: string; limit: number }
export interface RunScanPage { runs: AgentRun[]; throughId?: string; done: boolean }
/** Lightweight records used by replay pumps. The Run state is loaded only
 * after the event projection reports work for a record. */
export interface RunEventScanRecord { id: string; owner: string; tenantId: string; eventCount: number; lastEventSeq: number }
export interface RunEventScanPage { runs: RunEventScanRecord[]; throughId?: string; done: boolean }
export interface RunRecoveryScanRecord { id: string; owner: string; tenantId: string }
export interface RunRecoveryScanPage { runs: RunRecoveryScanRecord[]; throughId?: string; done: boolean }
export interface RunPage { runs: AgentRun[]; nextCursor?: string }
export interface RunEventsPage { events: AgentRun['events']; nextCursor?: string }
function validateScan(query: RunScanQuery): void {
  validateCollectionLimit(query.limit);
  if (query.afterId !== undefined) validateId(query.afterId);
  if (query.throughId !== undefined) validateId(query.throughId);
}
export class NotFound extends Error {}
function validateId(id: string): void {
  if (!/^run_[a-f0-9-]{36}$/.test(id)) throw new NotFound('Unknown run');
}
type PageKey = { updatedAt: string; id: string };
type FileRunSummary = { id: string; owner: string; tenantId: string; updatedAt: string; eventCount: number; privacy: AgentRun['privacy']; goalId?: string; lastEventId?: string; lastEventSeq?: number; needsRecovery: boolean };
function encodePageKey(key: PageKey): string { return Buffer.from(JSON.stringify({ updatedAt: key.updatedAt, id: key.id }), 'utf8').toString('base64url'); }
function decodePageKey(value: string | undefined): PageKey | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageKey>;
    if (typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.id !== 'string') throw new Error();
    validateId(parsed.id);
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch { throw new RangeError('Invalid run page cursor'); }
}
function recentRunCompare(left: { id: string; updatedAt: string }, right: { id: string; updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function afterPageKey(item: { id: string; updatedAt: string }, cursor: PageKey | undefined): boolean {
  if (!cursor) return true;
  const time = Date.parse(item.updatedAt), cursorTime = Date.parse(cursor.updatedAt);
  return time < cursorTime || (time === cursorTime && item.id > cursor.id);
}
export function encodeRunEventCursor(seq: number): string { return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url'); }
function decodeEventCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { seq?: unknown };
    if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 0) throw new Error();
    return parsed.seq as number;
  } catch { throw new RangeError('Invalid run event cursor'); }
}

// Single-process local adapter. The lock prevents two API processes from sharing a directory.
// Mutations write a complete run aggregate (state, receipts, artifacts) in one replacement.
export class FileRunRepository implements RunRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  private indexPath: string;
  private summaries: Map<string, FileRunSummary> | undefined;
  private readonly changeSubscribers = new Set<(change: RunChange) => void | Promise<void>>();
  constructor(private directory: string) { this.lockPath = join(directory, '.writer.lock'); this.indexPath = join(directory, '.runs.index.json'); }
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
  async health(): Promise<void> {
    await stat(this.directory);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }
  private path(id: string): string { validateId(id); return join(this.directory, `${id}.json`); }
  private eventPath(id: string): string { validateId(id); return join(this.directory, `${id}.events.json`); }
  private async saveEvents(run: AgentRun): Promise<void> {
    const path = this.eventPath(run.id), temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(run.events)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  }
  private async saveIndex(): Promise<void> {
    if (!this.summaries) return;
    const entries = await Promise.all([...this.summaries.values()].map(async summary => {
      const file = await stat(this.path(summary.id));
      return { ...summary, size: file.size, mtimeMs: file.mtimeMs };
    }));
    const temp = `${this.indexPath}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 2, entries }));
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, this.indexPath);
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async subscribeChanges(handler: (change: RunChange) => void | Promise<void>): Promise<() => Promise<void>> {
    this.changeSubscribers.add(handler);
    return async () => { this.changeSubscribers.delete(handler); };
  }
  private async save(run: AgentRun): Promise<void> {
    const path = this.path(run.id), temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(run)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    // The event file is a disposable projection. If this write fails, the
    // canonical aggregate remains authoritative and eventsPage falls back to it.
    await this.saveEvents(run);
    this.summaries?.set(run.id, this.summary(run));
    // The index is a disposable acceleration structure. Canonical Run and
    // event files are already durable; if index publication fails, the next
    // process rebuilds it from those files.
    try { await this.saveIndex(); } catch { /* best effort; canonical state is already durable */ }
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    const change: RunChange = { runId: run.id, owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local', lastEventSeq: run.events.at(-1)?.seq ?? 0, updatedAt: run.updatedAt };
    for (const subscriber of this.changeSubscribers) {
      const hint = { ...change };
      void Promise.resolve().then(() => subscriber(hint)).catch(() => undefined);
    }
  }
  create(run: AgentRun): Promise<void> {
    return this.serial(async () => {
      try { await this.get(run.id); throw new Error('Run already exists'); }
      catch (e) { if (!(e instanceof NotFound)) throw e; }
      await this.save(run);
    });
  }
  async get(id: string, scope?: Ownership): Promise<AgentRun> {
    try {
      const run = JSON.parse(await readFile(this.path(id), 'utf8')) as AgentRun;
      if (scope && !isOwnedBy(run, scope)) throw new NotFound('Unknown run');
      return run;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound('Unknown run'); throw e; }
  }
  private summary(run: AgentRun): FileRunSummary {
    const needsRecovery = run.calls.some(call => call.state === 'started')
      || Boolean(run.pendingTool && (!run.pendingTool.receiptId || run.pendingTool.executionToken || run.pendingTool.reconcileInFlight === true))
      || Boolean(run.pendingDelegation && (!run.pendingDelegation.receiptRef || run.pendingDelegation.executionToken || run.pendingDelegation.reconcileInFlight === true))
      // Recovery also performs idempotent domain and Project Pulse projection
      // after a crash between the Run commit and the projection commit.
      || Boolean(run.taskExecution)
      || Boolean(run.goalId && run.domainPlanId)
      || Boolean(run.status === 'succeeded' && run.goalId && (run.builtinSkill === 'project-pulse/1' || run.projectSourceQuery)
        && !run.events.some(item => item.type === 'project-pulse.next-actions.projected'));
    const privacy: AgentRun['privacy'] = run.privacy ?? 'internal';
    return { id: run.id, owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local', updatedAt: run.updatedAt, eventCount: run.events.length, privacy, ...(run.goalId ? { goalId: run.goalId } : {}), needsRecovery, ...(run.events.length ? { lastEventId: run.events.at(-1)!.id, lastEventSeq: run.events.at(-1)!.seq } : { lastEventSeq: 0 }) };
  }
  private async ensureSummaries(): Promise<void> {
    if (this.summaries) return;
    const files = (await readdir(this.directory)).filter(file => /^run_[a-f0-9-]{36}\.json$/.test(file));
    const ids = files.map(file => file.slice(0, -5)).sort();
    const indexed = await this.loadIndex(ids);
    if (indexed) { this.summaries = indexed; return; }
    // Rebuild from canonical records only when the durable acceleration
    // structure is missing, malformed, or does not match the files. File
    // mtimes and UUIDs are never used for logical ordering; they only detect
    // a write that happened after the previous index publication.
    const summaries = new Map<string, FileRunSummary>();
    for (const id of ids) {
      const run = await this.get(id);
      summaries.set(run.id, this.summary(run));
    }
    this.summaries = summaries;
  }
  private async loadIndex(ids: string[]): Promise<Map<string, FileRunSummary> | undefined> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.indexPath, 'utf8')); } catch { return undefined; }
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 2 || !Array.isArray((raw as { entries?: unknown }).entries)) return undefined;
    const entries = (raw as { entries: unknown[] }).entries;
    if (entries.length !== ids.length) return undefined;
    const byId = new Map<string, FileRunSummary>();
    for (const item of entries) {
      if (!item || typeof item !== 'object') return undefined;
      const value = item as Record<string, unknown>;
      if (typeof value.id !== 'string' || !/^run_[a-f0-9-]{36}$/.test(value.id)
        || typeof value.owner !== 'string' || typeof value.tenantId !== 'string'
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        || !Number.isSafeInteger(value.eventCount) || (value.eventCount as number) < 0
        || !['public', 'internal', 'confidential', 'private'].includes(String(value.privacy))
        || (value.goalId !== undefined && typeof value.goalId !== 'string')
        || typeof value.needsRecovery !== 'boolean' || !Number.isFinite(value.size as number)
        || !Number.isFinite(value.mtimeMs as number) || byId.has(value.id)) return undefined;
      const file = await stat(this.path(value.id)).catch(() => undefined);
      if (!file || file.size !== value.size || file.mtimeMs !== value.mtimeMs) return undefined;
      const privacy: AgentRun['privacy'] = value.privacy === 'public' || value.privacy === 'internal' || value.privacy === 'confidential' || value.privacy === 'private' ? value.privacy : 'internal';
      const summary: FileRunSummary = {
        id: value.id, owner: value.owner, tenantId: value.tenantId, updatedAt: value.updatedAt,
        eventCount: value.eventCount as number,
        privacy,
        ...(typeof value.goalId === 'string' ? { goalId: value.goalId } : {}),
        needsRecovery: value.needsRecovery,
        ...(typeof value.lastEventId === 'string' ? { lastEventId: value.lastEventId } : {}),
        ...(Number.isSafeInteger(value.lastEventSeq) ? { lastEventSeq: value.lastEventSeq as number } : {}),
      };
      byId.set(summary.id, summary);
    }
    if (ids.some(id => !byId.has(id))) return undefined;
    return byId;
  }
  list(scope?: Ownership, limit?: number): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      await this.ensureSummaries();
      const selected = scopedRecent([...this.summaries!.values()], item => item.updatedAt, scope, limit);
      return Promise.all(selected.map(item => this.get(item.id, scope)));
    });
  }
  listByTenant(tenantId: string, limit?: number): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      await this.ensureSummaries();
      const selected = scopedRecent([...this.summaries!.values()], item => item.updatedAt, undefined)
        .filter(item => item.tenantId === tenantId)
        .slice(0, limit);
      return Promise.all(selected.map(item => this.get(item.id)));
    });
  }
  page(scope: Ownership, limit: number, cursor?: string): Promise<RunPage> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      const pageKey = decodePageKey(cursor);
      await this.ensureSummaries();
      const selected = [...(this.summaries ?? new Map()).values()]
        .filter(item => isOwnedBy(item, scope) && afterPageKey(item, pageKey))
        .sort(recentRunCompare);
      const page = selected.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      return { runs: await Promise.all(visible.map(item => this.get(item.id, scope))), ...(hasMore && visible.length ? { nextCursor: encodePageKey(visible.at(-1)!) } : {}) };
    });
  }
  pageVisible(scope: Ownership, readableGoalIds: readonly string[], limit: number, cursor?: string): Promise<RunPage> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      const pageKey = decodePageKey(cursor);
      await this.ensureSummaries();
      const goals = new Set(readableGoalIds);
      const selected = [...(this.summaries ?? new Map()).values()]
        .filter(item => item.tenantId === scope.tenantId && (item.owner === scope.owner || (item.goalId !== undefined && goals.has(item.goalId) && (item.privacy === 'public' || item.privacy === 'internal'))))
        .filter(item => afterPageKey(item, pageKey))
        .sort(recentRunCompare);
      const page = selected.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      const runs = await Promise.all(visible.map(item => this.get(item.id)));
      return { runs, ...(hasMore && visible.length ? { nextCursor: encodePageKey(visible.at(-1)!) } : {}) };
    });
  }
  eventsPage(id: string, scope: Ownership, limit: number, cursor?: string): Promise<RunEventsPage> {
    return this.serial(async () => {
      validateId(id); validateCollectionLimit(limit);
      const afterSeq = decodeEventCursor(cursor);
      await this.ensureSummaries();
      const summary = this.summaries!.get(id);
      if (!summary || !isOwnedBy(summary, scope)) throw new NotFound('Unknown run');
      let events: AgentRun['events'];
      try { events = JSON.parse(await readFile(this.eventPath(id), 'utf8')) as AgentRun['events']; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        events = (await this.get(id, scope)).events;
      }
      if (events.length !== summary.eventCount || (events.length > 0 && events.at(-1)!.id !== summary.lastEventId)) events = (await this.get(id, scope)).events;
      const selected = events.filter(event => event.seq > afterSeq).sort((a, b) => a.seq - b.seq);
      const page = selected.slice(0, limit + 1); const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      return { events: visible, ...(hasMore && visible.length ? { nextCursor: encodeRunEventCursor(visible.at(-1)!.seq) } : {}) };
    });
  }
  scanPage(query: RunScanQuery): Promise<RunScanPage> {
    return this.serial(async () => {
      validateScan(query);
      // File mode needs only filenames here, not a cold parse of all Runs.
      const { readdir } = await import('node:fs/promises');
      const ids = (await readdir(this.directory)).filter(file => /^run_[a-f0-9-]{36}\.json$/.test(file)).map(file => file.slice(0, -5)).sort();
      const throughId = query.throughId ?? ids.at(-1);
      const available = ids.filter(id => (query.afterId === undefined || id > query.afterId) && throughId !== undefined && id <= throughId);
      const selected = available.slice(0, query.limit);
      return { runs: await Promise.all(selected.map(id => this.get(id))), ...(throughId ? { throughId } : {}), done: available.length <= query.limit };
    });
  }
  scanEventsPage(query: RunScanQuery): Promise<RunEventScanPage> {
    return this.serial(async () => {
      validateScan(query);
      await this.ensureSummaries();
      const ids = [...(this.summaries?.keys() ?? [])].sort();
      const throughId = query.throughId ?? ids.at(-1);
      if (!throughId) return { runs: [], done: true };
      const available = ids.filter(id => (query.afterId === undefined || id > query.afterId) && id <= throughId);
      const selected = available.slice(0, query.limit);
      return {
        runs: selected.map(id => {
          const summary = this.summaries!.get(id)!;
          return { id: summary.id, owner: summary.owner, tenantId: summary.tenantId, eventCount: summary.eventCount, lastEventSeq: summary.lastEventSeq ?? 0 };
        }),
        throughId,
        done: available.length <= query.limit,
      };
    });
  }
  scanRecoveryPage(query: RunScanQuery): Promise<RunRecoveryScanPage> {
    return this.serial(async () => {
      validateScan(query);
      await this.ensureSummaries();
      const ids = [...(this.summaries?.keys() ?? [])].sort();
      const throughId = query.throughId ?? ids.at(-1);
      if (!throughId) return { runs: [], done: true };
      const available = ids.filter(id => (query.afterId === undefined || id > query.afterId) && id <= throughId)
        .map(id => this.summaries!.get(id)!).filter(summary => summary.needsRecovery);
      const selected = available.slice(0, query.limit);
      return { runs: selected.map(summary => ({ id: summary.id, owner: summary.owner, tenantId: summary.tenantId })), throughId, done: available.length <= query.limit };
    });
  }
  mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun> {
    return this.serial(async () => {
      const run = await this.get(id, scope);
      const ownership = { owner: run.owner, tenantId: run.tenantId ?? 'local' };
      await change(run);
      if (!isOwnedBy(run, ownership)) throw new Error('Run ownership is immutable'); run.revision++; run.updatedAt = new Date().toISOString();
      await this.save(run); return run;
    });
  }
  async close(): Promise<void> { await this.queue; this.changeSubscribers.clear(); this.summaries = undefined; await unlink(this.lockPath); }
}

export class PostgresRunRepository implements RunRepository {
  private pool: pg.Pool;
  private readonly changeSubscribers = new Map<(change: RunChange) => void | Promise<void>, PostgresChangeSubscription>();
  private changeChannel = 'aeeis_run_changes';
  private closed = false;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    const schema = await this.pool.query<{ schema: string }>('SELECT current_schema() AS schema');
    const schemaName = schema.rows[0]?.schema ?? 'public';
    this.changeChannel = `aeeis_run_changes_${createHash('sha256').update(schemaName).digest('hex').slice(0, 40)}`;
    await withPostgresMigrationLock(this.pool, 'runs', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_runs (
        id text PRIMARY KEY, revision integer NOT NULL, state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_runs_owner_idx ON aeeis_runs ((COALESCE(state->>'tenantId', 'local')), (COALESCE(state->>'owner', 'owner')))`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_runs_recent_idx ON aeeis_runs ((COALESCE(state->>'tenantId', 'local')), (COALESCE(state->>'owner', 'owner')), updated_at DESC, id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_runs_shared_recent_idx ON aeeis_runs ((COALESCE(state->>'tenantId', 'local')), (state->>'goalId'), updated_at DESC, id) WHERE COALESCE(state->>'privacy', 'internal') IN ('public', 'internal')`);
      // Older builds stamped the row with transaction time independently of
      // the canonical Run. Align existing rows before using SQL top-N order.
      await client.query(`UPDATE aeeis_runs SET updated_at=(state->>'updatedAt')::timestamptz WHERE updated_at IS DISTINCT FROM (state->>'updatedAt')::timestamptz`);
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_run_events (
        run_id text NOT NULL, seq integer NOT NULL, event_id text NOT NULL, type text NOT NULL,
        at timestamptz NOT NULL, data jsonb NOT NULL, owner text NOT NULL, tenant_id text NOT NULL,
        PRIMARY KEY(run_id, seq), UNIQUE(event_id)
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_run_events_scope_idx ON aeeis_run_events(owner, tenant_id, run_id, seq)');
      // Backfill the disposable projection for databases created before the
      // event table existed. Existing Run JSON remains the source of truth.
      await client.query(`INSERT INTO aeeis_run_events(run_id,seq,event_id,type,at,data,owner,tenant_id)
        SELECT r.id, (event->>'seq')::integer, event->>'id', event->>'type', (event->>'at')::timestamptz,
          COALESCE(event->'data','{}'::jsonb), COALESCE(r.state->>'owner','owner'), COALESCE(r.state->>'tenantId','local')
        FROM aeeis_runs r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.state->'events','[]'::jsonb)) event
        ON CONFLICT DO NOTHING`);
    });
  }
  async health(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async create(run: AgentRun): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO aeeis_runs(id, revision, state, updated_at) VALUES($1, $2, $3, $4)', [run.id, run.revision, run, run.updatedAt]);
      await this.insertEvents(client, run, 0);
      await client.query('COMMIT');
      await this.notifyChange(client, run);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async insertEvents(client: pg.PoolClient, run: AgentRun, from: number): Promise<void> {
    for (const item of run.events.slice(from)) {
      await client.query('INSERT INTO aeeis_run_events(run_id,seq,event_id,type,at,data,owner,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [run.id, item.seq, item.id, item.type, item.at, item.data, run.owner ?? 'owner', run.tenantId ?? 'local']);
    }
  }
  private async notifyChange(client: pg.PoolClient, run: AgentRun): Promise<void> {
    const change: RunChange = { runId: run.id, owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local', lastEventSeq: run.events.at(-1)?.seq ?? 0, updatedAt: run.updatedAt };
    try { await client.query('SELECT pg_notify($1, $2)', [this.changeChannel, JSON.stringify(change)]); } catch { /* durable scanner fallback */ }
  }
  async subscribeChanges(handler: (change: RunChange) => void | Promise<void>): Promise<() => Promise<void>> {
    if (this.closed) throw new Error('Run repository is closed');
    const previous = this.changeSubscribers.get(handler);
    if (previous) await this.stopChangeSubscription(handler, previous);
    const subscription: PostgresChangeSubscription = { handler, client: undefined, listener: undefined, errorListener: undefined, reconnectTimer: undefined, stopped: false, reconnectAttempt: 0 };
    this.changeSubscribers.set(handler, subscription);
    try { await this.openChangeSubscription(subscription); }
    catch (error) { await this.stopChangeSubscription(handler, subscription); throw error; }
    return async () => {
      const current = this.changeSubscribers.get(handler);
      if (current !== subscription) return;
      await this.stopChangeSubscription(handler, subscription);
    };
  }
  private async openChangeSubscription(subscription: PostgresChangeSubscription): Promise<void> {
    if (this.closed || subscription.stopped) return;
    const client = await this.pool.connect();
    subscription.client = client;
    const quotedChannel = `"${this.changeChannel.replaceAll('"', '""')}"`;
    const onNotification = (message: pg.Notification) => {
      if (message.channel !== this.changeChannel || !message.payload || subscription.stopped) return;
      try {
        const parsed = JSON.parse(message.payload) as Partial<RunChange>;
        const lastEventSeq = parsed.lastEventSeq;
        if (typeof parsed.runId !== 'string' || !/^run_[a-f0-9-]{36}$/.test(parsed.runId) || typeof parsed.owner !== 'string' || parsed.owner.length > 512 || typeof parsed.tenantId !== 'string' || parsed.tenantId.length > 512 || !Number.isSafeInteger(lastEventSeq) || (lastEventSeq as number) < 0 || typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt))) return;
        void Promise.resolve().then(() => subscription.handler(parsed as RunChange)).catch(() => undefined);
      } catch { /* hints are disposable; the durable scanner recovers */ }
    };
    const onError = () => {
      if (subscription.client !== client || subscription.stopped) return;
      subscription.client = undefined;
      client.removeListener('notification', onNotification);
      client.removeListener('error', onError);
      client.release(true);
      this.scheduleChangeReconnect(subscription);
    };
    client.on('error', onError);
    try { await client.query(`LISTEN ${quotedChannel}`); }
    catch (error) { subscription.client = undefined; client.removeListener('error', onError); client.release(true); throw error; }
    if (this.closed || subscription.stopped) {
      subscription.client = undefined;
      client.removeListener('error', onError);
      client.release(true);
      return;
    }
    subscription.listener = onNotification;
    subscription.errorListener = onError;
    subscription.reconnectAttempt = 0;
    client.on('notification', onNotification);
  }
  private scheduleChangeReconnect(subscription: PostgresChangeSubscription): void {
    if (this.closed || subscription.stopped || subscription.reconnectTimer) return;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(subscription.reconnectAttempt++, 7));
    subscription.reconnectTimer = setTimeout(() => {
      subscription.reconnectTimer = undefined;
      void this.openChangeSubscription(subscription).catch(() => this.scheduleChangeReconnect(subscription));
    }, delay);
    subscription.reconnectTimer.unref?.();
  }
  private async stopChangeSubscription(handler: (change: RunChange) => void | Promise<void>, subscription: PostgresChangeSubscription): Promise<void> {
    subscription.stopped = true;
    if (subscription.reconnectTimer) { clearTimeout(subscription.reconnectTimer); subscription.reconnectTimer = undefined; }
    if (this.changeSubscribers.get(handler) === subscription) this.changeSubscribers.delete(handler);
    const client = subscription.client;
    subscription.client = undefined;
    if (!client) return;
    if (subscription.listener) client.removeListener('notification', subscription.listener);
    if (subscription.errorListener) client.removeListener('error', subscription.errorListener);
    client.release(true);
  }
  async get(id: string, scope?: Ownership): Promise<AgentRun> {
    validateId(id);
    const result = await this.pool.query(`SELECT state FROM aeeis_runs WHERE id=$1${scope ? " AND COALESCE(state->>'owner', 'owner')=$2 AND COALESCE(state->>'tenantId', 'local')=$3" : ''}`, scope ? [id, scope.owner, scope.tenantId] : [id]);
    if (!result.rows[0]) throw new NotFound('Unknown run');
    return result.rows[0].state as AgentRun;
  }
  async list(scope?: Ownership, limit?: number): Promise<AgentRun[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query(`SELECT state FROM aeeis_runs${scope ? " WHERE COALESCE(state->>'owner', 'owner')=$1 AND COALESCE(state->>'tenantId', 'local')=$2" : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(r => r.state as AgentRun);
  }
  async listByTenant(tenantId: string, limit?: number): Promise<AgentRun[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = [tenantId];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: AgentRun }>(`SELECT state FROM aeeis_runs WHERE COALESCE(state->>'tenantId', 'local')=$1 ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(row => row.state);
  }
  async page(scope: Ownership, limit: number, cursor?: string): Promise<RunPage> {
    validateCollectionLimit(limit);
    const pageKey = decodePageKey(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId];
    const cursorClause = pageKey ? ` AND (updated_at < $3::timestamptz OR (updated_at = $3::timestamptz AND id > $4))` : '';
    if (pageKey) values.push(pageKey.updatedAt, pageKey.id);
    values.push(limit + 1);
    const result = await this.pool.query<{ state: AgentRun }>(
      `SELECT state FROM aeeis_runs WHERE COALESCE(state->>'owner', 'owner')=$1 AND COALESCE(state->>'tenantId', 'local')=$2${cursorClause} ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { runs: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodePageKey({ id: visible.at(-1)!.state.id, updatedAt: visible.at(-1)!.state.updatedAt }) } : {}) };
  }
  async pageVisible(scope: Ownership, readableGoalIds: readonly string[], limit: number, cursor?: string): Promise<RunPage> {
    validateCollectionLimit(limit);
    const pageKey = decodePageKey(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId, [...new Set(readableGoalIds)]];
    const cursorClause = pageKey ? ` AND (updated_at < $4::timestamptz OR (updated_at = $4::timestamptz AND id > $5))` : '';
    if (pageKey) values.push(pageKey.updatedAt, pageKey.id);
    values.push(limit + 1);
    const result = await this.pool.query<{ state: AgentRun }>(
      `SELECT state FROM aeeis_runs
        WHERE COALESCE(state->>'tenantId', 'local')=$2
          AND (
            COALESCE(state->>'owner', 'owner')=$1
            OR (
              COALESCE(state->>'goalId', '') = ANY($3::text[])
              AND COALESCE(state->>'privacy', 'internal') IN ('public', 'internal')
            )
          )${cursorClause}
        ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { runs: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodePageKey({ id: visible.at(-1)!.state.id, updatedAt: visible.at(-1)!.state.updatedAt }) } : {}) };
  }
  async eventsPage(id: string, scope: Ownership, limit: number, cursor?: string): Promise<RunEventsPage> {
    validateId(id); validateCollectionLimit(limit);
    const afterSeq = decodeEventCursor(cursor);
    const visibleRun = await this.pool.query('SELECT 1 FROM aeeis_runs WHERE id=$1 AND COALESCE(state->>\'owner\',\'owner\')=$2 AND COALESCE(state->>\'tenantId\',\'local\')=$3', [id, scope.owner, scope.tenantId]);
    if (!visibleRun.rows[0]) throw new NotFound('Unknown run');
    const values: unknown[] = [id, scope.owner, scope.tenantId, afterSeq, limit + 1];
    const result = await this.pool.query<{ seq: number; event_id: string; type: string; at: string; data: Record<string, unknown> }>(
      'SELECT seq,event_id,type,at,data FROM aeeis_run_events WHERE run_id=$1 AND owner=$2 AND tenant_id=$3 AND seq>$4 ORDER BY seq ASC LIMIT $5', values);
    const hasMore = result.rows.length > limit; const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const events = rows.map(row => ({ id: row.event_id, seq: row.seq, type: row.type, at: new Date(row.at).toISOString(), data: row.data }));
    return { events, ...(hasMore && events.length ? { nextCursor: encodeRunEventCursor(events.at(-1)!.seq) } : {}) };
  }
  async scanPage(query: RunScanQuery): Promise<RunScanPage> {
    validateScan(query);
    const throughId = query.throughId ?? (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_runs ORDER BY id DESC LIMIT 1')).rows[0]?.id;
    if (!throughId) return { runs: [], done: true };
    const result = await this.pool.query<{ state: AgentRun }>(
      'SELECT state FROM aeeis_runs WHERE id > $1 AND id <= $2 ORDER BY id ASC LIMIT $3',
      [query.afterId ?? '', throughId, query.limit]);
    return { runs: result.rows.map(row => row.state), throughId, done: result.rows.length < query.limit };
  }
  async scanEventsPage(query: RunScanQuery): Promise<RunEventScanPage> {
    validateScan(query);
    const throughId = query.throughId ?? (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_runs ORDER BY id DESC LIMIT 1')).rows[0]?.id;
    if (!throughId) return { runs: [], done: true };
    const result = await this.pool.query<{ id: string; owner: string; tenant_id: string; event_count: number; last_event_seq: number }>(
      `SELECT id,
              COALESCE(state->>'owner', 'owner') AS owner,
              COALESCE(state->>'tenantId', 'local') AS tenant_id,
              jsonb_array_length(COALESCE(state->'events', '[]'::jsonb)) AS event_count,
              COALESCE((state->'events'->-1->>'seq')::integer, 0) AS last_event_seq
         FROM aeeis_runs
        WHERE id > $1 AND id <= $2
        ORDER BY id ASC
        LIMIT $3`,
      [query.afterId ?? '', throughId, query.limit],
    );
    return {
      runs: result.rows.map(row => ({ id: row.id, owner: row.owner, tenantId: row.tenant_id, eventCount: Number(row.event_count), lastEventSeq: Number(row.last_event_seq) })),
      throughId,
      done: result.rows.length < query.limit,
    };
  }
  async scanRecoveryPage(query: RunScanQuery): Promise<RunRecoveryScanPage> {
    validateScan(query);
    const throughId = query.throughId ?? (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_runs ORDER BY id DESC LIMIT 1')).rows[0]?.id;
    if (!throughId) return { runs: [], done: true };
    const result = await this.pool.query<{ id: string; owner: string; tenant_id: string }>(
      `SELECT id,
              COALESCE(state->>'owner', 'owner') AS owner,
              COALESCE(state->>'tenantId', 'local') AS tenant_id
         FROM aeeis_runs
        WHERE id > $1 AND id <= $2
          AND (
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(state->'calls', '[]'::jsonb)) call WHERE call->>'state'='started')
            OR (state->'pendingTool' IS NOT NULL AND ((state->'pendingTool'->>'receiptId') IS NULL OR (state->'pendingTool'->>'executionToken') IS NOT NULL OR (state->'pendingTool'->>'reconcileInFlight')='true'))
            OR (state->'pendingDelegation' IS NOT NULL AND ((state->'pendingDelegation'->>'receiptRef') IS NULL OR (state->'pendingDelegation'->>'executionToken') IS NOT NULL OR (state->'pendingDelegation'->>'reconcileInFlight')='true'))
            OR state->'taskExecution' IS NOT NULL
            OR (state->>'goalId' IS NOT NULL AND state->>'domainPlanId' IS NOT NULL)
            OR (state->>'status'='succeeded' AND state->>'goalId' IS NOT NULL
                AND (state->>'builtinSkill'='project-pulse/1' OR state->>'projectSourceQuery' IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(state->'events', '[]'::jsonb)) pulse_event WHERE pulse_event->>'type'='project-pulse.next-actions.projected'))
          )
        ORDER BY id ASC
        LIMIT $3`,
      [query.afterId ?? '', throughId, query.limit],
    );
    return { runs: result.rows.map(row => ({ id: row.id, owner: row.owner, tenantId: row.tenant_id })), throughId, done: result.rows.length < query.limit };
  }
  async mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun> {
    validateId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT state FROM aeeis_runs WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new NotFound('Unknown run');
      const run = result.rows[0].state as AgentRun;
      if (scope && !isOwnedBy(run, scope)) throw new NotFound('Unknown run');
      const ownership = { owner: run.owner, tenantId: run.tenantId ?? 'local' };
      const eventCount = run.events.length;
      const eventIds = run.events.map(item => item.id);
      await change(run);
      if (!isOwnedBy(run, ownership)) throw new Error('Run ownership is immutable');
      if (run.events.length < eventCount || eventIds.some((id, index) => run.events[index]?.id !== id)) throw new Error('Run events are append-only');
      run.revision++; run.updatedAt = new Date().toISOString();
      await client.query('UPDATE aeeis_runs SET revision=$2, state=$3, updated_at=$4 WHERE id=$1', [id, run.revision, run, run.updatedAt]);
      await this.insertEvents(client, run, eventCount);
      await client.query('COMMIT');
      await this.notifyChange(client, run); return run;
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; const entries = [...this.changeSubscribers.entries()]; await Promise.all(entries.map(([handler, subscription]) => this.stopChangeSubscription(handler, subscription))); await this.pool.end(); }
}

interface PostgresChangeSubscription {
  handler: (change: RunChange) => void | Promise<void>;
  client: pg.PoolClient | undefined;
  listener: ((message: pg.Notification) => void) | undefined;
  errorListener: (() => void) | undefined;
  reconnectTimer: NodeJS.Timeout | undefined;
  reconnectAttempt: number;
  stopped: boolean;
}
