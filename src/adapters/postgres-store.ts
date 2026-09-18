import pg from 'pg';
import type { ContextManifest, Goal, Id, MemoryEntry, Plan, ProjectionIntent, RunReceipt } from '../contracts.js';
import type { AeeisStore } from './in-memory-store.js';
import { assertTaskCommit } from './task-commit.js';

/** PostgreSQL domain store. Each aggregate is kept as validated JSONB while
 * indexed ownership columns support the bounded Goal/Plan/Memory queries. */
export class PostgresAeeisStore implements AeeisStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS aeeis_goals (id text PRIMARY KEY, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_plans (id text PRIMARY KEY, goal_id text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_receipts (id text PRIMARY KEY, plan_id text NOT NULL, state jsonb NOT NULL, occurred_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_memories (id text PRIMARY KEY, goal_id text, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_context_manifests (id text PRIMARY KEY, state jsonb NOT NULL, created_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS aeeis_projection_intents (id text PRIMARY KEY, state jsonb NOT NULL, created_at timestamptz NOT NULL, status text NOT NULL);
      CREATE INDEX IF NOT EXISTS aeeis_plans_goal_idx ON aeeis_plans(goal_id);
      CREATE INDEX IF NOT EXISTS aeeis_receipts_plan_idx ON aeeis_receipts(plan_id);
      CREATE INDEX IF NOT EXISTS aeeis_memories_goal_idx ON aeeis_memories(goal_id);
    `);
  }

  async saveGoal(goal: Goal): Promise<void> {
    await this.pool.query('INSERT INTO aeeis_goals(id,state,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state, created_at=EXCLUDED.created_at', [goal.id, goal, goal.createdAt]);
  }
  async getGoal(id: Id): Promise<Goal | undefined> { return one<Goal>(this.pool, 'SELECT state FROM aeeis_goals WHERE id=$1', [id]); }
  async getGoals(): Promise<Goal[]> { return many<Goal>(this.pool, 'SELECT state FROM aeeis_goals ORDER BY created_at DESC'); }
  async savePlan(plan: Plan): Promise<void> {
    await this.pool.query('INSERT INTO aeeis_plans(id,goal_id,state,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET goal_id=EXCLUDED.goal_id, state=EXCLUDED.state, created_at=EXCLUDED.created_at', [plan.id, plan.goalId, plan, plan.createdAt]);
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
  async appendReceipt(receipt: RunReceipt): Promise<void> { await this.pool.query('INSERT INTO aeeis_receipts(id,plan_id,state,occurred_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [receipt.id, receipt.planId, receipt, receipt.occurredAt]); }
  async getReceipts(planId: Id): Promise<RunReceipt[]> { return many<RunReceipt>(this.pool, 'SELECT state FROM aeeis_receipts WHERE plan_id=$1 ORDER BY occurred_at,id', [planId]); }
  async saveMemory(memory: MemoryEntry): Promise<void> { await this.pool.query('INSERT INTO aeeis_memories(id,goal_id,state,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET goal_id=EXCLUDED.goal_id,state=EXCLUDED.state,created_at=EXCLUDED.created_at', [memory.id, memory.goalId ?? null, memory, memory.createdAt]); }
  async getMemories(goalId?: Id): Promise<MemoryEntry[]> { return goalId === undefined ? many<MemoryEntry>(this.pool, 'SELECT state FROM aeeis_memories ORDER BY created_at') : many<MemoryEntry>(this.pool, 'SELECT state FROM aeeis_memories WHERE goal_id=$1 ORDER BY created_at', [goalId]); }
  async saveContextManifest(manifest: ContextManifest): Promise<void> { await this.pool.query('INSERT INTO aeeis_context_manifests(id,state,created_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,created_at=EXCLUDED.created_at', [manifest.id, manifest, manifest.createdAt]); }
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
