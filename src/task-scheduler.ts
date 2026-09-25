import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { postgresAdvisoryLockKeys } from './adapters/postgres-lock.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { digest, taskRunIdFor, type AgentEngine } from './runtime/engine.js';
import type { AgentRun, TaskRequest, RunStatus } from './runtime/contracts.js';
import type { Dispatcher } from './runtime/dispatcher.js';
import { NotFound } from './runtime/repository.js';
import type { AeeisService } from './application/aeeis-service.js';
import type { Plan, PlanNode, Id } from './contracts.js';
import type { Ownership } from './security/principal.js';

export type TaskDispatchState = 'queued' | 'dispatched' | 'waiting' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';

export interface TaskDispatchRecord {
  schemaVersion: 1;
  id: string;
  idempotencyKey: string;
  owner: string;
  tenantId: string;
  goalId: Id;
  planId: Id;
  taskId: Id;
  taskAttempt: number;
  runId: string;
  workflowId: string;
  runner: string;
  state: TaskDispatchState;
  dispatchAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastRunStatus?: RunStatus;
  lastError?: string;
  /** Frozen creation input; internal, never returned by scheduler HTTP views. */
  createRequest?: Partial<TaskRequest>;
  /** Short lease coordinating the create-before-ledger-update window. */
  createLease?: { token: string; expiresAt: string };
}

/** HTTP projection excludes creation inputs and coordination tokens. */
export function publicTaskDispatch(record: TaskDispatchRecord): Omit<TaskDispatchRecord, 'createRequest' | 'createLease'> {
  const { createRequest: _request, createLease: _lease, ...visible } = record;
  return visible;
}

export interface TaskDispatchReservationInput {
  owner: string;
  tenantId: string;
  goalId: Id;
  planId: Id;
  taskId: Id;
  taskAttempt: number;
  runId: string;
  workflowId: string;
  runner: string;
  now?: string;
  createRequest?: Partial<TaskRequest>;
}

export interface TaskDispatchRepository {
  init(): Promise<void>;
  reserve(input: TaskDispatchReservationInput): Promise<{ record: TaskDispatchRecord; created: boolean }>;
  get(id: string, scope?: Ownership): Promise<TaskDispatchRecord>;
  getForTask(planId: string, taskId: string, scope: Ownership): Promise<TaskDispatchRecord | undefined>;
  list(scope?: Ownership, planId?: string): Promise<TaskDispatchRecord[]>;
  /** Stable keyset page for bounded recovery scans. */
  listPage?(scope: Ownership, limit: number, cursor?: string, planId?: string): Promise<{ records: TaskDispatchRecord[]; nextCursor?: string }>;
  /** Distinct scopes used by the recovery pump, without loading task state. */
  listScopes?(): Promise<Ownership[]>;
  /** Run one recovery sweep under a scope-wide, non-blocking lease. */
  withRecoveryLease?<T>(scope: Ownership, work: () => Promise<T>): Promise<T | undefined>;
  mutate(id: string, change: (record: TaskDispatchRecord) => void, scope?: Ownership): Promise<TaskDispatchRecord>;
  close(): Promise<void>;
}

type DispatchPageKey = { createdAt: string; id: string };
function encodeDispatchCursor(key: DispatchPageKey): string { return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url'); }
function decodeDispatchCursor(value: string | undefined): DispatchPageKey | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<DispatchPageKey>;
    if (typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string' || parsed.id.length < 1 || parsed.id.length > 200) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch { throw new RangeError('Invalid task dispatch cursor'); }
}
function validateDispatchPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('Invalid task dispatch page limit');
}
function afterDispatchCursor(record: TaskDispatchRecord, cursor: DispatchPageKey | undefined): boolean {
  if (!cursor) return true;
  const time = Date.parse(record.createdAt), cursorTime = Date.parse(cursor.createdAt);
  return time > cursorTime || (time === cursorTime && record.id > cursor.id);
}
function dispatchPage<T extends TaskDispatchRecord>(records: T[], limit: number, cursor?: string): { records: T[]; nextCursor?: string } {
  validateDispatchPageLimit(limit);
  const key = decodeDispatchCursor(cursor);
  const ordered = records.filter(record => afterDispatchCursor(record, key)).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const page = ordered.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const visible = hasMore ? page.slice(0, limit) : page;
  return { records: visible.map(clone), ...(hasMore && visible.length ? { nextCursor: encodeDispatchCursor({ createdAt: visible.at(-1)!.createdAt, id: visible.at(-1)!.id }) } : {}) };
}

const dispatchId = (input: Pick<TaskDispatchReservationInput, 'owner' | 'tenantId' | 'planId' | 'taskId'>): string => {
  // Keep retries on the same domain task bound to the same ledger row. The
  // caller passes attempt/run metadata too, but those fields must not alter
  // the reservation identity.
  const { owner, tenantId, planId, taskId } = input;
  return `dispatch_${digest({ owner, tenantId, planId, taskId }).slice(0, 32)}`;
};

function own(record: TaskDispatchRecord, scope: Ownership): boolean {
  return record.owner === scope.owner && record.tenantId === scope.tenantId;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class InMemoryTaskDispatchRepository implements TaskDispatchRepository {
  private readonly records = new Map<string, TaskDispatchRecord>();
  async init(): Promise<void> {}
  async reserve(input: TaskDispatchReservationInput): Promise<{ record: TaskDispatchRecord; created: boolean }> {
    const id = dispatchId(input);
    const existing = this.records.get(id);
    if (existing) return { record: clone(existing), created: false };
    const now = input.now ?? new Date().toISOString();
    const record: TaskDispatchRecord = {
      schemaVersion: 1, id, idempotencyKey: id,
      owner: input.owner, tenantId: input.tenantId, goalId: input.goalId, planId: input.planId, taskId: input.taskId,
      taskAttempt: input.taskAttempt, runId: input.runId, workflowId: input.workflowId, runner: input.runner,
      state: 'queued', dispatchAttempts: 0, createdAt: now, updatedAt: now,
      ...(input.createRequest ? { createRequest: clone(input.createRequest) } : {}),
    };
    this.records.set(id, clone(record));
    return { record: clone(record), created: true };
  }
  async get(id: string, scope?: Ownership): Promise<TaskDispatchRecord> {
    const record = this.records.get(id);
    if (!record || (scope && !own(record, scope))) throw new NotFound('Unknown task dispatch');
    return clone(record);
  }
  async getForTask(planId: string, taskId: string, scope: Ownership): Promise<TaskDispatchRecord | undefined> {
    const record = [...this.records.values()].find(item => item.planId === planId && item.taskId === taskId && own(item, scope));
    return record ? clone(record) : undefined;
  }
  async list(scope?: Ownership, planId?: string): Promise<TaskDispatchRecord[]> {
    return clone([...this.records.values()].filter(record => (!scope || own(record, scope)) && (!planId || record.planId === planId)));
  }
  async listPage(scope: Ownership, limit: number, cursor?: string, planId?: string): Promise<{ records: TaskDispatchRecord[]; nextCursor?: string }> {
    return dispatchPage([...this.records.values()].filter(record => own(record, scope) && (!planId || record.planId === planId)), limit, cursor);
  }
  async listScopes(): Promise<Ownership[]> {
    return [...new Map([...this.records.values()].map(record => [`${record.owner}:${record.tenantId}`, { owner: record.owner, tenantId: record.tenantId }])).values()];
  }
  async withRecoveryLease<T>(_scope: Ownership, work: () => Promise<T>): Promise<T> { return work(); }
  async mutate(id: string, change: (record: TaskDispatchRecord) => void, scope?: Ownership): Promise<TaskDispatchRecord> {
    const stored = this.records.get(id);
    if (!stored || (scope && !own(stored, scope))) throw new NotFound('Unknown task dispatch');
    const current = clone(stored);
    change(current); current.updatedAt = new Date().toISOString();
    this.records.set(id, clone(current)); return clone(current);
  }
  async close(): Promise<void> {}
}

interface FileState { records: TaskDispatchRecord[] }
const emptyFileState = (): FileState => ({ records: [] });

/** A single-writer JSON ledger. Mutations replace the complete snapshot so a
 * restart can distinguish an unclaimed queue item from an acknowledged one. */
export class FileTaskDispatchRepository implements TaskDispatchRepository {
  private state: FileState = emptyFileState();
  private loaded = false;
  private lockOwned = false;
  constructor(private readonly filePath: string) {}
  async init(): Promise<void> {
    if (this.loaded) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    try {
      const lock = openSync(lockPath, 'wx', 0o600);
      try { writeSync(lock, String(process.pid)); } finally { closeSync(lock); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid task dispatch lock; inspect before recovery');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        unlinkSync(lockPath); return this.init();
      }
      throw new Error('Task dispatch store already has a live writer');
    }
    this.lockOwned = true;
    try { this.state = { ...emptyFileState(), ...(JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<FileState>) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
      this.state = emptyFileState();
    }
    this.loaded = true;
  }
  async reserve(input: TaskDispatchReservationInput): Promise<{ record: TaskDispatchRecord; created: boolean }> {
    const id = dispatchId(input);
    const existing = this.state.records.find(record => record.id === id);
    if (existing) return { record: clone(existing), created: false };
    const now = input.now ?? new Date().toISOString();
    const record: TaskDispatchRecord = {
      schemaVersion: 1, id, idempotencyKey: id,
      owner: input.owner, tenantId: input.tenantId, goalId: input.goalId, planId: input.planId, taskId: input.taskId,
      taskAttempt: input.taskAttempt, runId: input.runId, workflowId: input.workflowId, runner: input.runner,
      state: 'queued', dispatchAttempts: 0, createdAt: now, updatedAt: now,
      ...(input.createRequest ? { createRequest: clone(input.createRequest) } : {}),
    };
    this.persist({ records: [...this.state.records, record] });
    return { record: clone(record), created: true };
  }
  async get(id: string, scope?: Ownership): Promise<TaskDispatchRecord> {
    const record = this.state.records.find(item => item.id === id);
    if (!record || (scope && !own(record, scope))) throw new NotFound('Unknown task dispatch');
    return clone(record);
  }
  async getForTask(planId: string, taskId: string, scope: Ownership): Promise<TaskDispatchRecord | undefined> {
    const record = this.state.records.find(item => item.planId === planId && item.taskId === taskId && own(item, scope));
    return record ? clone(record) : undefined;
  }
  async list(scope?: Ownership, planId?: string): Promise<TaskDispatchRecord[]> {
    return clone(this.state.records.filter(record => (!scope || own(record, scope)) && (!planId || record.planId === planId)));
  }
  async listPage(scope: Ownership, limit: number, cursor?: string, planId?: string): Promise<{ records: TaskDispatchRecord[]; nextCursor?: string }> {
    return dispatchPage(this.state.records.filter(record => own(record, scope) && (!planId || record.planId === planId)), limit, cursor);
  }
  async listScopes(): Promise<Ownership[]> {
    return [...new Map(this.state.records.map(record => [`${record.owner}:${record.tenantId}`, { owner: record.owner, tenantId: record.tenantId }])).values()];
  }
  async withRecoveryLease<T>(_scope: Ownership, work: () => Promise<T>): Promise<T> { return work(); }
  async mutate(id: string, change: (record: TaskDispatchRecord) => void, scope?: Ownership): Promise<TaskDispatchRecord> {
    const stored = this.state.records.find(record => record.id === id);
    if (!stored || (scope && !own(stored, scope))) throw new NotFound('Unknown task dispatch');
    const current = clone(stored); change(current); current.updatedAt = new Date().toISOString();
    this.persist({ records: this.state.records.map(record => record.id === id ? current : record) }); return clone(current);
  }
  async close(): Promise<void> {
    if (this.lockOwned) { unlinkSync(`${this.filePath}.lock`); this.lockOwned = false; }
    this.loaded = false;
  }
  private persist(state: FileState): void {
    if (!this.loaded && !this.lockOwned) throw new Error('Task dispatch store is not open');
    const tempPath = `${this.filePath}.${Date.now()}.${process.pid}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      writeSync(descriptor, serialized, undefined, 'utf8'); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(tempPath, this.filePath);
      const directoryDescriptor = openSync(dirname(this.filePath), 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
      this.state = state;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(tempPath); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
      }
      throw error;
    }
  }
}

export class PostgresTaskDispatchRepository implements TaskDispatchRepository {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'task-dispatches', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_task_dispatches (
          id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, plan_id text NOT NULL,
          task_id text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
          UNIQUE(owner, tenant_id, plan_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS aeeis_task_dispatches_scope_idx ON aeeis_task_dispatches(owner, tenant_id, plan_id);
        CREATE INDEX IF NOT EXISTS aeeis_task_dispatches_page_idx ON aeeis_task_dispatches(owner, tenant_id, created_at, id);
      `);
    });
  }
  async reserve(input: TaskDispatchReservationInput): Promise<{ record: TaskDispatchRecord; created: boolean }> {
    const id = dispatchId(input); const now = input.now ?? new Date().toISOString();
    const record: TaskDispatchRecord = {
      schemaVersion: 1, id, idempotencyKey: id,
      owner: input.owner, tenantId: input.tenantId, goalId: input.goalId, planId: input.planId, taskId: input.taskId,
      taskAttempt: input.taskAttempt, runId: input.runId, workflowId: input.workflowId, runner: input.runner,
      state: 'queued', dispatchAttempts: 0, createdAt: now, updatedAt: now,
      ...(input.createRequest ? { createRequest: clone(input.createRequest) } : {}),
    };
    const inserted = await this.pool.query(
      'INSERT INTO aeeis_task_dispatches(id,owner,tenant_id,plan_id,task_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner,tenant_id,plan_id,task_id) DO NOTHING',
      [id, input.owner, input.tenantId, input.planId, input.taskId, record, now, now],
    );
    return { record: await this.get(id, { owner: input.owner, tenantId: input.tenantId }), created: inserted.rowCount === 1 };
  }
  async get(id: string, scope?: Ownership): Promise<TaskDispatchRecord> {
    const values: unknown[] = [id];
    let query = 'SELECT state FROM aeeis_task_dispatches WHERE id=$1';
    if (scope) { values.push(scope.owner, scope.tenantId); query += ' AND owner=$2 AND tenant_id=$3'; }
    const result = await this.pool.query<{ state: TaskDispatchRecord }>(query, values);
    if (!result.rows[0]) throw new NotFound('Unknown task dispatch');
    return result.rows[0].state;
  }
  async getForTask(planId: string, taskId: string, scope: Ownership): Promise<TaskDispatchRecord | undefined> {
    const result = await this.pool.query<{ state: TaskDispatchRecord }>('SELECT state FROM aeeis_task_dispatches WHERE owner=$1 AND tenant_id=$2 AND plan_id=$3 AND task_id=$4', [scope.owner, scope.tenantId, planId, taskId]);
    return result.rows[0]?.state;
  }
  async list(scope?: Ownership, planId?: string): Promise<TaskDispatchRecord[]> {
    const values: unknown[] = []; const where: string[] = [];
    if (scope) { values.push(scope.owner, scope.tenantId); where.push(`owner=$${values.length - 1}`, `tenant_id=$${values.length}`); }
    if (planId) { values.push(planId); where.push(`plan_id=$${values.length}`); }
    const result = await this.pool.query<{ state: TaskDispatchRecord }>(`SELECT state FROM aeeis_task_dispatches${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at,id`, values);
    return result.rows.map(row => row.state);
  }
  async listPage(scope: Ownership, limit: number, cursor?: string, planId?: string): Promise<{ records: TaskDispatchRecord[]; nextCursor?: string }> {
    validateDispatchPageLimit(limit);
    const pageKey = decodeDispatchCursor(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId];
    const where = ['owner=$1', 'tenant_id=$2'];
    if (planId) { values.push(planId); where.push(`plan_id=$${values.length}`); }
    if (pageKey) { values.push(pageKey.createdAt, pageKey.id); where.push(`(created_at > $${values.length - 1}::timestamptz OR (created_at = $${values.length - 1}::timestamptz AND id > $${values.length}))`); }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: TaskDispatchRecord }>(`SELECT state FROM aeeis_task_dispatches WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit;
    const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { records: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodeDispatchCursor({ createdAt: visible.at(-1)!.state.createdAt, id: visible.at(-1)!.state.id }) } : {}) };
  }
  async listScopes(): Promise<Ownership[]> {
    const result = await this.pool.query<{ owner: string; tenant_id: string }>('SELECT DISTINCT owner, tenant_id FROM aeeis_task_dispatches ORDER BY owner, tenant_id');
    return result.rows.map(row => ({ owner: row.owner, tenantId: row.tenant_id }));
  }
  async withRecoveryLease<T>(scope: Ownership, work: () => Promise<T>): Promise<T | undefined> {
    const client = await this.pool.connect();
    const [key1, key2] = postgresAdvisoryLockKeys('aeeis-task-reconcile', `${scope.owner}\0${scope.tenantId}`);
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked', [key1, key2]);
      if (!result.rows[0]?.locked) return undefined;
      try { return await work(); }
      finally { await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', [key1, key2]); }
    } finally { client.release(); }
  }
  async mutate(id: string, change: (record: TaskDispatchRecord) => void, scope?: Ownership): Promise<TaskDispatchRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const values: unknown[] = [id]; let query = 'SELECT state FROM aeeis_task_dispatches WHERE id=$1 FOR UPDATE';
      if (scope) { values.push(scope.owner, scope.tenantId); query = 'SELECT state FROM aeeis_task_dispatches WHERE id=$1 AND owner=$2 AND tenant_id=$3 FOR UPDATE'; }
      const result = await client.query<{ state: TaskDispatchRecord }>(query, values);
      if (!result.rows[0]) throw new NotFound('Unknown task dispatch');
      const record = result.rows[0].state; change(record); record.updatedAt = new Date().toISOString();
      await client.query('UPDATE aeeis_task_dispatches SET state=$2, updated_at=$3 WHERE id=$1', [id, record, record.updatedAt]);
      await client.query('COMMIT'); return record;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export interface TaskSchedulerOptions {
  runOptions?: Partial<Omit<TaskRequest, 'goal' | 'goalId' | 'taskExecution'>>;
}

export interface TaskReconcileOptions {
  /** Keep the HTTP-compatible full result when a caller needs it. Background
   * recovery should set this to false so it never reloads the whole ledger. */
  includeRecords?: boolean;
  pageSize?: number;
}

export type TaskSchedulerAction = 'dispatch' | 'pause' | 'resume' | 'cancel' | 'retry' | 'reconcile';

/** Durable domain-task scheduler. Plan/Run remain canonical; this ledger only
 * records dispatch reservations and the execution reference used for recovery. */
export class TaskScheduler {
  private pumping = false;
  private readonly createLeaseMs = 30_000;
  constructor(
    private readonly domain: AeeisService,
    private readonly engine: AgentEngine,
    private readonly dispatcher: Dispatcher,
    private readonly repository: TaskDispatchRepository,
  ) {}

  async init(): Promise<void> { await this.repository.init(); }

  async get(id: string, scope: Ownership): Promise<TaskDispatchRecord> { return this.repository.get(id, scope); }
  async list(scope: Ownership, planId?: string): Promise<TaskDispatchRecord[]> { return this.repository.list(scope, planId); }
  async listAll(planId?: string): Promise<TaskDispatchRecord[]> { return this.repository.list(undefined, planId); }

  /**
   * Read the dispatch ledger for a Plan after the domain service has checked
   * that the caller can read that Plan through Room membership. Reservations
   * are owned by the Goal owner, so filtering by the caller's owner would
   * make a legitimate shared Room scheduler view appear empty.
   */
  async listVisibleForPlan(planId: string, scope: Ownership): Promise<TaskDispatchRecord[]> {
    await this.domain.getPlan(planId, scope.owner, scope.tenantId);
    return (await this.repository.list(undefined, planId)).filter(record => record.tenantId === scope.tenantId);
  }

  async schedulePlan(planId: string, scope: Ownership, options: TaskSchedulerOptions = {}): Promise<TaskDispatchRecord[]> {
    const plan = await this.domain.getPlan(planId, scope.owner, scope.tenantId);
    const records: TaskDispatchRecord[] = [];
    for (const node of plan.nodes.filter(candidate => candidate.status === 'ready')) {
      records.push(await this.scheduleNode(plan, node, scope, options));
    }
    await this.reconcilePlan(planId, scope);
    return this.repository.list(scope, planId);
  }

  async scheduleNodeById(planId: string, taskId: string, scope: Ownership, options: TaskSchedulerOptions = {}): Promise<TaskDispatchRecord> {
    const plan = await this.domain.getPlan(planId, scope.owner, scope.tenantId);
    const node = plan.nodes.find(candidate => candidate.id === taskId);
    if (!node) throw new Error(`Unknown task: ${taskId}`);
    if (node.status !== 'ready') {
      const existing = await this.repository.getForTask(planId, taskId, scope);
      if (existing) return this.reconcileRecord(existing, scope);
      throw new Error(`Task ${taskId} is not ready (current status: ${node.status})`);
    }
    return this.scheduleNode(plan, node, scope, options);
  }

  /** Apply a durable control action to the Run bound to one domain Task.
   * Business state is still changed by AgentEngine, which writes the domain
   * Receipt through its normal synchronization path; this method only makes
   * the dispatch ledger observable and wakes the selected runner. */
  async controlTask(planId: string, taskId: string, action: TaskSchedulerAction, scope: Ownership, body: unknown = {}): Promise<TaskDispatchRecord> {
    const plan = await this.domain.getPlan(planId, scope.owner, scope.tenantId);
    const node = plan.nodes.find(candidate => candidate.id === taskId);
    if (!node) throw new Error(`Unknown task: ${taskId}`);
    const existing = await this.repository.getForTask(planId, taskId, scope);
    if (action === 'dispatch') {
      if (!existing) return this.scheduleNodeById(planId, taskId, scope);
      const current = await this.reconcileRecord(existing, scope);
      if (current.state === 'queued' && node.status === 'ready') return this.scheduleNode(plan, node, scope);
      if (current.state === 'failed' && node.status === 'ready') return this.scheduleNode(plan, node, scope);
      if (['unknown', 'cancelled', 'succeeded'].includes(current.state)) return current;
      await this.dispatcher.notify(existing.runId);
      return this.reconcileRecord(await this.repository.get(existing.id, scope), scope);
    }
    if (!existing) throw new Error(`Task ${taskId} has no dispatch reservation`);
    await this.engine.command(existing.runId, action, body);
    if (action === 'retry') {
      const refreshed = await this.domain.getPlan(planId, scope.owner, scope.tenantId);
      const refreshedNode = refreshed.nodes.find(candidate => candidate.id === taskId);
      if (refreshedNode && refreshedNode.attempt > existing.taskAttempt) {
        await this.repository.mutate(existing.id, current => {
          current.taskAttempt = refreshedNode.attempt; current.dispatchAttempts += 1; delete current.lastError;
        }, scope);
      }
    }
    // A command may transition the Run to a waiting or terminal state before
    // the runner sees it. notify() is idempotent and lets Temporal signal or
    // start the same workflow, while LocalDispatcher resumes the same Run.
    if (action !== 'pause' && action !== 'cancel') await this.dispatcher.notify(existing.runId);
    return this.reconcileRecord(await this.repository.get(existing.id, scope), scope);
  }

  async reconcilePlan(planId: string, scope: Ownership, options: TaskReconcileOptions = {}): Promise<TaskDispatchRecord[]> {
    const missingRuns: TaskDispatchRecord[] = [];
    let sawSucceeded = false;
    const processRecord = async (record: TaskDispatchRecord): Promise<void> => {
      sawSucceeded ||= record.state === 'succeeded';
      // A process can create the Run and crash before notify() acknowledges
      // the dispatch. A queued reservation with an existing non-terminal Run
      // is therefore a distinct recovery case: wake that exact Run first,
      // then project its status. Without this branch the Run would merely be
      // observed as dispatched and the reservation would never be delivered.
      if (record.state === 'queued') {
        // The creator may still be between the durable reservation and Run
        // writes. Wait for its lease before attempting recovery; repository
        // reads alone cannot prove that the creator has stopped.
        if (record.createLease && Date.parse(record.createLease.expiresAt) > Date.now()) return;
        let run;
        try {
          run = await this.engine.repository.get(record.runId, scope);
        } catch (error) {
          if (!(error instanceof NotFound)) throw error;
          missingRuns.push(record);
          return;
        }
        try {
          if (['queued', 'planning', 'running', 'reviewing', 'needs_approval'].includes(run.status)) {
            await this.dispatcher.notify(record.runId);
          }
        } catch (error) {
          await this.repository.mutate(record.id, current => {
            current.lastError = error instanceof Error ? error.message : 'Task dispatch notification failed';
            current.state = 'queued';
          }, scope);
          throw error;
        }
      }
      // Dependent tasks are unlocked once after the bounded scan below. This
      // keeps newly created reservations out of the current page walk and
      // preserves the one-level-per-reconcile recovery behavior.
      const reconciled = await this.reconcileRecord(record, scope, false);
      sawSucceeded ||= reconciled.state === 'succeeded';
    };
    if (this.repository.listPage) {
      let cursor: string | undefined;
      const pageSize = options.pageSize ?? 100;
      do {
        const page = await this.repository.listPage(scope, pageSize, cursor, planId);
        for (const record of page.records) await processRecord(record);
        cursor = page.nextCursor;
      } while (cursor);
    } else {
      for (const record of await this.repository.list(scope, planId)) await processRecord(record);
    }
    const refreshed = await this.domain.getPlan(planId, scope.owner, scope.tenantId);
    // A crash after reservation but before Run creation leaves a queued
    // reservation with no Run to observe. Re-read readiness from the domain
    // and finish the original reservation; the idempotency key prevents a
    // second reservation from being created.
    for (const record of missingRuns) {
      const node = refreshed.nodes.find(candidate => candidate.id === record.taskId);
      if (node?.status === 'ready') await this.scheduleNode(refreshed, node, scope);
    }
    // A completed record unlocks dependent domain tasks. Continue from the
    // durable ledger after a crash between Run completion and this pump.
    if (sawSucceeded) {
      for (const node of refreshed.nodes.filter(candidate => candidate.status === 'ready')) await this.scheduleNode(refreshed, node, scope);
    }
    return options.includeRecords === false ? [] : this.repository.list(scope, planId);
  }

  async reconcileAll(scope: Ownership): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const sweep = async (): Promise<void> => {
      if (this.repository.listPage) {
        let cursor: string | undefined;
        do {
          const page = await this.repository.listPage(scope, 100, cursor);
          const planIds = [...new Set(page.records.map(record => record.planId))];
          for (const planId of planIds) await this.reconcilePlan(planId, scope, { includeRecords: false });
          cursor = page.nextCursor;
        } while (cursor);
      } else {
        const records = await this.repository.list(scope);
        const planIds = [...new Set(records.map(record => record.planId))];
        for (const planId of planIds) await this.reconcilePlan(planId, scope, { includeRecords: false });
      }
    };
    try {
      if (this.repository.withRecoveryLease) await this.repository.withRecoveryLease(scope, sweep);
      else await sweep();
    } finally { this.pumping = false; }
  }

  private async scheduleNode(plan: Plan, node: PlanNode, scope: Ownership, options: TaskSchedulerOptions = {}): Promise<TaskDispatchRecord> {
    const taskExecution = { domainPlanId: plan.id, taskId: node.id };
    const runId = taskRunIdFor(scope.owner, scope.tenantId, taskExecution);
    const goal = await this.domain.getGoal(plan.goalId, scope.owner, scope.tenantId);
    const createRequest = { ...options.runOptions, goal: `${goal.title}：${node.title}`, goalId: goal.id, taskExecution };
    const reserved = await this.repository.reserve({
      owner: scope.owner, tenantId: scope.tenantId, goalId: plan.goalId, planId: plan.id, taskId: node.id,
      taskAttempt: node.attempt, runId, workflowId: runId, runner: this.dispatcher.constructor.name, createRequest,
    });
    if (!reserved.created) {
      // A domain retry increments the node attempt while keeping the same
      // deterministic bound Run. Failed Runs may be explicitly retried here;
      // unknown Runs must first be reconciled with the provider and are never
      // silently resent by a scheduler pump.
      if (reserved.record.state === 'failed' && node.status === 'ready' && node.attempt > reserved.record.taskAttempt) {
        try {
          await this.engine.command(reserved.record.runId, 'retry', {});
          await this.repository.mutate(reserved.record.id, current => {
            current.taskAttempt = node.attempt; current.dispatchAttempts += 1; delete current.lastError;
          }, scope);
          await this.dispatcher.notify(reserved.record.runId);
        } catch (error) {
          await this.repository.mutate(reserved.record.id, current => { current.lastError = error instanceof Error ? error.message : 'Task retry failed'; }, scope);
          throw error;
        }
        return this.reconcileRecord(await this.repository.get(reserved.record.id, scope), scope);
      }
      if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(reserved.record.state)) return reserved.record;
    }
    // An acknowledged dispatch is already owned by its Run/Temporal workflow.
    // Reconciliation must observe it rather than signal it on every pump tick.
    if (!reserved.created && ['dispatched', 'waiting'].includes(reserved.record.state)) {
      return this.reconcileRecord(reserved.record, scope);
    }
    // Run creation and dispatch-ledger mutation are separate durable writes.
    // A recovery pump can therefore observe the queued reservation while the
    // original creator is still between those writes. Claim a short lease
    // before calling AgentEngine so a concurrent pump cannot create the same
    // deterministic Run with a different set of inputs. If the creator dies,
    // the expired lease is reclaimed on a later sweep.
    const leaseToken = randomUUID();
    let leaseClaimed = false;
    const leaseExpiresAt = new Date(Date.now() + this.createLeaseMs).toISOString();
    const leased = await this.repository.mutate(reserved.record.id, current => {
      if (!['queued'].includes(current.state)) return;
      if (current.createLease && Date.parse(current.createLease.expiresAt) > Date.now()) return;
      current.createLease = { token: leaseToken, expiresAt: leaseExpiresAt };
      leaseClaimed = true;
    }, scope);
    if (!leaseClaimed) return leased;
    try {
      // Adoption and creation share notification/acknowledgement below. A Run
      // existing on disk does not prove that any runner received it.
      let run: AgentRun | undefined;
      try { run = await this.engine.repository.get(leased.runId, scope); }
      catch (error) { if (!(error instanceof NotFound)) throw error; }
      if (!run) run = await this.engine.create(leased.createRequest ?? createRequest, scope.owner, scope.tenantId);
      // A creator returning after takeover must not acknowledge another
      // holder's work. The deterministic Run ID and frozen request also keep
      // creation idempotent when context preparation outlives the lease.
      const current = await this.repository.get(leased.id, scope);
      if (current.createLease?.token !== leaseToken) return current;
      if (['queued', 'planning', 'running', 'reviewing', 'needs_approval'].includes(run.status)) {
        await this.dispatcher.notify(run.id);
      }
      const observed = await this.engine.repository.get(run.id, scope);
      const acknowledged = await this.repository.mutate(leased.id, record => {
        if (record.createLease?.token !== leaseToken) return;
        record.dispatchAttempts += 1;
        record.lastRunStatus = observed.status;
        record.state = stateForRun(observed.status);
        delete record.lastError;
        delete record.createLease;
      }, scope);
      return acknowledged;
    } catch (error) {
      await this.repository.mutate(reserved.record.id, current => {
        if (current.createLease?.token !== leaseToken) return;
        current.lastError = error instanceof Error ? error.message : 'Task dispatch failed';
        current.state = 'queued'; delete current.createLease;
      }, scope);
      throw error;
    }
  }

  private async reconcileRecord(record: TaskDispatchRecord, scope: Ownership, unlockDependents = true): Promise<TaskDispatchRecord> {
    let run;
    try { run = await this.engine.repository.get(record.runId, scope); }
    catch (error) {
      if (error instanceof NotFound) return record;
      throw error;
    }
    const state = stateForRun(run.status);
    const next = await this.repository.mutate(record.id, current => {
      current.lastRunStatus = run.status;
      current.state = state;
      if (state !== 'queued') delete current.lastError;
    }, scope);
    if (unlockDependents && state === 'succeeded') {
      // This is safe to call repeatedly: the deterministic dispatch key and
      // Plan readiness check prevent duplicate downstream Runs.
      const plan = await this.domain.getPlan(record.planId, scope.owner, scope.tenantId);
      for (const node of plan.nodes.filter(candidate => candidate.status === 'ready')) await this.scheduleNode(plan, node, scope);
    }
    return next;
  }
}

function stateForRun(status: RunStatus): TaskDispatchState {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'unknown') return 'unknown';
  if (status === 'cancelled') return 'cancelled';
  if (['needs_input', 'waiting_external', 'paused'].includes(status)) return 'waiting';
  return 'dispatched';
}
