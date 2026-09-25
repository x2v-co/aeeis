import { scopedRecent, validateCollectionLimit } from './adapters/collection-query.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Ownership } from './security/principal.js';
import pg from 'pg';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryLockKeys } from './adapters/postgres-lock.js';
import { HttpDependencyProbe, type DependencyHealth } from './dependency-health.js';

const executeFile = promisify(execFileCallback);

function matchesScope(value: { owner?: string; tenantId?: string }, scope?: Ownership): boolean {
  return scope === undefined || (value.owner ?? 'owner') === scope.owner && (value.tenantId ?? 'local') === scope.tenantId;
}

const isoDate = z.string().datetime({ offset: true });
const projectionId = z.string().regex(/^projection_[a-f0-9-]{36}$/);
const aggregateId = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const projectionEventSchema = z.object({
  schemaVersion: z.literal(1), id: projectionId, owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'), idempotencyKey: z.string().min(1).max(500),
  channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500),
  aggregateType: z.enum(['room', 'debate', 'competition', 'evolution', 'goal', 'plan', 'task', 'run', 'reminder', 'session_event']), aggregateId, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(), status: z.enum(['pending', 'failed', 'unknown', 'delivered']), attempts: z.number().int().nonnegative(),
  createdAt: isoDate, updatedAt: isoDate, lastError: z.string().max(4000).optional(), deliveredAt: isoDate.optional(), externalId: z.string().max(500).optional(),
}).strict();
const stateSchema = z.object({ events: z.array(projectionEventSchema).max(10000) }).strict();
export type ProjectionEvent = z.infer<typeof projectionEventSchema>;
export interface ProjectionSink {
  deliver(event: ProjectionEvent): Promise<{ externalId?: string }>;
  /** Optional read-only provider probe. It must never deliver a projection. */
  health?(): Promise<DependencyHealth>;
}
export class ProjectionOutcomeUnknown extends Error {}
export class ProjectionNotFound extends Error {}

export interface ProjectionOutbox {
  init(): Promise<void>;
  enqueue(input: { channel: string; destination: string; aggregateType: ProjectionEvent['aggregateType']; aggregateId: string; payload: unknown; idempotencyKey: string; owner?: string; tenantId?: string }): Promise<ProjectionEvent>;
  get(id: string, scope?: Ownership): Promise<ProjectionEvent>;
  list(status?: ProjectionEvent['status'], scope?: Ownership, limit?: number): Promise<ProjectionEvent[]>;
  deliver(id: string, sink: ProjectionSink, scope?: Ownership): Promise<ProjectionEvent>;
  deliverPending(sink: ProjectionSink, limit?: number, scope?: Ownership): Promise<{ delivered: number; failed: number; events: ProjectionEvent[] }>;
  reconcile(id: string, outcome: 'completed' | 'failed', reason: string, externalId?: string, scope?: Ownership): Promise<ProjectionEvent>;
  close(): Promise<void>;
}

export class FileProjectionOutbox implements ProjectionOutbox {
  private readonly lockPath: string;
  private readonly statePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private state: z.infer<typeof stateSchema> | undefined;
  private readonly deliveries = new Map<string, Promise<ProjectionEvent>>();
  constructor(private readonly directory: string) { this.lockPath = join(directory, '.writer.lock'); this.statePath = join(directory, 'projections.json'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const lock = await open(this.lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Projection directory already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; await unlink(this.lockPath); return this.init(); }
    }
    try { this.state = stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.save({ events: [] }); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  private snapshot(): z.infer<typeof stateSchema> { if (!this.state) throw new Error('Repository is not open'); return this.state; }
  private async load(): Promise<z.infer<typeof stateSchema>> { return structuredClone(this.snapshot()); }
  private async save(state: z.infer<typeof stateSchema>): Promise<void> {
    const committed = structuredClone(stateSchema.parse(state));
    const temporary = `${this.statePath}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(committed)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.statePath); this.state = committed; const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async enqueue(input: { channel: string; destination: string; aggregateType: ProjectionEvent['aggregateType']; aggregateId: string; payload: unknown; idempotencyKey: string; owner?: string; tenantId?: string }): Promise<ProjectionEvent> {
    const payloadSize = JSON.stringify(input.payload).length;
    if (payloadSize > 200_000) throw new Error('Projection payload exceeds the 200KB limit');
    return this.serial(async () => {
      const state = await this.load();
      const snapshotHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
      const owner = input.owner ?? 'owner'; const tenantId = input.tenantId ?? 'local';
      const existing = state.events.find(event => event.idempotencyKey === input.idempotencyKey && event.channel === input.channel && event.owner === owner && event.tenantId === tenantId);
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      const event = projectionEventSchema.parse({ schemaVersion: 1, id: `projection_${randomUUID()}`, owner, tenantId, idempotencyKey: input.idempotencyKey, channel: input.channel, destination: input.destination, aggregateType: input.aggregateType, aggregateId: input.aggregateId, snapshotHash, payload: input.payload, status: 'pending', attempts: 0, createdAt: now, updatedAt: now });
      state.events.push(event); await this.save(state); return structuredClone(event);
    });
  }
  async get(id: string, scope?: Ownership): Promise<ProjectionEvent> { const item = (await this.load()).events.find(event => event.id === id); if (!item || !matchesScope(item, scope)) throw new ProjectionNotFound('Unknown projection event'); return structuredClone(item); }
  async list(status?: ProjectionEvent['status'], scope?: Ownership, limit?: number): Promise<ProjectionEvent[]> { validateCollectionLimit(limit); const items = this.snapshot().events.filter(event => matchesScope(event, scope) && (status === undefined || event.status === status)); return structuredClone(limit === undefined ? items : scopedRecent(items, item => item.updatedAt, scope, limit)); }
  async deliver(id: string, sink: ProjectionSink, scope?: Ownership): Promise<ProjectionEvent> {
    const active = this.deliveries.get(id);
    if (active) return active;
    const work = this.deliverOnce(id, sink, scope).finally(() => this.deliveries.delete(id));
    this.deliveries.set(id, work);
    return work;
  }
  private async deliverOnce(id: string, sink: ProjectionSink, scope?: Ownership): Promise<ProjectionEvent> {
    const current = await this.get(id, scope);
    if (current.status === 'delivered' || current.status === 'unknown') return current;
    await this.serial(async () => {
      const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) throw new ProjectionNotFound('Unknown projection event');
      const event = state.events[index]!; state.events[index] = { ...event, attempts: event.attempts + 1, updatedAt: new Date().toISOString(), lastError: undefined }; await this.save(state);
    });
    try {
      const result = await sink.deliver(await this.get(id, scope));
      return this.serial(async () => {
        const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) throw new ProjectionNotFound('Unknown projection event');
        const event = state.events[index]!; const deliveredAt = new Date().toISOString();
        state.events[index] = { ...event, status: 'delivered', updatedAt: deliveredAt, deliveredAt, ...(result.externalId ? { externalId: result.externalId } : {}), lastError: undefined }; await this.save(state); return structuredClone(state.events[index]!);
      });
    } catch (error) {
      await this.serial(async () => {
        const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) return;
        state.events[index] = { ...state.events[index]!, status: error instanceof ProjectionOutcomeUnknown ? 'unknown' : 'failed', updatedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : 'Projection delivery failed' }; await this.save(state);
      });
      throw error;
    }
  }
  async deliverPending(sink: ProjectionSink, limit = 20, scope?: Ownership): Promise<{ delivered: number; failed: number; events: ProjectionEvent[] }> {
    validateCollectionLimit(limit);
    const bounded = Math.min(limit, 100);
    const candidates = this.snapshot().events.filter(event => matchesScope(event, scope) && (event.status === 'pending' || event.status === 'failed')).slice(0, bounded).map(event => ({ id: event.id }));
    const events: ProjectionEvent[] = []; let failed = 0;
    for (const candidate of candidates) {
      try { events.push(await this.deliver(candidate.id, sink, scope)); }
      catch { failed += 1; events.push(await this.get(candidate.id, scope)); }
    }
    return { delivered: events.filter(event => event.status === 'delivered').length, failed, events };
  }
  async reconcile(id: string, outcome: 'completed' | 'failed', reason: string, externalId?: string, scope?: Ownership): Promise<ProjectionEvent> {
    if (!reason.trim()) throw new Error('Projection reconciliation reason is required');
    return this.serial(async () => {
      const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) throw new ProjectionNotFound('Unknown projection event');
      const event = state.events[index]!;
      if (!matchesScope(event, scope)) throw new ProjectionNotFound('Unknown projection event');
      if (event.status !== 'unknown') throw new Error(`Projection event is ${event.status}; only unknown events can be reconciled`);
      const at = new Date().toISOString();
      state.events[index] = { ...event, status: outcome === 'completed' ? 'delivered' : 'failed', updatedAt: at, ...(outcome === 'completed' ? { deliveredAt: at, ...(externalId ? { externalId } : {}) } : {}), lastError: outcome === 'failed' ? reason : undefined };
      await this.save(state); return structuredClone(state.events[index]!);
    });
  }
  async close(): Promise<void> { await this.queue; this.state = undefined; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

/** PostgreSQL projection outbox. The event JSON is canonical while indexed
 * columns support scoped listing and idempotent insertion. Delivery attempts
 * reserve one row under a lock before calling an external sink; an ambiguous
 * response is durable `unknown` and can only move through reconcile. */
export class PostgresProjectionOutbox implements ProjectionOutbox {
  private readonly pool: pg.Pool;
  private readonly deliveries = new Map<string, Promise<ProjectionEvent>>();
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'projection-events', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_projection_events (
          id text PRIMARY KEY, owner text NOT NULL DEFAULT 'owner', tenant_id text NOT NULL DEFAULT 'local',
          channel text NOT NULL, destination text NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL,
          idempotency_key text NOT NULL, status text NOT NULL, attempts integer NOT NULL DEFAULT 0,
          state jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
        );
        ALTER TABLE aeeis_projection_events ADD COLUMN IF NOT EXISTS owner text NOT NULL DEFAULT 'owner';
        ALTER TABLE aeeis_projection_events ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'local';
        CREATE UNIQUE INDEX IF NOT EXISTS aeeis_projection_idempotency_scope_idx ON aeeis_projection_events(channel, idempotency_key, owner, tenant_id);
        CREATE INDEX IF NOT EXISTS aeeis_projection_scope_status_idx ON aeeis_projection_events(owner, tenant_id, status, created_at, id);
        CREATE INDEX IF NOT EXISTS aeeis_projection_recent_idx ON aeeis_projection_events(owner, tenant_id, updated_at DESC, id);
        CREATE INDEX IF NOT EXISTS aeeis_projection_pending_idx ON aeeis_projection_events(created_at, id) WHERE status IN ('pending', 'failed');
      `);
      await client.query(`UPDATE aeeis_projection_events SET owner=COALESCE(NULLIF(state->>'owner',''), 'owner'), tenant_id=COALESCE(NULLIF(state->>'tenantId',''), 'local'), state=state || jsonb_build_object('owner', COALESCE(NULLIF(state->>'owner',''), 'owner'), 'tenantId', COALESCE(NULLIF(state->>'tenantId',''), 'local'))`);
    });
  }

  async enqueue(input: Parameters<ProjectionOutbox['enqueue']>[0]): Promise<ProjectionEvent> {
    if (JSON.stringify(input.payload).length > 200_000) throw new Error('Projection payload exceeds the 200KB limit');
    const owner = input.owner ?? 'owner'; const tenantId = input.tenantId ?? 'local';
    const snapshotHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
    const now = new Date().toISOString();
    const event = projectionEventSchema.parse({ schemaVersion: 1, id: `projection_${randomUUID()}`, owner, tenantId, idempotencyKey: input.idempotencyKey, channel: input.channel, destination: input.destination, aggregateType: input.aggregateType, aggregateId: input.aggregateId, snapshotHash, payload: input.payload, status: 'pending', attempts: 0, createdAt: now, updatedAt: now });
    const inserted = await this.pool.query<{ state: unknown }>('INSERT INTO aeeis_projection_events(id,owner,tenant_id,channel,destination,aggregate_type,aggregate_id,idempotency_key,status,attempts,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING state', [event.id, event.owner, event.tenantId, event.channel, event.destination, event.aggregateType, event.aggregateId, event.idempotencyKey, event.status, event.attempts, event, event.createdAt, event.updatedAt]);
    if (inserted.rows[0]) return projectionEventSchema.parse(inserted.rows[0].state);
    return this.getByIdempotency(event.channel, event.idempotencyKey, owner, tenantId);
  }

  async get(id: string, scope?: Ownership): Promise<ProjectionEvent> {
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_projection_events WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [id, scope.owner, scope.tenantId] : [id]);
    if (!result.rows[0]) throw new ProjectionNotFound('Unknown projection event');
    return projectionEventSchema.parse(result.rows[0].state);
  }

  async list(status?: ProjectionEvent['status'], scope?: Ownership, limit?: number): Promise<ProjectionEvent[]> {
    validateCollectionLimit(limit);
    const filters: string[] = []; const values: unknown[] = [];
    if (scope) { values.push(scope.owner, scope.tenantId); filters.push(`owner=$${values.length - 1} AND tenant_id=$${values.length}`); }
    if (status) { values.push(status); filters.push(`status=$${values.length}`); }
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_projection_events${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY ${limit === undefined ? 'created_at,id' : `updated_at DESC,id LIMIT $${values.length}`}`, values);
    return result.rows.map(row => projectionEventSchema.parse(row.state));
  }

  async deliver(id: string, sink: ProjectionSink, scope?: Ownership): Promise<ProjectionEvent> {
    const active = this.deliveries.get(id); if (active) return active;
    // The in-process map only protects callers sharing this instance. A
    // PostgreSQL-backed outbox can be drained by multiple AEEIS processes, so
    // hold a session advisory lock across the external call as well. The row
    // remains pending while the lease is held; if the process dies, the
    // connection closes, the lock is released, and recovery can safely retry.
    const work = this.withDeliveryLock(id, () => this.deliverOnce(id, sink, scope)).finally(() => this.deliveries.delete(id));
    this.deliveries.set(id, work); return work;
  }

  private async withDeliveryLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const [key1, key2] = postgresAdvisoryLockKeys('aeeis:projection-delivery', id);
    try {
      await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [key1, key2]);
      return await operation();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [key1, key2]); }
      finally { client.release(); }
    }
  }

  private async deliverOnce(id: string, sink: ProjectionSink, scope?: Ownership): Promise<ProjectionEvent> {
    const current = await this.get(id, scope);
    if (current.status === 'delivered' || current.status === 'unknown') return current;
    const reserved = await this.reserve(id, scope);
    if (reserved.status === 'delivered' || reserved.status === 'unknown') return reserved;
    try {
      const result = await sink.deliver(reserved);
      return this.finish(id, 'delivered', undefined, result.externalId, scope);
    } catch (error) {
      await this.finish(id, error instanceof ProjectionOutcomeUnknown ? 'unknown' : 'failed', error instanceof Error ? error.message : 'Projection delivery failed', undefined, scope);
      throw error;
    }
  }

  async deliverPending(sink: ProjectionSink, limit = 20, scope?: Ownership): Promise<{ delivered: number; failed: number; events: ProjectionEvent[] }> {
    validateCollectionLimit(limit);
    const bounded = Math.min(limit, 100);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    values.push(bounded);
    const candidates = (await this.pool.query<{ id: string }>(`SELECT id FROM aeeis_projection_events WHERE status IN ('pending', 'failed')${scope ? ' AND owner=$1 AND tenant_id=$2' : ''} ORDER BY created_at, id LIMIT $${values.length}`, values)).rows;
    const events: ProjectionEvent[] = []; let failed = 0;
    for (const candidate of candidates) { try { events.push(await this.deliver(candidate.id, sink, scope)); } catch { failed += 1; events.push(await this.get(candidate.id, scope)); } }
    return { delivered: events.filter(event => event.status === 'delivered').length, failed, events };
  }

  async reconcile(id: string, outcome: 'completed' | 'failed', reason: string, externalId?: string, scope?: Ownership): Promise<ProjectionEvent> {
    if (!reason.trim()) throw new Error('Projection reconciliation reason is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown; owner: string; tenant_id: string }>('SELECT state,owner,tenant_id FROM aeeis_projection_events WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row || (scope && (row.owner !== scope.owner || row.tenant_id !== scope.tenantId))) throw new ProjectionNotFound('Unknown projection event');
      const event = projectionEventSchema.parse(row.state);
      if (event.status !== 'unknown') throw new Error(`Projection event is ${event.status}; only unknown events can be reconciled`);
      const at = new Date().toISOString();
      const next = projectionEventSchema.parse({ ...event, status: outcome === 'completed' ? 'delivered' : 'failed', updatedAt: at, ...(outcome === 'completed' ? { deliveredAt: at, ...(externalId ? { externalId } : {}) } : { lastError: reason }) });
      await this.updateLocked(client, next);
      await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async reserve(id: string, scope?: Ownership): Promise<ProjectionEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown; owner: string; tenant_id: string }>('SELECT state,owner,tenant_id FROM aeeis_projection_events WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row || (scope && (row.owner !== scope.owner || row.tenant_id !== scope.tenantId))) throw new ProjectionNotFound('Unknown projection event');
      const event = projectionEventSchema.parse(row.state);
      if (event.status === 'delivered' || event.status === 'unknown') { await client.query('COMMIT'); return event; }
      const next = projectionEventSchema.parse({ ...event, attempts: event.attempts + 1, updatedAt: new Date().toISOString(), lastError: undefined });
      await this.updateLocked(client, next); await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async finish(id: string, status: ProjectionEvent['status'], lastError?: string, externalId?: string, scope?: Ownership): Promise<ProjectionEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: unknown; owner: string; tenant_id: string }>('SELECT state,owner,tenant_id FROM aeeis_projection_events WHERE id=$1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row || (scope && (row.owner !== scope.owner || row.tenant_id !== scope.tenantId))) throw new ProjectionNotFound('Unknown projection event');
      const event = projectionEventSchema.parse(row.state); const at = new Date().toISOString();
      const next = projectionEventSchema.parse({ ...event, status, updatedAt: at, ...(lastError ? { lastError } : { lastError: undefined }), ...(status === 'delivered' ? { deliveredAt: at, ...(externalId ? { externalId } : {}) } : {}) });
      await this.updateLocked(client, next); await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async updateLocked(client: pg.PoolClient, event: ProjectionEvent): Promise<void> {
    await client.query('UPDATE aeeis_projection_events SET state=$2,status=$3,attempts=$4,updated_at=$5 WHERE id=$1', [event.id, event, event.status, event.attempts, event.updatedAt]);
  }
  private async getByIdempotency(channel: string, idempotencyKey: string, owner: string, tenantId: string): Promise<ProjectionEvent> {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_projection_events WHERE channel=$1 AND idempotency_key=$2 AND owner=$3 AND tenant_id=$4', [channel, idempotencyKey, owner, tenantId]);
    if (!result.rows[0]) throw new ProjectionNotFound('Projection event disappeared after idempotent insert');
    return projectionEventSchema.parse(result.rows[0].state);
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export class HttpProjectionSink implements ProjectionSink {
  private readonly endpoint: string;
  private readonly probe: HttpDependencyProbe;
  constructor(endpoint: string, private readonly token?: string, private readonly timeoutMs = 30_000, healthEndpoint?: string) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Projection sink URL must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('Projection sink URL must not contain credentials or fragments');
    this.endpoint = url.toString();
    this.probe = new HttpDependencyProbe(this.endpoint, healthEndpoint, token, Math.min(timeoutMs, 3_000));
  }
  async health(): Promise<DependencyHealth> { return this.probe.health(); }
  async deliver(event: ProjectionEvent): Promise<{ externalId?: string }> {
    let response: Response;
    try { response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ schemaVersion: 'aeeis-projection-event/1', event }) }); }
    catch { throw new ProjectionOutcomeUnknown('Projection sink transport outcome is unknown; reconcile before sending again'); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new ProjectionOutcomeUnknown(`Projection sink returned HTTP ${response.status}; delivery outcome requires reconciliation`); }
    if (!response.ok) throw new Error(`Projection sink returned HTTP ${response.status}`);
    const body = z.object({ schemaVersion: z.literal('aeeis-projection-ack/1'), accepted: z.literal(true), externalId: z.string().max(500).optional() }).strict().parse(await response.json());
    return body.externalId === undefined ? {} : { externalId: body.externalId };
  }
}

/** Routes channel projections to independent delivery boundaries. A generic
 * sink may be supplied as a fallback for channels without a dedicated adapter;
 * it is still selected explicitly by the event channel and never changes the
 * canonical outbox semantics. */
export class RoutingProjectionSink implements ProjectionSink {
  private readonly sinks: ProjectionSink[];

  constructor(
    private readonly routes: Readonly<Record<string, ProjectionSink>>,
    private readonly fallback?: ProjectionSink,
  ) {
    this.sinks = [...new Set([...Object.values(routes), ...(fallback ? [fallback] : [])])];
    if (!this.sinks.length) throw new Error('At least one projection sink route is required');
  }

  private sinkFor(channel: string): ProjectionSink {
    const sink = this.routes[channel] ?? this.fallback;
    if (!sink) throw new Error(`No projection sink is configured for channel ${channel}`);
    return sink;
  }

  async deliver(event: ProjectionEvent): Promise<{ externalId?: string }> {
    return this.sinkFor(event.channel).deliver(event);
  }

  async health(): Promise<DependencyHealth> {
    const checkedAt = new Date().toISOString();
    const results = await Promise.all(this.sinks.map(async sink => {
      if (!sink.health) return { ready: false, detail: 'health probe unavailable' } satisfies DependencyHealth;
      try { return await sink.health(); }
      catch { return { ready: false, detail: 'health probe failed' } satisfies DependencyHealth; }
    }));
    return {
      ready: results.every(result => result.ready),
      detail: results.map((result, index) => `${this.sinkLabel(this.sinks[index]!)}: ${result.detail}`).join('; '),
      checkedAt,
    };
  }

  private sinkLabel(sink: ProjectionSink): string {
    for (const [channel, candidate] of Object.entries(this.routes)) if (candidate === sink) return channel;
    return 'fallback';
  }
}

/**
 * Hermes local CLI adapter. Hermes already exposes a side-effect-only
 * `hermes send --to TARGET --json MESSAGE` contract which reuses its configured
 * platform credentials. Keeping this boundary as a process adapter avoids
 * copying those credentials into AEEIS and leaves Hermes responsible for the
 * platform-specific delivery protocol.
 *
 * The CLI does not expose a provider message id for every platform. A
 * successful process therefore uses the AEEIS idempotency key as the stable
 * local receipt; transport/process failures remain unknown so the outbox never
 * silently duplicates an ambiguous external send.
 */
export class HermesCliProjectionSink implements ProjectionSink {
  constructor(
    private readonly executable = 'hermes',
    private readonly allowConfidential = false,
    private readonly timeoutMs = 30_000,
  ) {
    if (!executable.trim()) throw new Error('Hermes CLI executable is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 300_000) throw new Error('Hermes CLI timeout must be between 500 and 300000 milliseconds');
  }

  async health(): Promise<DependencyHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await executeFile(this.executable, ['send', '--list', '--json'], { timeout: Math.min(this.timeoutMs, 3_000), maxBuffer: 200_000, windowsHide: true });
      return { ready: true, detail: 'Hermes CLI is available; provider delivery is checked on send', checkedAt };
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : 'Hermes CLI probe failed';
      return { ready: false, detail: `Hermes CLI unavailable: ${detail}`, checkedAt };
    }
  }

  async deliver(event: ProjectionEvent): Promise<{ externalId?: string }> {
    if (event.channel !== 'hermes') throw new Error('Hermes CLI sink only accepts hermes projection events');
    const classification = projectionClassification(event.payload);
    if (classification === 'private' || (classification === 'confidential' && !this.allowConfidential)) throw new Error('Hermes projection refuses private or confidential context');
    const message = makeHermesMessage(event);
    let result: { stdout?: string; stderr?: string };
    try {
      result = await executeFile(this.executable, ['send', '--to', event.destination, '--json', message], {
        timeout: this.timeoutMs,
        maxBuffer: 500_000,
        windowsHide: true,
      });
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
      const code = typeof failure.code === 'number' ? failure.code : undefined;
      const detail = truncate(String(failure.stderr ?? failure.stdout ?? (error instanceof Error ? error.message : 'Hermes CLI delivery failed')), 500);
      // Hermes exit code 2 is a local usage/configuration rejection. Exit code
      // 1, process termination and missing executables leave the provider
      // outcome ambiguous and must be reconciled before any retry.
      if (code === 2 && !failure.killed && !failure.signal) throw new Error(`Hermes CLI rejected projection: ${detail}`);
      throw new ProjectionOutcomeUnknown(`Hermes CLI delivery outcome is unknown: ${detail}`);
    }
    const body = parseHermesCliResult(result.stdout ?? '');
    if (body.error) throw new Error(`Hermes rejected projection: ${truncate(body.error, 500)}`);
    if (body.success !== true) throw new ProjectionOutcomeUnknown('Hermes CLI returned no success receipt; reconcile before sending again');
    const externalId = typeof body.messageId === 'string' ? body.messageId : event.idempotencyKey;
    return { externalId };
  }
}

/**
 * Feishu incoming-webhook adapter. The webhook is a delivery boundary only:
 * AEEIS remains the source of truth and sends a compact status card without
 * forwarding Context Pack contents or raw candidate artifacts.
 */
export class FeishuWebhookProjectionSink implements ProjectionSink {
  private readonly endpoint: string;
  constructor(private readonly webhookUrl: string, private readonly allowConfidential = false, private readonly timeoutMs = 30_000) {
    const url = new URL(webhookUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Feishu webhook URL must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('Feishu webhook URL must not contain credentials or fragments');
    this.endpoint = url.toString();
  }
  async deliver(event: ProjectionEvent): Promise<{ externalId?: string }> {
    if (event.channel !== 'feishu') throw new Error('Feishu sink only accepts feishu projection events');
    const classification = projectionClassification(event.payload);
    if (classification === 'private' || (classification === 'confidential' && !this.allowConfidential)) throw new Error('Feishu projection refuses private or confidential context');
    const card = makeFeishuCard(event);
    let response: Response;
    try { response = await fetch(this.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', card, uuid: event.idempotencyKey.slice(0, 64) }),
    }); } catch { throw new ProjectionOutcomeUnknown('Feishu projection transport outcome is unknown; reconcile before sending again'); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new ProjectionOutcomeUnknown(`Feishu webhook returned HTTP ${response.status}; delivery outcome requires reconciliation`); }
    if (!response.ok) throw new Error(`Feishu webhook returned HTTP ${response.status}`);
    const body = z.object({ code: z.number().optional(), msg: z.string().optional(), StatusCode: z.number().optional(), StatusMessage: z.string().optional() }).passthrough().parse(await response.json());
    const code = body.code ?? body.StatusCode ?? 0;
    if (code !== 0) throw new Error(`Feishu webhook rejected projection: ${body.msg ?? body.StatusMessage ?? 'unknown error'}`);
    return { externalId: event.idempotencyKey };
  }
}

/**
 * Feishu application API adapter. Unlike the incoming webhook sink, this
 * adapter uses an app's tenant access token and sends to a chat_id. It keeps
 * the application credential and token lifecycle at the delivery boundary;
 * AEEIS remains the canonical source of projection state and never forwards
 * private Context Pack content.
 */
export class FeishuAppProjectionSink implements ProjectionSink {
  private readonly baseUrl: string;
  private token?: string;
  private tokenExpiresAt = 0;
  private tokenRequest: Promise<string> | undefined;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    baseUrl = 'https://open.feishu.cn',
    private readonly allowConfidential = false,
    private readonly allowedChatIds: ReadonlySet<string> = new Set(),
    private readonly timeoutMs = 30_000,
  ) {
    if (!appId.trim() || !appSecret.trim()) throw new Error('Feishu app credentials are required');
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Feishu API URL must use HTTPS except loopback');
    if (url.username || url.password || url.search || url.hash) throw new Error('Feishu API URL must not contain credentials, query or fragments');
    this.baseUrl = url.toString().replace(/\/$/, '');
  }

  async deliver(event: ProjectionEvent): Promise<{ externalId?: string }> {
    if (event.channel !== 'feishu') throw new Error('Feishu sink only accepts feishu projection events');
    if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(event.destination)) throw new Error('Feishu projection destination is not allowlisted');
    const classification = projectionClassification(event.payload);
    if (classification === 'private' || (classification === 'confidential' && !this.allowConfidential)) throw new Error('Feishu projection refuses private or confidential context');
    const token = await this.tenantAccessToken();
    const card = makeFeishuCard(event);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ receive_id: event.destination, msg_type: 'interactive', content: JSON.stringify(card), uuid: createHash('sha256').update(event.idempotencyKey).digest('hex') }),
      });
    } catch { throw new ProjectionOutcomeUnknown('Feishu application transport outcome is unknown; reconcile before sending again'); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new ProjectionOutcomeUnknown(`Feishu application returned HTTP ${response.status}; delivery outcome requires reconciliation`); }
    if (!response.ok) throw new Error(`Feishu application returned HTTP ${response.status}`);
    const body = z.object({ code: z.number().optional(), msg: z.string().optional(), data: z.object({ message_id: z.string().max(500).optional() }).passthrough().optional() }).passthrough().parse(await response.json());
    if ((body.code ?? 0) !== 0) throw new Error(`Feishu application rejected projection: ${body.msg ?? 'unknown error'}`);
    return { externalId: body.data?.message_id ?? event.idempotencyKey };
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenRequest) return this.tokenRequest;
    const request = this.fetchTenantAccessToken();
    let shared!: Promise<string>;
    shared = request.finally(() => { if (this.tokenRequest === shared) this.tokenRequest = undefined; });
    this.tokenRequest = shared;
    return shared;
  }

  private async fetchTenantAccessToken(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
    } catch { throw new ProjectionOutcomeUnknown('Feishu token transport outcome is unknown; reconcile before sending again'); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) { await response.body?.cancel(); throw new ProjectionOutcomeUnknown(`Feishu token endpoint returned HTTP ${response.status}; delivery outcome requires reconciliation`); }
    if (!response.ok) throw new Error(`Feishu token endpoint returned HTTP ${response.status}`);
    const body = z.object({ code: z.number().optional(), msg: z.string().optional(), tenant_access_token: z.string().min(1).max(10000).optional(), expire: z.number().int().positive().optional() }).passthrough().parse(await response.json());
    if ((body.code ?? 0) !== 0 || !body.tenant_access_token) throw new Error(`Feishu token request rejected: ${body.msg ?? 'missing tenant access token'}`);
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = Date.now() + Math.max(30, (body.expire ?? 3600) - 60) * 1000;
    return this.token;
  }
}

function projectionClassification(payload: unknown): 'public' | 'internal' | 'confidential' | 'private' | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.classification ?? record.privacy;
  if (direct === 'private') return 'private';
  if (direct === 'confidential') return 'confidential';
  const nested = record.room && typeof record.room === 'object' ? record.room as Record<string, unknown> : record.brief && typeof record.brief === 'object' ? record.brief as Record<string, unknown> : undefined;
  const context = nested?.context;
  const value = context && typeof context === 'object' ? (context as Record<string, unknown>).classification : undefined;
  if (value === 'public' || value === 'internal' || value === 'confidential' || value === 'private') return value;
  return direct === 'public' || direct === 'internal' ? direct : undefined;
}

function makeHermesMessage(event: ProjectionEvent): string {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const title = event.aggregateType === 'debate' ? 'AEEIS Debate 更新' : event.aggregateType === 'competition' ? 'AEEIS Competition 更新' : event.aggregateType === 'reminder' ? 'AEEIS 提醒' : event.aggregateType === 'session_event' ? 'AEEIS Shared Session 更新' : `AEEIS ${event.aggregateType} 更新`;
  const status = typeof payload.status === 'string' ? payload.status : 'updated';
  const lines = [title, `状态：${status}`, `对象：${event.aggregateId}`, `幂等键：${event.idempotencyKey}`];
  if (event.aggregateType === 'debate') {
    const room = payload.room && typeof payload.room === 'object' ? payload.room as Record<string, unknown> : {};
    if (typeof room.goal === 'string' && room.goal) lines.push(`目标：${truncate(room.goal, 500)}`);
    const messages = Array.isArray(room.messages) ? room.messages : [];
    lines.push(`消息：${messages.length} 条`);
    for (const message of messages.slice(-8)) {
      if (!message || typeof message !== 'object') continue;
      const item = message as Record<string, unknown>;
      lines.push(`- ${truncate(String(item.speakerAgentId ?? 'agent'), 80)} / ${String(item.type ?? 'message')}：${truncate(String(item.content ?? ''), 800)}`);
    }
  } else if (event.aggregateType === 'competition') {
    const brief = payload.brief && typeof payload.brief === 'object' ? payload.brief as Record<string, unknown> : {};
    if (typeof brief.goal === 'string' && brief.goal) lines.push(`目标：${truncate(brief.goal, 500)}`);
    lines.push(`候选：${Array.isArray(payload.candidates) ? payload.candidates.length : 0} 个`, `评分：${Array.isArray(payload.scores) ? payload.scores.length : 0} 个`);
    if (typeof payload.selectedAgentId === 'string') lines.push(`选定：${payload.selectedAgentId}`);
  } else if (event.aggregateType === 'reminder') {
    if (typeof payload.title === 'string') lines.push(`标题：${truncate(payload.title, 500)}`);
    if (typeof payload.message === 'string') lines.push(`内容：${truncate(payload.message, 1500)}`);
    if (typeof payload.dueAt === 'string') lines.push(`时间：${payload.dueAt}`);
  } else if (event.aggregateType === 'session_event') {
    if (typeof payload.type === 'string') lines.push(`类型：${payload.type}`);
    if (typeof payload.operation === 'string') lines.push(`操作：${payload.operation}${typeof payload.targetEventId === 'string' ? ` · 目标 ${payload.targetEventId}` : ''}`);
    if (typeof payload.actorId === 'string') lines.push(`发起者：${payload.actorId}`);
    if (typeof payload.content === 'string') lines.push(`内容：${truncate(payload.content, 1500)}`);
    if (Array.isArray(payload.evidenceRefs) && payload.evidenceRefs.length > 0) lines.push(`证据：${payload.evidenceRefs.length} 条`);
  } else {
    const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot as Record<string, unknown> : payload;
    if (typeof snapshot.title === 'string') lines.push(`标题：${truncate(snapshot.title, 500)}`);
    if (typeof snapshot.goal === 'string') lines.push(`目标：${truncate(snapshot.goal, 500)}`);
    if (Array.isArray(snapshot.nodes)) lines.push(`节点：${snapshot.nodes.length} 个`);
    if (typeof snapshot.taskId === 'string') lines.push(`任务：${snapshot.taskId}`);
  }
  return truncate(lines.join('\n'), 7_500);
}

function parseHermesCliResult(raw: string): { success?: boolean; error?: string; messageId?: string } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProjectionOutcomeUnknown('Hermes CLI returned invalid JSON; reconcile before sending again'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectionOutcomeUnknown('Hermes CLI returned an invalid receipt; reconcile before sending again');
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.success === 'boolean' ? { success: record.success } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(typeof record.message_id === 'string' ? { messageId: record.message_id } : typeof record.messageId === 'string' ? { messageId: record.messageId } : {}),
  };
}

function makeFeishuCard(event: ProjectionEvent): Record<string, unknown> {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const title = event.aggregateType === 'debate' ? 'AEEIS Debate 更新' : event.aggregateType === 'competition' ? 'AEEIS Competition 更新' : event.aggregateType === 'reminder' ? 'AEEIS 提醒' : event.aggregateType === 'session_event' ? 'AEEIS Shared Session 更新' : `AEEIS ${event.aggregateType} 更新`;
  const status = typeof payload.status === 'string' ? payload.status : 'updated';
  const lines = [`**${title}**`, `状态：${status}`, `对象：${event.aggregateId}`, `幂等键：${event.idempotencyKey}`];
  if (event.aggregateType === 'debate') {
    const room = payload.room && typeof payload.room === 'object' ? payload.room as Record<string, unknown> : {};
    if (typeof room.goal === 'string' && room.goal) lines.push(`目标：${truncate(room.goal, 500)}`);
    const messages = Array.isArray(room.messages) ? room.messages : [];
    lines.push(`消息：${messages.length} 条`);
    for (const message of messages.slice(-8)) {
      if (!message || typeof message !== 'object') continue;
      const item = message as Record<string, unknown>;
      lines.push(`- ${truncate(String(item.speakerAgentId ?? 'agent'), 80)} / ${String(item.type ?? 'message')}：${truncate(String(item.content ?? ''), 800)}`);
    }
  } else if (event.aggregateType === 'competition') {
    const brief = payload.brief && typeof payload.brief === 'object' ? payload.brief as Record<string, unknown> : {};
    if (typeof brief.goal === 'string' && brief.goal) lines.push(`目标：${truncate(brief.goal, 500)}`);
    lines.push(`候选：${Array.isArray(payload.candidates) ? payload.candidates.length : 0} 个`, `评分：${Array.isArray(payload.scores) ? payload.scores.length : 0} 个`);
    if (typeof payload.selectedAgentId === 'string') lines.push(`选定：${payload.selectedAgentId}`);
  } else if (event.aggregateType === 'reminder') {
    if (typeof payload.title === 'string') lines.push(`标题：${truncate(payload.title, 500)}`);
    if (typeof payload.message === 'string') lines.push(`内容：${truncate(payload.message, 1500)}`);
    if (typeof payload.dueAt === 'string') lines.push(`时间：${payload.dueAt}`);
  } else if (event.aggregateType === 'session_event') {
    if (typeof payload.type === 'string') lines.push(`类型：${payload.type}`);
    if (typeof payload.operation === 'string') lines.push(`操作：${payload.operation}${typeof payload.targetEventId === 'string' ? ` · 目标 ${payload.targetEventId}` : ''}`);
    if (typeof payload.actorId === 'string') lines.push(`发起者：${payload.actorId}`);
    if (typeof payload.content === 'string') lines.push(`内容：${truncate(payload.content, 1500)}`);
    if (Array.isArray(payload.evidenceRefs) && payload.evidenceRefs.length > 0) lines.push(`证据：${payload.evidenceRefs.length} 条`);
  } else {
    const snapshot = payload.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot as Record<string, unknown> : payload;
    if (typeof snapshot.title === 'string') lines.push(`标题：${truncate(snapshot.title, 500)}`);
    if (typeof snapshot.status === 'string') lines.push(`状态：${snapshot.status}`);
    if (typeof snapshot.goal === 'string') lines.push(`目标：${truncate(snapshot.goal, 500)}`);
    if (Array.isArray(snapshot.nodes)) lines.push(`节点：${snapshot.nodes.length} 个`);
    if (typeof snapshot.taskId === 'string') lines.push(`任务：${snapshot.taskId}`);
  }
  return { config: { wide_screen_mode: true }, header: { template: status === 'failed' ? 'red' : status === 'completed' || status === 'closed' ? 'green' : 'blue', title: { tag: 'plain_text', content: title } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }] };
}

function truncate(value: string, max: number): string { return value.length <= max ? value : value.slice(0, max - 1) + '…'; }
