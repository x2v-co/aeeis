import { mkdir, open, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { contextManifestBindingHash } from './context-manifest-binding.js';
import { digestProtocol } from './protocol.js';
import { contextAudienceSnapshotSchema, type ContextAudienceSnapshot } from './context-audience.js';
import type { ContextManifest, Id } from './contracts.js';
import type { AeeisService } from './application/aeeis-service.js';
import { AeeisConflict, AeeisNotFound } from './application/aeeis-service.js';
import { principalAudience } from './security/principal.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const isoDate = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const sessionEventTypeSchema = z.enum(['message', 'canonical_response', 'decision', 'task_update', 'system']);
export type SessionEventType = z.infer<typeof sessionEventTypeSchema>;
export const sessionEventActorTypeSchema = z.enum(['principal', 'agent', 'system']);
export type SessionEventActorType = z.infer<typeof sessionEventActorTypeSchema>;
export const sessionEventClassificationSchema = z.enum(['public', 'internal', 'confidential', 'private']);
export type SessionEventClassification = z.infer<typeof sessionEventClassificationSchema>;
export const sessionEventOperationSchema = z.enum(['publish', 'revise', 'retract']);
export type SessionEventOperation = z.infer<typeof sessionEventOperationSchema>;

export const sessionEventSchema = z.object({
  schemaVersion: z.literal('session-event/1'),
  id,
  roomId: id,
  goalId: id.optional(),
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  sequence: z.number().int().positive(),
  type: sessionEventTypeSchema,
  actorId: z.string().min(1).max(200),
  actorType: sessionEventActorTypeSchema,
  operation: sessionEventOperationSchema.default('publish'),
  targetEventId: id.optional(),
  revision: z.number().int().positive().default(1),
  retractionReason: z.string().trim().min(1).max(4000).optional(),
  classification: sessionEventClassificationSchema.default('internal'),
  contextManifestId: id,
  contextManifestHash: hash,
  audienceSnapshot: contextAudienceSnapshotSchema,
  content: z.string().trim().min(1).max(20_000),
  contentHash: hash,
  evidenceRefs: z.array(id).max(200),
  idempotencyKey: z.string().trim().min(1).max(500),
  createdAt: isoDate,
}).strict().superRefine((event, ctx) => {
  if (event.operation === 'publish' && (event.targetEventId !== undefined || event.revision !== 1 || event.retractionReason !== undefined)) ctx.addIssue({ code: 'custom', message: 'Published event cannot carry revision metadata' });
  if (event.operation === 'revise' && (!event.targetEventId || event.revision < 2 || event.retractionReason !== undefined)) ctx.addIssue({ code: 'custom', message: 'Revision requires a target and revision number' });
  if (event.operation === 'retract' && (!event.targetEventId || !event.retractionReason)) ctx.addIssue({ code: 'custom', message: 'Retraction requires a target and reason' });
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export interface SessionEventDraft {
  roomId: Id;
  goalId?: Id;
  owner: string;
  tenantId: string;
  type: SessionEventType;
  actorId: string;
  actorType: SessionEventActorType;
  operation?: SessionEventOperation;
  targetEventId?: Id;
  revision?: number;
  retractionReason?: string;
  classification?: SessionEventClassification;
  contextManifestId: Id;
  contextManifestHash: string;
  audienceSnapshot: ContextAudienceSnapshot;
  content: string;
  contentHash: string;
  evidenceRefs: Id[];
  idempotencyKey: string;
  createdAt: string;
}

export interface SessionEventPage { items: SessionEvent[]; nextCursor?: string }
export interface SessionEventScope { tenantId: string; owner?: string }
export interface SessionEventRepository {
  init?(): Promise<void>;
  append(draft: SessionEventDraft): Promise<SessionEvent>;
  /** Append a revision/retraction while atomically asserting that the target
   * still has no child event. Durable repositories must perform this check in
   * the same serialization boundary as sequence allocation. */
  appendLinear?(draft: SessionEventDraft, targetEventId: Id, expectedTargetRevision: number): Promise<SessionEvent>;
  get(id: Id, scope?: SessionEventScope): Promise<SessionEvent | undefined>;
  page(roomId: Id, scope: SessionEventScope | undefined, limit: number, afterSequence?: number): Promise<SessionEventPage>;
  findByTarget?(roomId: Id, targetEventId: Id, scope?: SessionEventScope): Promise<SessionEvent[]>;
  close(): Promise<void>;
}

export class SessionEventConflict extends Error {}

/** In-memory repository used by protocol tests and embedded deployments. */
export class InMemorySessionEventRepository implements SessionEventRepository {
  private readonly events: SessionEvent[] = [];

  async append(input: SessionEventDraft): Promise<SessionEvent> {
    const existing = this.events.find(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId && event.idempotencyKey === input.idempotencyKey);
    if (existing) return sameDraft(existing, input);
    const event = sessionEventSchema.parse({ schemaVersion: 'session-event/1', id: `session_event_${this.events.length + 1}_${Date.now()}`, sequence: this.events.filter(item => item.roomId === input.roomId && item.owner === input.owner && item.tenantId === input.tenantId).length + 1, ...input });
    this.events.push(structuredClone(event));
    return structuredClone(event);
  }
  async appendLinear(input: SessionEventDraft, targetEventId: Id, expectedTargetRevision: number): Promise<SessionEvent> {
    const existing = this.events.find(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId && event.idempotencyKey === input.idempotencyKey);
    if (existing) return sameDraft(existing, input);
    const target = this.events.find(event => event.id === targetEventId && event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId);
    if (!target) throw new SessionEventConflict('Unknown session event revision target');
    if (target.revision !== expectedTargetRevision) throw new SessionEventConflict('Session event target revision is stale');
    if (this.events.some(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId && event.targetEventId === targetEventId)) throw new SessionEventConflict('Only the latest canonical response revision can be changed');
    const count = this.events.filter(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId).length;
    const event = sessionEventSchema.parse({ schemaVersion: 'session-event/1', id: `session_event_${this.events.length + 1}_${Date.now()}`, sequence: count + 1, ...input });
    this.events.push(structuredClone(event));
    return structuredClone(event);
  }
  async get(eventId: Id, scope?: SessionEventScope): Promise<SessionEvent | undefined> {
    const event = this.events.find(item => item.id === eventId && matchesScope(item, scope));
    return event ? structuredClone(event) : undefined;
  }
  async page(roomId: Id, scope: SessionEventScope | undefined, limit: number, afterSequence = 0): Promise<SessionEventPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Session event page limit must be between 1 and 200');
    const items = this.events.filter(event => event.roomId === roomId && matchesScope(event, scope) && event.sequence > afterSequence).sort((a, b) => a.sequence - b.sequence);
    const visible = items.slice(0, limit);
    return { items: structuredClone(visible), ...(items.length > limit && visible.length ? { nextCursor: String(visible.at(-1)!.sequence) } : {}) };
  }
  async findByTarget(roomId: Id, targetEventId: Id, scope?: SessionEventScope): Promise<SessionEvent[]> { return structuredClone(this.events.filter(event => event.roomId === roomId && event.targetEventId === targetEventId && matchesScope(event, scope))); }
  async close(): Promise<void> {}
}

/** Durable single-writer JSON repository. Events are append-only facts. */
export class JsonSessionEventRepository implements SessionEventRepository {
  private events: SessionEvent[] = [];
  private loaded = false;
  private lock: FileHandle | undefined = undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { this.lock = await open(`${this.filePath}.lock`, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error('Session event store already has a live writer');
    }
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as { events?: unknown }).events) ? (parsed as { events: unknown[] }).events : undefined;
      if (!values) throw new Error('session event file must be an array or an object with events');
      this.events = values.map(value => sessionEventSchema.parse(value));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
    }
    this.loaded = true;
  }

  async append(input: SessionEventDraft): Promise<SessionEvent> {
    return this.serial(async () => {
      this.assertOpen();
      const existing = this.events.find(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId && event.idempotencyKey === input.idempotencyKey);
      if (existing) return sameDraft(existing, input);
      const count = this.events.filter(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId).length;
      const event = sessionEventSchema.parse({ schemaVersion: 'session-event/1', id: `session_event_${cryptoRandomId()}`, sequence: count + 1, ...input });
      await this.persist([...this.events, event]);
      return structuredClone(event);
    });
  }
  async appendLinear(input: SessionEventDraft, targetEventId: Id, expectedTargetRevision: number): Promise<SessionEvent> {
    return this.serial(async () => {
      this.assertOpen();
      const existing = this.events.find(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId && event.idempotencyKey === input.idempotencyKey);
      if (existing) return sameDraft(existing, input);
      const target = this.events.find(event => event.id === targetEventId && event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId);
      if (!target) throw new SessionEventConflict('Unknown session event revision target');
      if (target.revision !== expectedTargetRevision) throw new SessionEventConflict('Session event target revision is stale');
      if (this.events.some(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId && event.targetEventId === targetEventId)) throw new SessionEventConflict('Only the latest canonical response revision can be changed');
      const count = this.events.filter(event => event.roomId === input.roomId && event.owner === input.owner && event.tenantId === input.tenantId).length;
      const event = sessionEventSchema.parse({ schemaVersion: 'session-event/1', id: `session_event_${cryptoRandomId()}`, sequence: count + 1, ...input });
      await this.persist([...this.events, event]);
      return structuredClone(event);
    });
  }
  async get(eventId: Id, scope?: SessionEventScope): Promise<SessionEvent | undefined> { this.assertOpen(); const event = this.events.find(item => item.id === eventId && matchesScope(item, scope)); return event ? structuredClone(event) : undefined; }
  async page(roomId: Id, scope: SessionEventScope | undefined, limit: number, afterSequence = 0): Promise<SessionEventPage> {
    this.assertOpen();
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Session event page limit must be between 1 and 200');
    const items = this.events.filter(event => event.roomId === roomId && matchesScope(event, scope) && event.sequence > afterSequence).sort((a, b) => a.sequence - b.sequence);
    const visible = items.slice(0, limit);
    return { items: structuredClone(visible), ...(items.length > limit && visible.length ? { nextCursor: String(visible.at(-1)!.sequence) } : {}) };
  }
  async findByTarget(roomId: Id, targetEventId: Id, scope?: SessionEventScope): Promise<SessionEvent[]> { this.assertOpen(); return structuredClone(this.events.filter(event => event.roomId === roomId && event.targetEventId === targetEventId && matchesScope(event, scope))); }
  async close(): Promise<void> { this.loaded = false; await this.lock?.close().catch(() => undefined); this.lock = undefined; try { await unlink(`${this.filePath}.lock`); } catch {} }

  private assertOpen(): void { if (!this.loaded || !this.lock) throw new Error('Session event store is not open'); }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const previous = this.queue; let release!: () => void; this.queue = new Promise(resolve => { release = resolve; }); await previous; try { return await operation(); } finally { release(); } }
  private async persist(events: SessionEvent[]): Promise<void> {
    const tempPath = `${this.filePath}.${cryptoRandomId()}.tmp`;
    const file = await open(tempPath, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify({ events }, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(tempPath, this.filePath);
    this.events = events;
  }
}

/** PostgreSQL repository. A transaction-local advisory lock serializes the
 * sequence allocation for one room/owner/tenant without a hot global lock. */
export class PostgresSessionEventRepository implements SessionEventRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS aeeis_session_events (id text PRIMARY KEY, room_id text NOT NULL, goal_id text, owner text NOT NULL, tenant_id text NOT NULL, sequence integer NOT NULL, idempotency_key text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL, UNIQUE(room_id, owner, tenant_id, idempotency_key), UNIQUE(room_id, owner, tenant_id, sequence)); ALTER TABLE aeeis_session_events ALTER COLUMN goal_id DROP NOT NULL; CREATE INDEX IF NOT EXISTS aeeis_session_events_room_idx ON aeeis_session_events(room_id, owner, tenant_id, sequence)`);
  }
  async append(input: SessionEventDraft): Promise<SessionEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.tenantId}:${input.owner}:${input.roomId}`]);
      const existing = await client.query<{ state: SessionEvent }>('SELECT state FROM aeeis_session_events WHERE room_id=$1 AND owner=$2 AND tenant_id=$3 AND idempotency_key=$4', [input.roomId, input.owner, input.tenantId, input.idempotencyKey]);
      if (existing.rows[0]) { await client.query('COMMIT'); return sameDraft(existing.rows[0].state, input); }
      const count = await client.query<{ max: number | null }>('SELECT max(sequence)::int AS max FROM aeeis_session_events WHERE room_id=$1 AND owner=$2 AND tenant_id=$3', [input.roomId, input.owner, input.tenantId]);
      const event = sessionEventSchema.parse({ schemaVersion: 'session-event/1', id: `session_event_${cryptoRandomId()}`, sequence: (count.rows[0]?.max ?? 0) + 1, ...input });
      await client.query('INSERT INTO aeeis_session_events(id,room_id,goal_id,owner,tenant_id,sequence,idempotency_key,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [event.id, event.roomId, event.goalId ?? null, event.owner, event.tenantId, event.sequence, event.idempotencyKey, event, event.createdAt]);
      await client.query('COMMIT');
      return event;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async appendLinear(input: SessionEventDraft, targetEventId: Id, expectedTargetRevision: number): Promise<SessionEvent> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.tenantId}:${input.owner}:${input.roomId}`]);
      const existing = await client.query<{ state: SessionEvent }>('SELECT state FROM aeeis_session_events WHERE room_id=$1 AND owner=$2 AND tenant_id=$3 AND idempotency_key=$4', [input.roomId, input.owner, input.tenantId, input.idempotencyKey]);
      if (existing.rows[0]) { await client.query('COMMIT'); return sameDraft(existing.rows[0].state, input); }
      const target = await client.query<{ state: SessionEvent }>('SELECT state FROM aeeis_session_events WHERE id=$1 AND room_id=$2 AND owner=$3 AND tenant_id=$4 FOR UPDATE', [targetEventId, input.roomId, input.owner, input.tenantId]);
      if (!target.rows[0]) throw new SessionEventConflict('Unknown session event revision target');
      if (target.rows[0].state.revision !== expectedTargetRevision) throw new SessionEventConflict('Session event target revision is stale');
      const child = await client.query('SELECT 1 FROM aeeis_session_events WHERE room_id=$1 AND owner=$2 AND tenant_id=$3 AND state->>\'targetEventId\'=$4 LIMIT 1', [input.roomId, input.owner, input.tenantId, targetEventId]);
      if (child.rows[0]) throw new SessionEventConflict('Only the latest canonical response revision can be changed');
      const count = await client.query<{ max: number | null }>('SELECT max(sequence)::int AS max FROM aeeis_session_events WHERE room_id=$1 AND owner=$2 AND tenant_id=$3', [input.roomId, input.owner, input.tenantId]);
      const event = sessionEventSchema.parse({ schemaVersion: 'session-event/1', id: `session_event_${cryptoRandomId()}`, sequence: (count.rows[0]?.max ?? 0) + 1, ...input });
      await client.query('INSERT INTO aeeis_session_events(id,room_id,goal_id,owner,tenant_id,sequence,idempotency_key,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [event.id, event.roomId, event.goalId ?? null, event.owner, event.tenantId, event.sequence, event.idempotencyKey, event, event.createdAt]);
      await client.query('COMMIT');
      return event;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); }
  }
  async get(eventId: Id, scope?: SessionEventScope): Promise<SessionEvent | undefined> {
    const result = await this.pool.query<{ state: SessionEvent }>('SELECT state FROM aeeis_session_events WHERE id=$1', [eventId]);
    const event = result.rows[0]?.state;
    return event && matchesScope(event, scope) ? event : undefined;
  }
  async page(roomId: Id, scope: SessionEventScope | undefined, limit: number, afterSequence = 0): Promise<SessionEventPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Session event page limit must be between 1 and 200');
    const params: unknown[] = [roomId, afterSequence, limit + 1];
    let query = 'SELECT state FROM aeeis_session_events WHERE room_id=$1 AND sequence>$2';
    if (scope) { params.push(scope.tenantId); query += ` AND tenant_id=$${params.length}`; if (scope.owner) { params.push(scope.owner); query += ` AND owner=$${params.length}`; } }
    query += ` ORDER BY sequence ASC LIMIT $3`;
    const result = await this.pool.query<{ state: SessionEvent }>(query, params);
    const rows = result.rows.map(row => row.state);
    const visible = rows.slice(0, limit);
    return { items: visible, ...(rows.length > limit && visible.length ? { nextCursor: String(visible.at(-1)!.sequence) } : {}) };
  }
  async findByTarget(roomId: Id, targetEventId: Id, scope?: SessionEventScope): Promise<SessionEvent[]> {
    const params: unknown[] = [roomId, targetEventId]; let query = `SELECT state FROM aeeis_session_events WHERE room_id=$1 AND state->>'targetEventId'=$2`;
    if (scope) { params.push(scope.tenantId); query += ` AND tenant_id=$${params.length}`; if (scope.owner) { params.push(scope.owner); query += ` AND owner=$${params.length}`; } }
    query += ' ORDER BY sequence ASC'; const result = await this.pool.query<{ state: SessionEvent }>(query, params); return result.rows.map(row => row.state);
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export interface CreateSessionEventInput {
  goalId?: Id;
  type: SessionEventType;
  content: string;
  contextManifestId: Id;
  evidenceRefs?: Id[];
  idempotencyKey: string;
}

export interface ReviseSessionEventInput {
  content: string;
  evidenceRefs?: Id[];
  idempotencyKey: string;
}

/** Domain service for canonical Shared Session events. A Room is the current
 * product representation of a Shared Session; the event repository remains a
 * separate append-only fact source so Debate/Projection transports cannot
 * become the canonical response. */
export class SessionEventService {
  constructor(private readonly repository: SessionEventRepository, private readonly domain: AeeisService) {}

  async create(roomId: Id, input: CreateSessionEventInput, actorId: string, tenantId: string, actorType: SessionEventActorType = 'principal'): Promise<SessionEvent> {
    const room = await this.domain.assertRoomEventWriter(roomId, actorId, tenantId);
    const manifest = await this.resolveManifest(room.id, input.goalId, input.contextManifestId, actorId, tenantId);
    if (!manifest.audienceSnapshot || !manifest.audience.includes(audienceFor(actorId, tenantId))) throw new AeeisNotFound('Context manifest is not shared with this actor');
    const snapshot = contextAudienceSnapshotSchema.parse(manifest.audienceSnapshot);
    const content = input.content.trim();
    if (!content) throw new AeeisConflict('Session event content is required');
    const evidenceRefs = [...new Set(input.evidenceRefs ?? [])];
    const contextManifestHash = contextManifestBindingHash(manifest);
    const contentHash = digestProtocol({ type: input.type, content, evidenceRefs, contextManifestId: manifest.id, contextManifestHash, audienceDigest: snapshot.digest });
    return this.repository.append({ roomId, ...(input.goalId === undefined ? {} : { goalId: input.goalId }), owner: room.owner ?? 'owner', tenantId, type: input.type, actorId, actorType, operation: 'publish', revision: 1, classification: manifestClassification(manifest), contextManifestId: manifest.id, contextManifestHash, audienceSnapshot: snapshot, content, contentHash, evidenceRefs, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString() });
  }

  async revise(roomId: Id, eventId: Id, input: ReviseSessionEventInput, actorId: string, tenantId: string, actorType: SessionEventActorType = 'principal'): Promise<SessionEvent> {
    const room = await this.domain.assertRoomEventWriter(roomId, actorId, tenantId);
    const target = await this.get(eventId, actorId, tenantId);
    if (target.roomId !== room.id) throw new AeeisNotFound(`Unknown session event: ${eventId}`);
    if (target.type !== 'canonical_response' || target.operation === 'retract') throw new AeeisConflict('Only an active canonical response can be revised');
    if (!this.repository.appendLinear && this.repository.findByTarget) {
      const children = await this.repository.findByTarget(room.id, target.id, { tenantId });
      if (children.length > 0) throw new AeeisConflict('Only the latest canonical response revision can be revised');
    }
    const manifest = await this.resolveManifest(room.id, target.goalId, target.contextManifestId, actorId, tenantId);
    const snapshot = contextAudienceSnapshotSchema.parse(manifest.audienceSnapshot);
    const content = input.content.trim();
    if (!content) throw new AeeisConflict('Session event content is required');
    const evidenceRefs = [...new Set(input.evidenceRefs ?? target.evidenceRefs)];
    const contextManifestHash = contextManifestBindingHash(manifest);
    const revision = target.revision + 1;
    const contentHash = digestProtocol({ type: target.type, operation: 'revise', targetEventId: target.id, revision, content, evidenceRefs, contextManifestId: manifest.id, contextManifestHash, audienceDigest: snapshot.digest });
    const draft = { roomId, ...(target.goalId === undefined ? {} : { goalId: target.goalId }), owner: room.owner ?? 'owner', tenantId, type: target.type, actorId, actorType, operation: 'revise' as const, targetEventId: target.id, revision, classification: manifestClassification(manifest), contextManifestId: manifest.id, contextManifestHash, audienceSnapshot: snapshot, content, contentHash, evidenceRefs, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString() };
    return this.repository.appendLinear ? this.repository.appendLinear(draft, target.id, target.revision) : this.repository.append(draft);
  }

  async retract(roomId: Id, eventId: Id, reason: string, idempotencyKey: string, actorId: string, tenantId: string, actorType: SessionEventActorType = 'principal'): Promise<SessionEvent> {
    const room = await this.domain.assertRoomEventWriter(roomId, actorId, tenantId);
    const target = await this.get(eventId, actorId, tenantId);
    if (target.roomId !== room.id) throw new AeeisNotFound(`Unknown session event: ${eventId}`);
    if (target.operation === 'retract') throw new AeeisConflict('A retraction cannot be retracted');
    if (target.type !== 'canonical_response') throw new AeeisConflict('Only an active canonical response can be retracted');
    if (!this.repository.appendLinear && this.repository.findByTarget) {
      const children = await this.repository.findByTarget(room.id, target.id, { tenantId });
      if (children.length > 0) throw new AeeisConflict('Only the latest canonical response revision can be retracted');
    }
    if (!reason.trim()) throw new AeeisConflict('Session event retraction reason is required');
    const manifest = await this.resolveManifest(room.id, target.goalId, target.contextManifestId, actorId, tenantId);
    const snapshot = contextAudienceSnapshotSchema.parse(manifest.audienceSnapshot);
    const contextManifestHash = contextManifestBindingHash(manifest);
    const content = `Retracted: ${reason.trim()}`;
    const contentHash = digestProtocol({ type: target.type, operation: 'retract', targetEventId: target.id, content, contextManifestId: manifest.id, contextManifestHash, audienceDigest: snapshot.digest });
    const draft = { roomId, ...(target.goalId === undefined ? {} : { goalId: target.goalId }), owner: room.owner ?? 'owner', tenantId, type: target.type, actorId, actorType, operation: 'retract' as const, targetEventId: target.id, revision: target.revision, retractionReason: reason.trim(), classification: manifestClassification(manifest), contextManifestId: manifest.id, contextManifestHash, audienceSnapshot: snapshot, content, contentHash, evidenceRefs: target.evidenceRefs, idempotencyKey, createdAt: new Date().toISOString() };
    return this.repository.appendLinear ? this.repository.appendLinear(draft, target.id, target.revision) : this.repository.append(draft);
  }

  async page(roomId: Id, actorId: string, tenantId: string, limit = 50, afterSequence = 0): Promise<SessionEventPage> {
    await this.domain.getRoomForPrincipal(roomId, actorId, tenantId);
    const page = await this.repository.page(roomId, { tenantId }, limit, afterSequence);
    const visible: SessionEvent[] = [];
    for (const event of page.items) {
      try {
        const manifest = await this.resolveManifest(event.roomId, event.goalId, event.contextManifestId, actorId, tenantId);
        if (contextManifestBindingHash(manifest) !== event.contextManifestHash || manifest.audienceSnapshot?.digest !== event.audienceSnapshot.digest) continue;
        await this.assertRelation(event, actorId, tenantId);
        visible.push(event);
      } catch (error) {
        if (!(error instanceof AeeisNotFound || error instanceof AeeisConflict)) throw error;
      }
    }
    return { items: visible, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async get(eventId: Id, actorId: string, tenantId: string): Promise<SessionEvent> {
    const event = await this.repository.get(eventId);
    if (!event || event.tenantId !== tenantId) throw new AeeisNotFound(`Unknown session event: ${eventId}`);
    await this.domain.getRoomForPrincipal(event.roomId, actorId, tenantId);
    const manifest = await this.resolveManifest(event.roomId, event.goalId, event.contextManifestId, actorId, tenantId);
    if (contextManifestBindingHash(manifest) !== event.contextManifestHash || manifest.audienceSnapshot?.digest !== event.audienceSnapshot.digest) throw new AeeisNotFound(`Unknown session event: ${eventId}`);
    await this.assertRelation(event, actorId, tenantId);
    return event;
  }
  private async assertRelation(event: SessionEvent, actorId: string, tenantId: string): Promise<void> {
    if (!event.targetEventId) return;
    const target = await this.repository.get(event.targetEventId);
    if (!target || target.roomId !== event.roomId || target.owner !== event.owner || target.tenantId !== event.tenantId || target.type !== event.type || target.operation === 'retract') throw new AeeisNotFound(`Unknown target session event: ${event.targetEventId}`);
    if (target.goalId !== event.goalId || target.contextManifestId !== event.contextManifestId) throw new AeeisNotFound(`Unknown target session event: ${event.targetEventId}`);
    const targetManifest = await this.resolveManifest(target.roomId, target.goalId, target.contextManifestId, actorId, tenantId);
    if (contextManifestBindingHash(targetManifest) !== target.contextManifestHash) throw new AeeisNotFound(`Unknown target session event: ${event.targetEventId}`);
  }
  private async resolveManifest(roomId: Id, goalId: Id | undefined, manifestId: Id, actorId: string, tenantId: string): Promise<ContextManifest> {
    if (goalId !== undefined) {
      const goal = await this.domain.getGoal(goalId, actorId, tenantId);
      if (goal.roomId !== roomId) throw new AeeisNotFound(`Unknown goal for Room: ${goalId}`);
      return this.domain.getContextManifest(goalId, manifestId, actorId, tenantId);
    }
    return this.domain.getSessionContextManifest(roomId, manifestId, actorId, tenantId);
  }

}

function matchesScope(event: { owner: string; tenantId: string }, scope?: SessionEventScope): boolean { return !scope || (event.tenantId === scope.tenantId && (scope.owner === undefined || event.owner === scope.owner)); }
function sameDraft(existing: SessionEvent, input: SessionEventDraft): SessionEvent {
  if (existing.roomId !== input.roomId || existing.goalId !== input.goalId || existing.owner !== input.owner || existing.tenantId !== input.tenantId || existing.type !== input.type || existing.actorId !== input.actorId || existing.operation !== (input.operation ?? 'publish') || existing.targetEventId !== input.targetEventId || existing.revision !== (input.revision ?? 1) || existing.retractionReason !== input.retractionReason || existing.contextManifestId !== input.contextManifestId || existing.contextManifestHash !== input.contextManifestHash || existing.contentHash !== input.contentHash || existing.idempotencyKey !== input.idempotencyKey) throw new SessionEventConflict('Session event idempotency key is bound to different content');
  return structuredClone(existing);
}
function audienceFor(principalId: string, tenantId: string): string { return principalAudience({ id: principalId, tenantId }); }
function manifestClassification(manifest: ContextManifest): SessionEventClassification {
  const values = [
    ...manifest.included.map(item => item.classification),
    ...(manifest.includedKnowledge ?? []).map(item => item.classification),
  ];
  if (values.length === 0) return 'internal';
  if (values.includes('private')) return 'private';
  if (values.includes('confidential')) return 'confidential';
  if (values.includes('internal')) return 'internal';
  return 'public';
}
function cryptoRandomId(): string { return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`; }
