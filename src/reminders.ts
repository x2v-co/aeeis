import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import pg from 'pg';
import { reminderRecurrenceSchema, nextCalendarOccurrence, nextReminderOccurrence, type ReminderRecurrence } from './reminder-schedule.js';
import type { ProjectionAggregateType } from './contracts.js';
import type { Ownership } from './security/principal.js';
import { afterCollectionCursor, decodeCollectionCursor, encodeCollectionCursor, recentFirst, validateCollectionLimit } from './adapters/collection-query.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';

const identity = z.string().trim().min(1).max(200);
const reminderId = z.string().regex(/^reminder_[a-f0-9-]{36}$/);
const isoDate = z.string().datetime({ offset: true });
const classification = z.enum(['public', 'internal', 'confidential', 'private']);
const deliverySchema = z.object({ channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500) }).strict();
export { reminderRecurrenceSchema, type ReminderRecurrence } from './reminder-schedule.js';

export const reminderSchema = z.object({
  schemaVersion: z.literal('reminder/1'), id: reminderId, owner: identity, tenantId: identity,
  title: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(8000),
  dueAt: isoDate, delivery: deliverySchema, privacy: classification,
  recurrence: reminderRecurrenceSchema.optional(), occurrence: z.number().int().nonnegative().default(0),
  goalId: z.string().trim().min(1).max(200).optional(), planId: z.string().trim().min(1).max(200).optional(), taskId: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(1).max(500), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['scheduled', 'firing', 'projected', 'cancelled', 'failed']),
  attempts: z.number().int().nonnegative(), maxAttempts: z.number().int().min(1).max(20),
  nextAttemptAt: isoDate, leaseUntil: isoDate.optional(), projectionId: z.string().trim().min(1).max(200).optional(),
  lastError: z.string().max(4000).optional(), createdAt: isoDate, updatedAt: isoDate, firedAt: isoDate.optional(), projectedAt: isoDate.optional(), cancelledAt: isoDate.optional(),
}).strict();
export type Reminder = z.infer<typeof reminderSchema>;
export type ReminderStatus = Reminder['status'];
export interface ReminderPage { items: Reminder[]; nextCursor?: string }
export interface CreateReminderInput {
  title: string; message: string; dueAt: string; delivery: z.infer<typeof deliverySchema>; privacy?: z.infer<typeof classification>;
  recurrence?: ReminderRecurrence;
  goalId?: string; planId?: string; taskId?: string; idempotencyKey?: string; maxAttempts?: number;
}

const stateSchema = z.object({ schemaVersion: z.literal(1), reminders: z.array(reminderSchema).max(100_000) }).strict();
type ReminderState = z.infer<typeof stateSchema>;

export class ReminderNotFound extends Error {}
export class ReminderConflict extends Error {}

function scopeMatches(value: Pick<Reminder, 'owner' | 'tenantId'>, scope?: Ownership): boolean {
  return scope === undefined || (value.owner === scope.owner && value.tenantId === scope.tenantId);
}
function parseNow(value: string): number {
  const parsed = Date.parse(isoDate.parse(value));
  if (!Number.isFinite(parsed)) throw new Error('Invalid reminder timestamp');
  return parsed;
}
function requestHash(input: CreateReminderInput, scope: Ownership): string {
  const normalized = {
    owner: scope.owner, tenantId: scope.tenantId, title: input.title.trim(), message: input.message.trim(), dueAt: isoDate.parse(input.dueAt),
    delivery: deliverySchema.parse(input.delivery), privacy: input.privacy ?? 'internal', goalId: input.goalId ?? null, planId: input.planId ?? null,
    taskId: input.taskId ?? null, recurrence: input.recurrence ?? null, idempotencyKey: input.idempotencyKey ?? null, maxAttempts: input.maxAttempts ?? 5,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
function makeReminder(input: CreateReminderInput, scope: Ownership, now = new Date().toISOString()): Reminder {
  const parsed: CreateReminderInput = {
    ...input, title: input.title.trim(), message: input.message.trim(), dueAt: isoDate.parse(input.dueAt),
    delivery: deliverySchema.parse(input.delivery), privacy: input.privacy ?? 'internal', maxAttempts: input.maxAttempts ?? 5,
  };
  const due = parseNow(parsed.dueAt);
  if (due < parseNow(now) - 86_400_000 * 365) throw new Error('Reminder dueAt is too far in the past');
  const recurrence = parsed.recurrence === undefined ? undefined : reminderRecurrenceSchema.parse(parsed.recurrence);
  const dueAt = recurrence && 'calendar' in recurrence ? nextCalendarOccurrence(recurrence.calendar, parsed.dueAt, true) : parsed.dueAt;
  return reminderSchema.parse({
    schemaVersion: 'reminder/1', id: `reminder_${randomUUID()}`, owner: scope.owner, tenantId: scope.tenantId,
    title: parsed.title, message: parsed.message, dueAt, delivery: parsed.delivery, privacy: parsed.privacy,
    ...(parsed.goalId === undefined ? {} : { goalId: parsed.goalId }), ...(parsed.planId === undefined ? {} : { planId: parsed.planId }), ...(parsed.taskId === undefined ? {} : { taskId: parsed.taskId }), ...(parsed.recurrence === undefined ? {} : { recurrence: reminderRecurrenceSchema.parse(parsed.recurrence) }),
    idempotencyKey: parsed.idempotencyKey ?? `reminder:${randomUUID()}`, requestHash: requestHash(parsed, scope), status: 'scheduled', attempts: 0,
    maxAttempts: parsed.maxAttempts, nextAttemptAt: dueAt, createdAt: now, updatedAt: now,
  });
}
function clone<T>(value: T): T { return structuredClone(value); }
function dueForClaim(item: Reminder, now: number): boolean {
  if (item.status === 'projected' || item.status === 'cancelled' || item.attempts >= item.maxAttempts) return false;
  if (parseNow(item.dueAt) > now || parseNow(item.nextAttemptAt) > now) return false;
  return item.status === 'scheduled' || item.status === 'failed' || (item.status === 'firing' && item.leaseUntil !== undefined && parseNow(item.leaseUntil) <= now);
}
function claim(items: Reminder[], scope: Ownership | undefined, nowIso: string, limit: number, leaseMs: number): Reminder[] {
  const now = parseNow(nowIso);
  const due = items.filter(item => scopeMatches(item, scope) && dueForClaim(item, now)).sort((left, right) => parseNow(left.dueAt) - parseNow(right.dueAt) || left.id.localeCompare(right.id)).slice(0, limit);
  const leaseUntil = new Date(now + leaseMs).toISOString();
  for (const item of due) { item.status = 'firing'; item.attempts += 1; item.leaseUntil = leaseUntil; item.firedAt ??= nowIso; item.updatedAt = nowIso; item.lastError = undefined; }
  return due;
}
function assertMutable(item: Reminder, id: string, scope?: Ownership): void {
  if (item.id !== id || !scopeMatches(item, scope)) throw new ReminderNotFound('Unknown reminder');
}

export type ReminderClaim = Pick<Reminder, 'occurrence' | 'attempts' | 'leaseUntil'>;
function matchesClaim(item: Reminder, expected?: ReminderClaim): boolean {
  return !expected || (item.occurrence === expected.occurrence && item.attempts === expected.attempts && item.leaseUntil === expected.leaseUntil);
}
function assertClaim(item: Reminder, expected?: ReminderClaim): void {
  if (!matchesClaim(item, expected)) throw new ReminderConflict('Reminder claim is stale');
}

function markProjectedState(item: Reminder, projectionId: string, at = new Date().toISOString()): Reminder {
  if (item.status !== 'firing') throw new ReminderConflict(`Reminder is ${item.status}; only firing reminders can be projected`);
  const occurrence = item.occurrence + 1;
  const recurrence = item.recurrence;
  const canRepeat = recurrence !== undefined && (recurrence.maxOccurrences === undefined || occurrence < recurrence.maxOccurrences);
  const base = { ...item, occurrence, projectionId, projectedAt: at, updatedAt: at };
  delete base.leaseUntil;
  if (!canRepeat || recurrence === undefined) return { ...base, status: 'projected' };
  const next = nextReminderOccurrence(recurrence, item.dueAt, at);
  delete base.firedAt;
  delete base.lastError;
  return { ...base, status: 'scheduled', attempts: 0, dueAt: next, nextAttemptAt: next };
}

export interface ReminderStore {
  init(): Promise<void>;
  create(input: CreateReminderInput, scope: Ownership): Promise<Reminder>;
  get(id: string, scope?: Ownership): Promise<Reminder>;
  list(scope?: Ownership, status?: ReminderStatus, limit?: number): Promise<Reminder[]>;
  /** Stable owner/tenant scoped keyset pagination for long reminder histories. */
  listPage?(scope: Ownership, limit: number, cursor?: string, status?: ReminderStatus): Promise<ReminderPage>;
  /** Bounded global scan used during Temporal timer reattachment. */
  listActivePage?(limit: number, cursor?: string): Promise<ReminderPage>;
  listScopes(): Promise<Ownership[]>;
  claimDue(scope: Ownership | undefined, now?: string, limit?: number, leaseMs?: number): Promise<Reminder[]>;
  markProjected(id: string, projectionId: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder>;
  markFailed(id: string, error: string, nextAttemptAt: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder>;
  cancel(id: string, scope?: Ownership): Promise<Reminder>;
  retry(id: string, scope?: Ownership): Promise<Reminder>;
  close(): Promise<void>;
}

function createOrExisting(items: Reminder[], input: CreateReminderInput, scope: Ownership): Reminder {
  const hash = requestHash(input, scope);
  const existing = items.find(item => item.owner === scope.owner && item.tenantId === scope.tenantId && item.idempotencyKey === (input.idempotencyKey ?? ''));
  if (existing) { if (existing.requestHash !== hash) throw new ReminderConflict('Reminder idempotency key is already bound to a different request'); return clone(existing); }
  const reminder = makeReminder(input, scope); items.push(reminder); return clone(reminder);
}

function isActiveReminder(item: Reminder): boolean {
  return item.status !== 'projected' && item.status !== 'cancelled';
}

function pageReminders(items: Reminder[], limit: number, cursor?: string): ReminderPage {
  validateCollectionLimit(limit);
  const pageCursor = decodeCollectionCursor(cursor);
  const selected = items.filter(item => isActiveReminder(item) && afterCollectionCursor(item, item.updatedAt, pageCursor)).sort(recentFirst(item => item.updatedAt));
  const hasMore = selected.length > limit;
  const visible = selected.slice(0, limit);
  return { items: clone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
}

/** In-memory store used by unit tests and embedded callers. */
export class InMemoryReminderStore implements ReminderStore {
  private readonly items = new Map<string, Reminder>();
  async init(): Promise<void> {}
  async create(input: CreateReminderInput, scope: Ownership): Promise<Reminder> {
    const values = [...this.items.values()]; const existing = input.idempotencyKey === undefined ? undefined : values.find(item => item.owner === scope.owner && item.tenantId === scope.tenantId && item.idempotencyKey === input.idempotencyKey);
    if (existing) { if (existing.requestHash !== requestHash(input, scope)) throw new ReminderConflict('Reminder idempotency key is already bound to a different request'); return clone(existing); }
    const reminder = makeReminder(input, scope); this.items.set(reminder.id, reminder); return clone(reminder);
  }
  async get(id: string, scope?: Ownership): Promise<Reminder> { const item = this.items.get(id); if (!item || !scopeMatches(item, scope)) throw new ReminderNotFound('Unknown reminder'); return clone(item); }
  async list(scope?: Ownership, status?: ReminderStatus, limit?: number): Promise<Reminder[]> { validateCollectionLimit(limit); const values = [...this.items.values()].filter(item => scopeMatches(item, scope) && (status === undefined || item.status === status)).sort((a, b) => parseNow(b.updatedAt) - parseNow(a.updatedAt) || a.id.localeCompare(b.id)); return clone(limit === undefined ? values : values.slice(0, limit)); }
  async listPage(scope: Ownership, limit: number, cursor?: string, status?: ReminderStatus): Promise<ReminderPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const selected = [...this.items.values()]
      .filter(item => scopeMatches(item, scope) && (status === undefined || item.status === status) && afterCollectionCursor(item, item.updatedAt, pageCursor))
      .sort(recentFirst(item => item.updatedAt));
    const hasMore = selected.length > limit;
    const visible = selected.slice(0, limit);
    return { items: clone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }
  async listActivePage(limit: number, cursor?: string): Promise<ReminderPage> { return pageReminders([...this.items.values()], limit, cursor); }
  async listScopes(): Promise<Ownership[]> { return [...new Map([...this.items.values()].map(item => [`${item.owner}:${item.tenantId}`, { owner: item.owner, tenantId: item.tenantId }])).values()]; }
  async claimDue(scope: Ownership | undefined, now = new Date().toISOString(), limit = 20, leaseMs = 30_000): Promise<Reminder[]> { validateCollectionLimit(limit); if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 86_400_000) throw new Error('Reminder lease must be between 1000ms and 86400000ms'); const selected = claim([...this.items.values()], scope, now, limit, leaseMs); for (const item of selected) this.items.set(item.id, item); return clone(selected); }
  async markProjected(id: string, projectionId: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder> { const item = await this.get(id, scope); assertClaim(item, expected); const next = markProjectedState(item, projectionId); this.items.set(id, next); return clone(next); }
  async markFailed(id: string, error: string, nextAttemptAt: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder> { const item = await this.get(id, scope); assertClaim(item, expected); if (item.status !== 'firing') throw new ReminderConflict(`Reminder is ${item.status}; only firing reminders can fail`); item.status = 'failed'; item.lastError = error.slice(0, 4000); item.nextAttemptAt = isoDate.parse(nextAttemptAt); item.updatedAt = new Date().toISOString(); delete item.leaseUntil; this.items.set(id, item); return clone(item); }
  async cancel(id: string, scope?: Ownership): Promise<Reminder> { const item = await this.get(id, scope); if (!['scheduled', 'failed'].includes(item.status)) throw new ReminderConflict(`Reminder is ${item.status}; only scheduled or failed reminders can be cancelled`); item.status = 'cancelled'; item.cancelledAt = new Date().toISOString(); item.updatedAt = item.cancelledAt; this.items.set(id, item); return clone(item); }
  async retry(id: string, scope?: Ownership): Promise<Reminder> { const item = await this.get(id, scope); if (!['failed', 'cancelled'].includes(item.status)) throw new ReminderConflict(`Reminder is ${item.status}; only failed or cancelled reminders can be retried`); item.status = 'scheduled'; item.attempts = 0; item.nextAttemptAt = new Date().toISOString(); item.updatedAt = item.nextAttemptAt; delete item.lastError; delete item.cancelledAt; this.items.set(id, item); return clone(item); }
  async close(): Promise<void> {}
}

/** Single-writer local durable store. The lock and atomic replacement make a
 * reminder claim survive process crashes without two local workers firing it. */
export class FileReminderStore implements ReminderStore {
  private state: ReminderState = { schemaVersion: 1, reminders: [] };
  private loaded = false; private queue: Promise<unknown> = Promise.resolve(); private lockOwned = false;
  constructor(private readonly path: string) {}
  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try { const lock = await open(`${this.path}.lock`, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); this.lockOwned = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(`${this.path}.lock`, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Reminder store already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; await unlink(`${this.path}.lock`); return this.init(); }
    }
    try { this.state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.save(); }
    this.loaded = true;
  }
  private async save(): Promise<void> { const parsed = stateSchema.parse(this.state); const temporary = `${this.path}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(`${JSON.stringify(parsed)}\n`); await file.sync(); } finally { await file.close(); } await rename(temporary, this.path); const directory = await open(dirname(this.path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  private async serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next; }
  private async ensure(): Promise<void> { if (!this.loaded) await this.init(); }
  async create(input: CreateReminderInput, scope: Ownership): Promise<Reminder> { return this.serial(async () => { await this.ensure(); const existing = input.idempotencyKey === undefined ? undefined : this.state.reminders.find(item => item.owner === scope.owner && item.tenantId === scope.tenantId && item.idempotencyKey === input.idempotencyKey); if (existing) { if (existing.requestHash !== requestHash(input, scope)) throw new ReminderConflict('Reminder idempotency key is already bound to a different request'); return clone(existing); } const reminder = makeReminder(input, scope); this.state.reminders.push(reminder); await this.save(); return clone(reminder); }); }
  async get(id: string, scope?: Ownership): Promise<Reminder> { await this.ensure(); const item = this.state.reminders.find(candidate => candidate.id === id); if (!item || !scopeMatches(item, scope)) throw new ReminderNotFound('Unknown reminder'); return clone(item); }
  async list(scope?: Ownership, status?: ReminderStatus, limit?: number): Promise<Reminder[]> { await this.ensure(); validateCollectionLimit(limit); const values = this.state.reminders.filter(item => scopeMatches(item, scope) && (status === undefined || item.status === status)).sort((a, b) => parseNow(b.updatedAt) - parseNow(a.updatedAt) || a.id.localeCompare(b.id)); return clone(limit === undefined ? values : values.slice(0, limit)); }
  async listPage(scope: Ownership, limit: number, cursor?: string, status?: ReminderStatus): Promise<ReminderPage> {
    await this.ensure(); validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const selected = this.state.reminders
      .filter(item => scopeMatches(item, scope) && (status === undefined || item.status === status) && afterCollectionCursor(item, item.updatedAt, pageCursor))
      .sort(recentFirst(item => item.updatedAt));
    const hasMore = selected.length > limit;
    const visible = selected.slice(0, limit);
    return { items: clone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }
  async listActivePage(limit: number, cursor?: string): Promise<ReminderPage> { await this.ensure(); return pageReminders(this.state.reminders, limit, cursor); }
  async listScopes(): Promise<Ownership[]> { await this.ensure(); return [...new Map(this.state.reminders.map(item => [`${item.owner}:${item.tenantId}`, { owner: item.owner, tenantId: item.tenantId }])).values()]; }
  async claimDue(scope: Ownership | undefined, now = new Date().toISOString(), limit = 20, leaseMs = 30_000): Promise<Reminder[]> { return this.serial(async () => { await this.ensure(); validateCollectionLimit(limit); if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 86_400_000) throw new Error('Reminder lease must be between 1000ms and 86400000ms'); const selected = claim(this.state.reminders, scope, now, limit, leaseMs); if (selected.length) await this.save(); return clone(selected); }); }
  async update(id: string, scope: Ownership | undefined, operation: (item: Reminder) => Reminder): Promise<Reminder> { return this.serial(async () => { await this.ensure(); const index = this.state.reminders.findIndex(item => item.id === id); const current = index < 0 ? undefined : this.state.reminders[index]; if (!current || !scopeMatches(current, scope)) throw new ReminderNotFound('Unknown reminder'); const next = reminderSchema.parse(operation(clone(current))); this.state.reminders[index] = next; await this.save(); return clone(next); }); }
  async markProjected(id: string, projectionId: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder> { return this.update(id, scope, item => { assertClaim(item, expected); return markProjectedState(item, projectionId); }); }
  async markFailed(id: string, error: string, nextAttemptAt: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder> { return this.update(id, scope, item => { assertClaim(item, expected); if (item.status !== 'firing') throw new ReminderConflict(`Reminder is ${item.status}; only firing reminders can fail`); const at = new Date().toISOString(); delete item.leaseUntil; return { ...item, status: 'failed', lastError: error.slice(0, 4000), nextAttemptAt: isoDate.parse(nextAttemptAt), updatedAt: at }; }); }
  async cancel(id: string, scope?: Ownership): Promise<Reminder> { return this.update(id, scope, item => { if (!['scheduled', 'failed'].includes(item.status)) throw new ReminderConflict(`Reminder is ${item.status}; only scheduled or failed reminders can be cancelled`); const at = new Date().toISOString(); return { ...item, status: 'cancelled', cancelledAt: at, updatedAt: at }; }); }
  async retry(id: string, scope?: Ownership): Promise<Reminder> { return this.update(id, scope, item => { if (!['failed', 'cancelled'].includes(item.status)) throw new ReminderConflict(`Reminder is ${item.status}; only failed or cancelled reminders can be retried`); const at = new Date().toISOString(); delete item.lastError; delete item.cancelledAt; return { ...item, status: 'scheduled', attempts: 0, nextAttemptAt: at, updatedAt: at }; }); }
  async close(): Promise<void> { await this.queue; if (this.lockOwned) { await unlink(`${this.path}.lock`).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); this.lockOwned = false; } this.loaded = false; }
}

function rowToReminder(row: { state: unknown }): Reminder { return reminderSchema.parse(row.state); }
function sqlState(reminder: Reminder): [string, string, string, string, string, string, string, number, string, string] { return [reminder.id, reminder.owner, reminder.tenantId, reminder.status, reminder.dueAt, reminder.nextAttemptAt, reminder.leaseUntil ?? '', reminder.attempts, reminder.createdAt, reminder.updatedAt]; }

/** PostgreSQL store uses row locks and SKIP LOCKED for cross-process claims. */
export class PostgresReminderStore implements ReminderStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> { await withPostgresMigrationLock(this.pool, 'reminders', async client => { await client.query(`CREATE TABLE IF NOT EXISTS aeeis_reminders (id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, status text NOT NULL, due_at timestamptz NOT NULL, next_attempt_at timestamptz NOT NULL, lease_until timestamptz, attempts integer NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, idempotency_key text NOT NULL, state jsonb NOT NULL, UNIQUE(owner, tenant_id, idempotency_key)); CREATE INDEX IF NOT EXISTS aeeis_reminders_due_idx ON aeeis_reminders(owner, tenant_id, status, due_at, next_attempt_at, id); CREATE INDEX IF NOT EXISTS aeeis_reminders_scope_updated_idx ON aeeis_reminders(owner, tenant_id, updated_at DESC, id); CREATE INDEX IF NOT EXISTS aeeis_reminders_active_recent_idx ON aeeis_reminders(updated_at DESC, id) WHERE status IN ('scheduled','firing','failed');`); }); }
  async create(input: CreateReminderInput, scope: Ownership): Promise<Reminder> { const reminder = makeReminder(input, scope); const result = await this.pool.query<{ state: unknown }>('INSERT INTO aeeis_reminders(id,owner,tenant_id,status,due_at,next_attempt_at,lease_until,attempts,created_at,updated_at,idempotency_key,state) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11) ON CONFLICT(owner,tenant_id,idempotency_key) DO NOTHING RETURNING state', [reminder.id, reminder.owner, reminder.tenantId, reminder.status, reminder.dueAt, reminder.nextAttemptAt, reminder.attempts, reminder.createdAt, reminder.updatedAt, reminder.idempotencyKey, reminder]); if (result.rows[0]) return rowToReminder(result.rows[0]); const existing = await this.getByKey(reminder.idempotencyKey, scope); if (existing.requestHash !== reminder.requestHash) throw new ReminderConflict('Reminder idempotency key is already bound to a different request'); return existing; }
  private async getByKey(key: string, scope: Ownership): Promise<Reminder> { const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_reminders WHERE owner=$1 AND tenant_id=$2 AND idempotency_key=$3', [scope.owner, scope.tenantId, key]); if (!result.rows[0]) throw new ReminderNotFound('Unknown reminder'); return rowToReminder(result.rows[0]); }
  async get(id: string, scope?: Ownership): Promise<Reminder> { const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_reminders WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [id, scope.owner, scope.tenantId] : [id]); if (!result.rows[0]) throw new ReminderNotFound('Unknown reminder'); return rowToReminder(result.rows[0]); }
  async list(scope?: Ownership, status?: ReminderStatus, limit?: number): Promise<Reminder[]> { validateCollectionLimit(limit); const values: unknown[] = []; const where: string[] = []; if (scope) { values.push(scope.owner, scope.tenantId); where.push(`owner=$${values.length - 1} AND tenant_id=$${values.length}`); } if (status) { values.push(status); where.push(`status=$${values.length}`); } const limitClause = limit === undefined ? '' : ` LIMIT $${values.push(limit)}`; const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_reminders${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC,id${limitClause}`, values); return result.rows.map(rowToReminder); }
  async listPage(scope: Ownership, limit: number, cursor?: string, status?: ReminderStatus): Promise<ReminderPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId];
    const where = ['owner=$1', 'tenant_id=$2'];
    if (status !== undefined) { values.push(status); where.push(`status=$${values.length}`); }
    if (pageCursor) {
      values.push(pageCursor.timestamp, pageCursor.id);
      where.push(`(updated_at < $${values.length - 1}::timestamptz OR (updated_at = $${values.length - 1}::timestamptz AND id > $${values.length}))`);
    }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_reminders WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit;
    const visible = (hasMore ? result.rows.slice(0, limit) : result.rows).map(rowToReminder);
    return { items: visible, ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }
  async listActivePage(limit: number, cursor?: string): Promise<ReminderPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const values: unknown[] = [];
    const where = ["status IN ('scheduled','firing','failed')"];
    if (pageCursor) { values.push(pageCursor.timestamp, pageCursor.id); where.push(`(updated_at < $${values.length - 1}::timestamptz OR (updated_at = $${values.length - 1}::timestamptz AND id > $${values.length}))`); }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_reminders WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit;
    const visible = (hasMore ? result.rows.slice(0, limit) : result.rows).map(rowToReminder);
    return { items: visible, ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }
  async listScopes(): Promise<Ownership[]> { const result = await this.pool.query<{ owner: string; tenant_id: string }>('SELECT DISTINCT owner, tenant_id FROM aeeis_reminders'); return result.rows.map(row => ({ owner: row.owner, tenantId: row.tenant_id })); }
  async claimDue(scope: Ownership | undefined, now = new Date().toISOString(), limit = 20, leaseMs = 30_000): Promise<Reminder[]> { validateCollectionLimit(limit); if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 86_400_000) throw new Error('Reminder lease must be between 1000ms and 86400000ms'); const client = await this.pool.connect(); try { await client.query('BEGIN'); const values: unknown[] = [now, now]; const where = [`due_at <= $1`, `next_attempt_at <= $2`, `attempts < COALESCE((state->>'maxAttempts')::integer, 20)`, `(status='scheduled' OR status='failed' OR (status='firing' AND lease_until <= $1))`]; if (scope) { values.push(scope.owner, scope.tenantId); where.push(`owner=$${values.length - 1} AND tenant_id=$${values.length}`); } values.push(limit); const rows = await client.query<{ state: unknown }>(`SELECT state FROM aeeis_reminders WHERE ${where.join(' AND ')} ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT $${values.length}`, values); const selected: Reminder[] = []; const leaseUntil = new Date(parseNow(now) + leaseMs).toISOString(); for (const row of rows.rows) { const item = rowToReminder(row); if (item.attempts >= item.maxAttempts) continue; item.status = 'firing'; item.attempts += 1; item.leaseUntil = leaseUntil; item.firedAt ??= now; item.updatedAt = now; delete item.lastError; await client.query('UPDATE aeeis_reminders SET status=$2,due_at=$3,next_attempt_at=$4,lease_until=$5,attempts=$6,updated_at=$7,state=$8 WHERE id=$1', [item.id, item.status, item.dueAt, item.nextAttemptAt, item.leaseUntil, item.attempts, item.updatedAt, item]); selected.push(item); } await client.query('COMMIT'); return clone(selected); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  private async mutate(id: string, scope: Ownership | undefined, operation: (item: Reminder) => Reminder): Promise<Reminder> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const result = await client.query<{ state: unknown }>(`SELECT state FROM aeeis_reminders WHERE id=$1 FOR UPDATE`, [id]); if (!result.rows[0]) throw new ReminderNotFound('Unknown reminder'); const current = rowToReminder(result.rows[0]); if (!scopeMatches(current, scope)) throw new ReminderNotFound('Unknown reminder'); const next = reminderSchema.parse(operation(clone(current))); await client.query('UPDATE aeeis_reminders SET status=$2,next_attempt_at=$3,lease_until=$4,attempts=$5,updated_at=$6,state=$7,due_at=$8 WHERE id=$1', [next.id, next.status, next.nextAttemptAt, next.leaseUntil ?? null, next.attempts, next.updatedAt, next, next.dueAt]); await client.query('COMMIT'); return clone(next); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async markProjected(id: string, projectionId: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder> { return this.mutate(id, scope, item => { assertClaim(item, expected); return markProjectedState(item, projectionId); }); }
  async markFailed(id: string, error: string, nextAttemptAt: string, scope?: Ownership, expected?: ReminderClaim): Promise<Reminder> { return this.mutate(id, scope, item => { assertClaim(item, expected); if (item.status !== 'firing') throw new ReminderConflict(`Reminder is ${item.status}; only firing reminders can fail`); const at = new Date().toISOString(); delete item.leaseUntil; return { ...item, status: 'failed', lastError: error.slice(0, 4000), nextAttemptAt: isoDate.parse(nextAttemptAt), updatedAt: at }; }); }
  async cancel(id: string, scope?: Ownership): Promise<Reminder> { return this.mutate(id, scope, item => { if (!['scheduled', 'failed'].includes(item.status)) throw new ReminderConflict(`Reminder is ${item.status}; only scheduled or failed reminders can be cancelled`); const at = new Date().toISOString(); return { ...item, status: 'cancelled', cancelledAt: at, updatedAt: at }; }); }
  async retry(id: string, scope?: Ownership): Promise<Reminder> { return this.mutate(id, scope, item => { if (!['failed', 'cancelled'].includes(item.status)) throw new ReminderConflict(`Reminder is ${item.status}; only failed or cancelled reminders can be retried`); const at = new Date().toISOString(); delete item.lastError; delete item.cancelledAt; return { ...item, status: 'scheduled', attempts: 0, nextAttemptAt: at, updatedAt: at }; }); }
  async close(): Promise<void> { await this.pool.end(); }
}

export interface ReminderProjector { enqueue(input: { channel: string; destination: string; aggregateType: ProjectionAggregateType; aggregateId: string; payload: unknown; idempotencyKey: string; owner: string; tenantId: string }): Promise<{ id: string }> }
export interface ReminderAdvanceResult {
  status: ReminderStatus;
  terminal: boolean;
  /** The next durable timestamp at which the timer workflow should wake. */
  wakeAt?: string;
}
export class ReminderPump {
  private pumpInFlight: Promise<{ claimed: number; projected: number; failed: number }> | undefined;
  private inFlight = new Set<Promise<unknown>>();
  constructor(private readonly store: ReminderStore, private readonly projector: ReminderProjector, private readonly options: { batchSize?: number; leaseMs?: number; retryDelayMs?: number } = {}) {}
  async pump(now = new Date().toISOString()): Promise<{ claimed: number; projected: number; failed: number }> {
    if (this.pumpInFlight) return this.pumpInFlight;
    const work = (async () => {
      const batchSize = this.options.batchSize ?? 20; const scopes = await this.store.listScopes(); const targets = scopes.length ? scopes : [undefined]; let claimed = 0; let projected = 0; let failed = 0;
      for (const scope of targets) {
        const reminders = await this.store.claimDue(scope, now, batchSize, this.options.leaseMs ?? 30_000); claimed += reminders.length;
        for (const reminder of reminders) {
          const work = this.project(reminder).then(() => { projected += 1; }, async error => {
            const scope = { owner: reminder.owner, tenantId: reminder.tenantId };
            // A lease may expire while a slow sink is still delivering. The
            // second worker can safely lose the mark race after the first one
            // committed the same idempotent outbox event; do not turn that
            // already terminal reminder back into a retryable failure.
            const current = await this.store.get(reminder.id, scope).catch(() => undefined);
            if (current && (!matchesClaim(current, reminder) || current.status === 'projected' || current.status === 'cancelled')) return;
            failed += 1;
            const delay = this.options.retryDelayMs ?? 30_000;
            await this.store.markFailed(reminder.id, error instanceof Error ? error.message : 'Reminder projection failed', new Date(Date.parse(now) + delay).toISOString(), scope, reminder);
          }).finally(() => this.inFlight.delete(work));
          this.inFlight.add(work);
        }
      }
      await Promise.all([...this.inFlight]); return { claimed, projected, failed };
    })();
    this.pumpInFlight = work;
    try { return await work; }
    finally { if (this.pumpInFlight === work) this.pumpInFlight = undefined; }
  }
  private async project(reminder: Reminder): Promise<void> { const projection = await this.projector.enqueue({ channel: reminder.delivery.channel, destination: reminder.delivery.destination, aggregateType: 'reminder', aggregateId: reminder.id, idempotencyKey: `reminder:${reminder.id}:${reminder.occurrence}`, owner: reminder.owner, tenantId: reminder.tenantId, payload: { schemaVersion: 'reminder-event/1', reminderId: reminder.id, occurrence: reminder.occurrence, title: reminder.title, message: reminder.message, dueAt: reminder.dueAt, privacy: reminder.privacy, ...(reminder.goalId ? { goalId: reminder.goalId } : {}), ...(reminder.planId ? { planId: reminder.planId } : {}), ...(reminder.taskId ? { taskId: reminder.taskId } : {}) } }); await this.store.markProjected(reminder.id, projection.id, { owner: reminder.owner, tenantId: reminder.tenantId }, reminder); }
  /**
   * Advance one reminder after a durable Temporal timer fires. The regular
   * pump remains the safety net and owns leasing/idempotency; this method
   * deliberately reuses it instead of introducing a second claim protocol.
   */
  async advance(id: string): Promise<ReminderAdvanceResult> {
    const before = await this.store.get(id);
    const terminal = before.status === 'projected' || before.status === 'cancelled' || (before.status === 'failed' && before.attempts >= before.maxAttempts);
    if (!terminal) await this.pump();
    const current = await this.store.get(id);
    const isTerminal = current.status === 'projected' || current.status === 'cancelled' || (current.status === 'failed' && current.attempts >= current.maxAttempts);
    const wakeAt = isTerminal
      ? undefined
      : current.status === 'firing'
        ? current.leaseUntil
        : current.status === 'failed'
          ? current.nextAttemptAt
          : new Date(Math.max(Date.parse(current.dueAt), Date.parse(current.nextAttemptAt))).toISOString();
    return { status: current.status, terminal: isTerminal, ...(wakeAt ? { wakeAt } : {}) };
  }
  async drain(): Promise<void> {
    // Shutdown may race with a Temporal activity or interval tick before it
    // has claimed a reminder. Wait for the pump itself first, then keep the
    // explicit in-flight wait for compatibility with older callers.
    const active = this.pumpInFlight;
    if (active) await active;
    await Promise.all([...this.inFlight]);
  }
}
