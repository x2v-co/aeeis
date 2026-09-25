import { decodeCollectionCursor, decodeVersionCursor, encodeCollectionCursor, encodeVersionCursor, validateCollectionLimit } from './collection-query.js';
import type { Ownership } from '../security/principal.js';
import pg from 'pg';
import type { ContextManifest, Goal, Id, MemoryEntry, Plan, ProjectionIntent, RunReceipt, Room } from '../contracts.js';
import type { AeeisStore, RoomPage } from './in-memory-store.js';
import { assertMemoryCommit, assertRoomCommit, assertTaskCommit } from './task-commit.js';
import { withPostgresMigrationLock } from './postgres-migration.js';

/** PostgreSQL domain store. Each aggregate is kept as validated JSONB while
 * indexed ownership columns support the bounded Goal/Plan/Memory queries. */
export class PostgresAeeisStore implements AeeisStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'domain', async client => { await client.query(`
      CREATE TABLE IF NOT EXISTS aeeis_goals (id text PRIMARY KEY, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS aeeis_goals_recent_idx ON aeeis_goals ((COALESCE(state->>'owner','owner')), (COALESCE(state->>'tenantId','local')), created_at DESC, id);
      CREATE TABLE IF NOT EXISTS aeeis_rooms (id text PRIMARY KEY, state jsonb NOT NULL, owner text, tenant_id text, created_at timestamptz NOT NULL);
      ALTER TABLE aeeis_rooms ADD COLUMN IF NOT EXISTS updated_at timestamptz;
      UPDATE aeeis_rooms SET updated_at=(state->>'updatedAt')::timestamptz WHERE updated_at IS NULL;
      ALTER TABLE aeeis_rooms ALTER COLUMN updated_at SET NOT NULL;
      CREATE INDEX IF NOT EXISTS aeeis_rooms_recent_idx ON aeeis_rooms ((COALESCE(tenant_id, 'local')), updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS aeeis_plans (id text PRIMARY KEY, goal_id text NOT NULL, version integer NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_receipts (id text PRIMARY KEY, plan_id text NOT NULL, state jsonb NOT NULL, occurred_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_memories (id text PRIMARY KEY, goal_id text, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_context_manifests (id text PRIMARY KEY, goal_id text, owner text, tenant_id text, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_projection_intents (id text PRIMARY KEY, state jsonb NOT NULL, created_at timestamptz NOT NULL, status text NOT NULL);
      CREATE INDEX IF NOT EXISTS aeeis_plans_goal_idx ON aeeis_plans(goal_id);
      ALTER TABLE aeeis_plans ADD COLUMN IF NOT EXISTS version integer;
      UPDATE aeeis_plans SET version=COALESCE(version, (state->>'version')::integer) WHERE version IS NULL;
      ALTER TABLE aeeis_plans ALTER COLUMN version SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS aeeis_plans_goal_version_idx ON aeeis_plans(goal_id, version);
      CREATE INDEX IF NOT EXISTS aeeis_receipts_plan_idx ON aeeis_receipts(plan_id);
      CREATE INDEX IF NOT EXISTS aeeis_memories_goal_idx ON aeeis_memories(goal_id);
      ALTER TABLE aeeis_memories ADD COLUMN IF NOT EXISTS owner text;
      ALTER TABLE aeeis_memories ADD COLUMN IF NOT EXISTS tenant_id text;
      UPDATE aeeis_memories SET owner=COALESCE(owner, state->>'owner', 'owner'), tenant_id=COALESCE(tenant_id, state->>'tenantId', 'local') WHERE owner IS NULL OR tenant_id IS NULL;
      CREATE INDEX IF NOT EXISTS aeeis_memories_owner_idx ON aeeis_memories(tenant_id, owner, goal_id);
      ALTER TABLE aeeis_context_manifests ADD COLUMN IF NOT EXISTS goal_id text;
      ALTER TABLE aeeis_context_manifests ADD COLUMN IF NOT EXISTS owner text;
      ALTER TABLE aeeis_context_manifests ADD COLUMN IF NOT EXISTS tenant_id text;
      UPDATE aeeis_context_manifests SET goal_id=COALESCE(goal_id, state->>'goalId'), owner=COALESCE(owner, state->>'owner', 'owner'), tenant_id=COALESCE(tenant_id, state->>'tenantId', 'local') WHERE goal_id IS NULL OR owner IS NULL OR tenant_id IS NULL;
      CREATE INDEX IF NOT EXISTS aeeis_context_manifests_scope_idx ON aeeis_context_manifests(tenant_id, owner, goal_id, created_at);
    `); });
  }

  async commitRoomCreation(room: Room, intents: ProjectionIntent[] = []): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO aeeis_rooms(id,state,owner,tenant_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)', [room.id, room, room.owner ?? 'owner', room.tenantId ?? 'local', room.createdAt, room.updatedAt]);
      for (const intent of intents) await client.query('INSERT INTO aeeis_projection_intents(id,state,created_at,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [intent.id, intent, intent.createdAt, intent.status]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async commitRoomUpdate(expected: Room, next: Room, intents: ProjectionIntent[] = []): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ state: Room }>('SELECT state FROM aeeis_rooms WHERE id=$1 FOR UPDATE', [expected.id]);
      assertRoomCommit(locked.rows[0]?.state, expected, next);
      await client.query('UPDATE aeeis_rooms SET state=$2, owner=$3, tenant_id=$4, updated_at=$5 WHERE id=$1', [next.id, next, next.owner ?? 'owner', next.tenantId ?? 'local', next.updatedAt]);
      for (const intent of intents) await client.query('INSERT INTO aeeis_projection_intents(id,state,created_at,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [intent.id, intent, intent.createdAt, intent.status]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getRoom(id: Id): Promise<Room | undefined> { return one<Room>(this.pool, 'SELECT state FROM aeeis_rooms WHERE id=$1', [id]); }
  async getRooms(scope?: Ownership, limit?: number, memberRoomIds?: string[]): Promise<Room[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.tenantId, scope.owner, memberRoomIds ?? []] : [];
    if (limit !== undefined) values.push(limit);
    return many<Room>(this.pool, `SELECT state FROM aeeis_rooms${scope ? " WHERE COALESCE(tenant_id, 'local')=$1 AND (COALESCE(owner, 'owner')=$2 OR id=ANY($3::text[]))" : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
  }
  async getRoomsPage(limit: number, cursor?: string): Promise<RoomPage> {
    validateCollectionLimit(limit);
    const parsed = decodeCollectionCursor(cursor);
    const values: unknown[] = [];
    let where = '';
    if (parsed) { values.push(parsed.timestamp, parsed.id); where = ' WHERE updated_at < $1 OR (updated_at = $1 AND id > $2)'; }
    values.push(limit + 1);
    const result = await this.pool.query<{ state: Room }>(`SELECT state FROM aeeis_rooms${where} ORDER BY updated_at DESC, id LIMIT $${values.length}`, values);
    const page = result.rows.map(row => row.state); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { rooms: visible, ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }

  async commitGoalCreation(goal: Goal, intents: ProjectionIntent[] = []): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO aeeis_goals(id,state,created_at) VALUES($1,$2,$3)', [goal.id, goal, goal.createdAt]);
      for (const intent of intents) await client.query('INSERT INTO aeeis_projection_intents(id,state,created_at,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [intent.id, intent, intent.createdAt, intent.status]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async commitPlanCreation(plan: Plan, intents: ProjectionIntent[] = [], reopenGoal = false): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const goal = await client.query('SELECT id FROM aeeis_goals WHERE id=$1 FOR UPDATE', [plan.goalId]);
      if (!goal.rowCount) throw new Error('Plan creation references missing goal');
      await client.query('INSERT INTO aeeis_plans(id,goal_id,version,state,created_at) VALUES($1,$2,$3,$4,$5)', [plan.id, plan.goalId, plan.version, plan, plan.createdAt]);
      for (const intent of intents) await client.query('INSERT INTO aeeis_projection_intents(id,state,created_at,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [intent.id, intent, intent.createdAt, intent.status]);
      if (reopenGoal) await client.query(`UPDATE aeeis_goals SET state=jsonb_set(state, '{status}', '"active"'::jsonb) WHERE id=$1`, [plan.goalId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async saveGoal(goal: Goal): Promise<void> {
    await this.pool.query('INSERT INTO aeeis_goals(id,state,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state, created_at=EXCLUDED.created_at', [goal.id, goal, goal.createdAt]);
  }
  async getGoal(id: Id): Promise<Goal | undefined> { return one<Goal>(this.pool, 'SELECT state FROM aeeis_goals WHERE id=$1', [id]); }
  async getGoals(scope?: Ownership, limit?: number): Promise<Goal[]> { validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    return many<Goal>(this.pool, `SELECT state FROM aeeis_goals${scope ? " WHERE COALESCE(state->>'owner','owner')=$1 AND COALESCE(state->>'tenantId','local')=$2" : ''} ORDER BY created_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values); }
  async getReadableGoals(scope: Ownership, memberRoomIds: readonly string[]): Promise<Goal[]> {
    return many<Goal>(this.pool, `SELECT state FROM aeeis_goals
      WHERE COALESCE(state->>'tenantId','local')=$1
        AND (COALESCE(state->>'owner','owner')=$2 OR COALESCE(state->>'roomId','') = ANY($3::text[]))`, [scope.tenantId, scope.owner, [...new Set(memberRoomIds)]]);
  }
  async getGoalsPage(scope: Ownership, limit: number, cursor?: string) {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId];
    const cursorClause = pageCursor ? ` AND (created_at < $3::timestamptz OR (created_at = $3::timestamptz AND id > $4))` : '';
    if (pageCursor) values.push(pageCursor.timestamp, pageCursor.id);
    values.push(limit + 1);
    const result = await this.pool.query<{ state: Goal }>(`SELECT state FROM aeeis_goals WHERE COALESCE(state->>'owner','owner')=$1 AND COALESCE(state->>'tenantId','local')=$2${cursorClause} ORDER BY created_at DESC, id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit; const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { goals: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.state.createdAt, id: visible.at(-1)!.state.id }) } : {}) };
  }
  async savePlan(plan: Plan): Promise<void> {
    await this.pool.query('INSERT INTO aeeis_plans(id,goal_id,version,state,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET goal_id=EXCLUDED.goal_id, version=EXCLUDED.version, state=EXCLUDED.state, created_at=EXCLUDED.created_at', [plan.id, plan.goalId, plan.version, plan, plan.createdAt]);
  }
  async commitTaskTransition(expected: Plan, next: Plan, receipt: RunReceipt, intents: ProjectionIntent[] = []): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ state: Plan }>('SELECT state FROM aeeis_plans WHERE id=$1 FOR UPDATE', [expected.id]);
      assertTaskCommit(locked.rows[0]?.state, expected, next, receipt);
      const goal = await client.query('SELECT id FROM aeeis_goals WHERE id=$1 FOR UPDATE', [next.goalId]);
      if (!goal.rowCount) throw new Error('Task commit references missing goal');
      await client.query('UPDATE aeeis_plans SET state=$2 WHERE id=$1', [next.id, next]);
      await client.query('INSERT INTO aeeis_receipts(id,plan_id,state,occurred_at) VALUES($1,$2,$3,$4)', [receipt.id, receipt.planId, receipt, receipt.occurredAt]);
      for (const intent of intents) await client.query('INSERT INTO aeeis_projection_intents(id,state,created_at,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [intent.id, intent, intent.createdAt, intent.status]);
      if (next.nodes.every(node => node.status === 'succeeded')) {
        await client.query(`UPDATE aeeis_goals SET state=jsonb_set(state, '{status}', '"completed"'::jsonb) WHERE id=$1`, [next.goalId]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async getPlan(id: Id): Promise<Plan | undefined> { return one<Plan>(this.pool, 'SELECT state FROM aeeis_plans WHERE id=$1', [id]); }
  async getPlans(goalId?: Id): Promise<Plan[]> { return goalId === undefined ? many<Plan>(this.pool, 'SELECT state FROM aeeis_plans ORDER BY created_at') : many<Plan>(this.pool, 'SELECT state FROM aeeis_plans WHERE goal_id=$1 ORDER BY created_at', [goalId]); }
  async getPlansPage(goalId: Id, limit: number, cursor?: string) {
    validateCollectionLimit(limit);
    const pageCursor = decodeVersionCursor(cursor);
    const values: unknown[] = [goalId];
    const cursorClause = pageCursor ? ` AND (version < $2 OR (version = $2 AND id > $3))` : '';
    if (pageCursor) values.push(pageCursor.version, pageCursor.id);
    values.push(limit + 1);
    const result = await this.pool.query<{ state: Plan }>(`SELECT state FROM aeeis_plans WHERE goal_id=$1${cursorClause} ORDER BY version DESC, id ASC LIMIT $${values.length}`, values);
    const hasMore = result.rows.length > limit; const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { plans: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodeVersionCursor({ version: visible.at(-1)!.state.version, id: visible.at(-1)!.state.id }) } : {}) };
  }
  async appendReceipt(receipt: RunReceipt): Promise<void> { await this.pool.query('INSERT INTO aeeis_receipts(id,plan_id,state,occurred_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [receipt.id, receipt.planId, receipt, receipt.occurredAt]); }
  async getReceipts(planId: Id): Promise<RunReceipt[]> { return many<RunReceipt>(this.pool, 'SELECT state FROM aeeis_receipts WHERE plan_id=$1 ORDER BY occurred_at,id', [planId]); }
  async saveMemory(memory: MemoryEntry): Promise<void> { await this.pool.query('INSERT INTO aeeis_memories(id,goal_id,owner,tenant_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET goal_id=EXCLUDED.goal_id,owner=EXCLUDED.owner,tenant_id=EXCLUDED.tenant_id,state=EXCLUDED.state,created_at=EXCLUDED.created_at', [memory.id, memory.goalId ?? null, memory.owner ?? 'owner', memory.tenantId ?? 'local', memory, memory.createdAt]); }
  async commitMemoryUpdate(expected: MemoryEntry, next: MemoryEntry): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: MemoryEntry }>('SELECT state FROM aeeis_memories WHERE id=$1 FOR UPDATE', [expected.id]);
      assertMemoryCommit(result.rows[0]?.state, expected, next);
      await client.query('UPDATE aeeis_memories SET goal_id=$2, owner=$3, tenant_id=$4, state=$5 WHERE id=$1', [next.id, next.goalId ?? null, next.owner ?? 'owner', next.tenantId ?? 'local', next]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async commitMemoryRevision(previous: MemoryEntry, next: MemoryEntry): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ state: MemoryEntry }>('SELECT state FROM aeeis_memories WHERE id=$1 FOR UPDATE', [previous.id]);
      assertMemoryCommit(result.rows[0]?.state, previous, previous);
      await client.query('UPDATE aeeis_memories SET state=state || jsonb_build_object(\'state\', \'superseded\', \'updatedAt\', $2::text) WHERE id=$1', [previous.id, next.updatedAt]);
      await client.query('INSERT INTO aeeis_memories(id,goal_id,owner,tenant_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6)', [next.id, next.goalId ?? null, next.owner ?? 'owner', next.tenantId ?? 'local', next, next.createdAt]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async getMemories(goalId?: Id, limit?: number): Promise<MemoryEntry[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = goalId === undefined ? [] : [goalId];
    if (limit !== undefined) values.push(limit);
    const where = goalId === undefined ? '' : ' WHERE goal_id=$1';
    const order = limit === undefined ? ' ORDER BY created_at, id' : ' ORDER BY (state->>\'updatedAt\')::timestamptz DESC NULLS LAST, id';
    return many<MemoryEntry>(this.pool, `SELECT state FROM aeeis_memories${where}${order}${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
  }
  async saveContextManifest(manifest: ContextManifest): Promise<void> { await this.pool.query('INSERT INTO aeeis_context_manifests(id,goal_id,owner,tenant_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET goal_id=EXCLUDED.goal_id,owner=EXCLUDED.owner,tenant_id=EXCLUDED.tenant_id,state=EXCLUDED.state,created_at=EXCLUDED.created_at', [manifest.id, manifest.goalId ?? null, manifest.owner ?? 'owner', manifest.tenantId ?? 'local', manifest, manifest.createdAt]); }
  async getContextManifest(id: Id): Promise<ContextManifest | undefined> { return one<ContextManifest>(this.pool, 'SELECT state FROM aeeis_context_manifests WHERE id=$1', [id]); }
  async listProjectionIntents(): Promise<ProjectionIntent[]> { return many<ProjectionIntent>(this.pool, "SELECT state FROM aeeis_projection_intents WHERE status='pending' ORDER BY created_at,id"); }
  async markProjectionIntentDispatched(id: Id, dispatchedAt = new Date().toISOString()): Promise<void> { await this.pool.query("UPDATE aeeis_projection_intents SET status='dispatched', state=state || jsonb_build_object('status','dispatched','dispatchedAt',$2::text) WHERE id=$1", [id, dispatchedAt]); }
  async close(): Promise<void> { await this.pool.end(); }
}

async function one<T>(pool: pg.Pool, query: string, values: unknown[] = []): Promise<T | undefined> {
  const result = await pool.query<{ state: T }>(query, values);
  return result.rows[0]?.state;
}
async function many<T>(pool: pg.Pool, query: string, values: unknown[] = []): Promise<T[]> {
  const result = await pool.query<{ state: T }>(query, values);
  return result.rows.map(row => row.state);
}
