import { scopedRecent, validateCollectionLimit } from './adapters/collection-query.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import pg from 'pg';
import type { Ownership } from './security/principal.js';
import { CollaborationService } from './collaboration-service.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';
import { digestProtocol } from './protocol.js';

const id = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const scopedIdentity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const eventIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/);
const isoDate = z.string().datetime({ offset: true });
const risk = z.enum(['low', 'medium', 'high']);
const source = z.enum(['system', 'api', 'feishu', 'hermes']);

export const collaborationTriggerEventTypeSchema = z.enum(['task.completed', 'task.failed', 'review.completed', 'external.message']);
export type CollaborationTriggerEventType = z.infer<typeof collaborationTriggerEventTypeSchema>;

const triggerContextSchema = z.object({
  classification: z.enum(['public', 'internal', 'confidential', 'private']),
  claims: z.array(z.object({ id, text: z.string().min(1).max(4000), evidenceRefs: z.array(id).max(100) }).strict()).max(200),
  artifactRefs: z.array(id).max(200),
  redactions: z.array(z.string().max(500)).max(100),
}).strict();

export const collaborationTriggerEventSchema = z.object({
  schemaVersion: z.literal('collaboration-trigger-event/1'), eventId: eventIdentity,
  eventType: collaborationTriggerEventTypeSchema, source, owner: scopedIdentity, tenantId: scopedIdentity,
  taskId: id, contextVersion: id, goal: z.string().max(8000).optional(),
  risk: risk.optional(), reviewConfidence: z.number().min(0).max(1).optional(),
  requiredDiversity: z.number().int().min(1).max(12).optional(),
  allowedAgentIds: z.array(id).max(12).optional(), context: triggerContextSchema.optional(),
  evidenceRefs: z.array(id).max(100).default([]), occurredAt: isoDate,
}).strict();
export type CollaborationTriggerEvent = z.infer<typeof collaborationTriggerEventSchema>;

const competitionActionSchema = z.object({
  type: z.literal('competition'), participantAgentIds: z.array(id).min(2).max(12), evaluatorAgentId: id,
  expectedResultType: z.string().min(1).max(200), maxRounds: z.number().int().min(1).max(12).default(2),
  maxCost: z.number().nonnegative().optional(), blindEvaluation: z.boolean().default(true),
  dispatch: z.enum(['create', 'run']).default('create'),
}).strict();
const debateActionSchema = z.object({
  type: z.literal('debate'), participantAgentIds: z.array(id).min(1).max(12),
  maxRounds: z.number().int().min(1).max(12).default(4), maxMessagesPerAgent: z.number().int().min(1).max(20).default(4),
  maxTotalMessages: z.number().int().min(1).max(100).optional(),
  dispatch: z.enum(['create', 'run']).default('create'),
}).strict();
export const collaborationTriggerActionSchema = z.discriminatedUnion('type', [competitionActionSchema, debateActionSchema]);
export type CollaborationTriggerAction = z.infer<typeof collaborationTriggerActionSchema>;

export const collaborationTriggerPolicySchema = z.object({
  schemaVersion: z.literal(1), id, owner: scopedIdentity, tenantId: scopedIdentity,
  name: z.string().trim().min(1).max(200), enabled: z.boolean(),
  eventTypes: z.array(collaborationTriggerEventTypeSchema).min(1).max(4),
  sources: z.array(source).min(1).max(4).optional(),
  riskAtLeast: risk.optional(), reviewConfidenceAtMost: z.number().min(0).max(1).optional(),
  requiredDiversityAtLeast: z.number().int().min(1).max(12).optional(),
  action: collaborationTriggerActionSchema, cooldownMs: z.number().int().min(0).max(31_536_000_000).default(0),
  createdAt: isoDate, updatedAt: isoDate,
}).strict();
export type CollaborationTriggerPolicy = z.infer<typeof collaborationTriggerPolicySchema>;

export const collaborationTriggerDecisionSchema = z.object({
  schemaVersion: z.literal(1), id, policyId: id, eventId: eventIdentity,
  owner: scopedIdentity, tenantId: scopedIdentity, state: z.enum(['started', 'triggered', 'failed']),
  actionType: z.enum(['competition', 'debate']), resourceId: id.optional(),
  dispatchState: z.enum(['not_requested', 'started', 'completed', 'unknown', 'failed']).default('not_requested'),
  dispatchError: z.string().max(4000).optional(),
  reason: z.string().max(4000).optional(), error: z.string().max(4000).optional(),
  startedAt: isoDate, completedAt: isoDate.optional(),
}).strict();
export type CollaborationTriggerDecision = z.infer<typeof collaborationTriggerDecisionSchema>;

export interface TriggerClaim { decision: CollaborationTriggerDecision; claimed: boolean }
export interface TriggerClaimGuard { policy: CollaborationTriggerPolicy; occurredAt: string }

function assertClaimScope(existing: CollaborationTriggerDecision, incoming: CollaborationTriggerDecision): void {
  if (!matchesScope(existing, incoming)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision');
}
function policyStillMatches(current: CollaborationTriggerPolicy | undefined, guard: TriggerClaimGuard, decision: CollaborationTriggerDecision): boolean {
  return Boolean(current?.enabled && matchesScope(current, decision) && current.id === decision.policyId
    // PostgreSQL JSONB is free to return object keys in a different order
    // from the request that supplied the policy. Compare the canonical
    // protocol digest, rather than serialized insertion order.
    && digestProtocol(current) === digestProtocol(collaborationTriggerPolicySchema.parse(guard.policy)));
}
function cooldownBlocks(previous: CollaborationTriggerDecision | undefined, guard: TriggerClaimGuard, now: string): boolean {
  // Event time prevents old replayed events from becoming new work when a
  // cooldown expires. Clamp future event timestamps to the admission clock.
  const eventTime = Math.min(Date.parse(isoDate.parse(guard.occurredAt)), Date.parse(now));
  return Boolean(previous && guard.policy.cooldownMs > 0 && eventTime - Date.parse(previous.startedAt) < guard.policy.cooldownMs);
}

export interface CollaborationTriggerStore {
  init(): Promise<void>;
  createPolicy(policy: CollaborationTriggerPolicy): Promise<void>;
  getPolicy(id: string, scope?: Ownership): Promise<CollaborationTriggerPolicy>;
  listPolicies(scope?: Ownership, limit?: number): Promise<CollaborationTriggerPolicy[]>;
  updatePolicy(id: string, change: (policy: CollaborationTriggerPolicy) => CollaborationTriggerPolicy, scope?: Ownership): Promise<CollaborationTriggerPolicy>;
  deletePolicy(id: string, scope?: Ownership): Promise<void>;
  claimDecision(decision: CollaborationTriggerDecision): Promise<TriggerClaim>;
  claimForPolicy(decision: CollaborationTriggerDecision, guard: TriggerClaimGuard): Promise<TriggerClaim | undefined>;
  getDecision(id: string, scope?: Ownership): Promise<CollaborationTriggerDecision>;
  updateDecision(id: string, change: (decision: CollaborationTriggerDecision) => CollaborationTriggerDecision, scope?: Ownership): Promise<CollaborationTriggerDecision>;
  listDecisions(scope?: Ownership, policyId?: string, limit?: number): Promise<CollaborationTriggerDecision[]>;
  close(): Promise<void>;
}

export class CollaborationTriggerNotFound extends Error {}

function matchesScope(value: { owner: string; tenantId: string }, scope?: Ownership): boolean {
  return scope === undefined || (value.owner === scope.owner && value.tenantId === scope.tenantId);
}

const triggerStateSchema = z.object({ policies: z.array(collaborationTriggerPolicySchema).max(1000), decisions: z.array(collaborationTriggerDecisionSchema).max(10000) }).strict();

/** File-backed trigger state. The writer lock makes a file deployment a
 * single-writer installation, while each decision is still idempotent. */
export class FileCollaborationTriggerStore implements CollaborationTriggerStore {
  private queue: Promise<unknown> = Promise.resolve();
  private state: z.infer<typeof triggerStateSchema> | undefined;
  private readonly lockPath: string;
  private readonly statePath: string;
  constructor(private readonly directory: string) { this.lockPath = join(directory, '.writer.lock'); this.statePath = join(directory, 'triggers.json'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const lock = await open(this.lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Collaboration trigger directory already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; await unlink(this.lockPath); return this.init(); }
    }
    try { this.state = triggerStateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.save({ policies: [], decisions: [] }); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  private snapshot(): z.infer<typeof triggerStateSchema> { if (!this.state) throw new Error('Repository is not open'); return this.state; }
  private async load(): Promise<z.infer<typeof triggerStateSchema>> { return structuredClone(this.snapshot()); }
  private async save(state: z.infer<typeof triggerStateSchema>): Promise<void> {
    const committed = structuredClone(triggerStateSchema.parse(state));
    const temporary = `${this.statePath}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(committed)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.statePath); this.state = committed; const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  createPolicy(policy: CollaborationTriggerPolicy): Promise<void> { return this.serial(async () => { const state = await this.load(); if (state.policies.some(item => item.id === policy.id)) throw new Error('Trigger policy already exists'); state.policies.push(collaborationTriggerPolicySchema.parse(policy)); await this.save(state); }); }
  async getPolicy(policyId: string, scope?: Ownership): Promise<CollaborationTriggerPolicy> { const policy = (await this.load()).policies.find(item => item.id === policyId); if (!policy || !matchesScope(policy, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); return policy; }
  async listPolicies(scope?: Ownership, limit?: number): Promise<CollaborationTriggerPolicy[]> { validateCollectionLimit(limit); const items = this.snapshot().policies.filter(item => matchesScope(item, scope)); return structuredClone(limit === undefined ? items : scopedRecent(items, item => item.updatedAt, scope, limit)); }
  updatePolicy(policyId: string, change: (policy: CollaborationTriggerPolicy) => CollaborationTriggerPolicy, scope?: Ownership): Promise<CollaborationTriggerPolicy> { return this.serial(async () => { const state = await this.load(); const index = state.policies.findIndex(item => item.id === policyId); if (index < 0 || !matchesScope(state.policies[index]!, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); const next = collaborationTriggerPolicySchema.parse(change(structuredClone(state.policies[index]!))); if (!matchesScope(next, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); state.policies[index] = next; await this.save(state); return next; }); }
  deletePolicy(policyId: string, scope?: Ownership): Promise<void> { return this.serial(async () => { const state = await this.load(); const index = state.policies.findIndex(item => item.id === policyId); if (index < 0 || !matchesScope(state.policies[index]!, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); state.policies.splice(index, 1); await this.save(state); }); }
  async claimDecision(decision: CollaborationTriggerDecision): Promise<TriggerClaim> {
    return (await this.claim(decision))!;
  }
  claimForPolicy(decision: CollaborationTriggerDecision, guard: TriggerClaimGuard): Promise<TriggerClaim | undefined> {
    return this.claim(decision, guard);
  }
  private claim(decision: CollaborationTriggerDecision, guard?: TriggerClaimGuard): Promise<TriggerClaim | undefined> {
    return this.serial(async () => {
      const parsed = collaborationTriggerDecisionSchema.parse(decision);
      const state = await this.load();
      const existing = state.decisions.find(item => item.policyId === parsed.policyId && item.eventId === parsed.eventId);
      if (existing) { assertClaimScope(existing, parsed); return { decision: existing, claimed: false }; }
      if (state.decisions.some(item => item.id === parsed.id)) throw new Error('Trigger decision ID conflict');
      if (guard) {
        const current = state.policies.find(item => item.id === parsed.policyId);
        if (!policyStillMatches(current, guard, parsed)) return undefined;
        parsed.startedAt = new Date().toISOString();
        const previous = state.decisions.filter(item => item.policyId === parsed.policyId && matchesScope(item, parsed) && (item.state === 'started' || item.state === 'triggered'))
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
        if (cooldownBlocks(previous, guard, parsed.startedAt)) return undefined;
      }
      state.decisions.push(parsed); await this.save(state);
      return { decision: parsed, claimed: true };
    });
  }

  async getDecision(decisionId: string, scope?: Ownership): Promise<CollaborationTriggerDecision> { const decision = (await this.load()).decisions.find(item => item.id === decisionId); if (!decision || !matchesScope(decision, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision'); return decision; }
  updateDecision(decisionId: string, change: (decision: CollaborationTriggerDecision) => CollaborationTriggerDecision, scope?: Ownership): Promise<CollaborationTriggerDecision> { return this.serial(async () => { const state = await this.load(); const index = state.decisions.findIndex(item => item.id === decisionId); if (index < 0 || !matchesScope(state.decisions[index]!, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision'); const next = collaborationTriggerDecisionSchema.parse(change(structuredClone(state.decisions[index]!))); if (!matchesScope(next, scope)) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision'); state.decisions[index] = next; await this.save(state); return next; }); }
  async listDecisions(scope?: Ownership, policyId?: string, limit?: number): Promise<CollaborationTriggerDecision[]> { validateCollectionLimit(limit); const items = this.snapshot().decisions.filter(item => matchesScope(item, scope) && (policyId === undefined || item.policyId === policyId)); return structuredClone(limit === undefined ? items : scopedRecent(items, item => item.startedAt, scope, limit)); }
  async close(): Promise<void> { await this.queue; this.state = undefined; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

/** PostgreSQL-backed trigger state. The unique policy/event key is the
 * cross-process idempotency boundary; the JSON state remains versioned and
 * auditable like the other AEEIS aggregates. */
export class PostgresCollaborationTriggerStore implements CollaborationTriggerStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'collaboration-triggers', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_collaboration_trigger_policies (id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL);
        CREATE INDEX IF NOT EXISTS aeeis_collaboration_trigger_policies_scope_idx ON aeeis_collaboration_trigger_policies(owner, tenant_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS aeeis_collaboration_trigger_decisions (id text PRIMARY KEY, policy_id text NOT NULL, event_id text NOT NULL, owner text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL, UNIQUE(policy_id, event_id));
        CREATE INDEX IF NOT EXISTS aeeis_collaboration_trigger_decisions_scope_idx ON aeeis_collaboration_trigger_decisions(owner, tenant_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS aeeis_trigger_cooldown_idx ON aeeis_collaboration_trigger_decisions(policy_id, owner, tenant_id, created_at DESC, id) WHERE state->>'state' IN ('started','triggered');
        CREATE INDEX IF NOT EXISTS aeeis_trigger_decisions_policy_recent_idx ON aeeis_collaboration_trigger_decisions(owner, tenant_id, policy_id, created_at DESC, id);
      `);
    });
  }
  async createPolicy(policy: CollaborationTriggerPolicy): Promise<void> { const parsed = collaborationTriggerPolicySchema.parse(policy); await this.pool.query('INSERT INTO aeeis_collaboration_trigger_policies(id,owner,tenant_id,state,updated_at) VALUES($1,$2,$3,$4,$5)', [parsed.id, parsed.owner, parsed.tenantId, parsed, parsed.updatedAt]); }
  async getPolicy(policyId: string, scope?: Ownership): Promise<CollaborationTriggerPolicy> { const row = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_collaboration_trigger_policies WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [policyId, scope.owner, scope.tenantId] : [policyId]); if (!row.rows[0]) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); return collaborationTriggerPolicySchema.parse(row.rows[0].state); }
  async listPolicies(scope?: Ownership, limit?: number): Promise<CollaborationTriggerPolicy[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    const rows = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_collaboration_trigger_policies${scope ? ' WHERE owner=$1 AND tenant_id=$2' : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return rows.rows.map(row => collaborationTriggerPolicySchema.parse(row.state));
  }
  async updatePolicy(policyId: string, change: (policy: CollaborationTriggerPolicy) => CollaborationTriggerPolicy, scope?: Ownership): Promise<CollaborationTriggerPolicy> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const row = await client.query<{ state: unknown; owner: string; tenant_id: string }>(`SELECT state,owner,tenant_id FROM aeeis_collaboration_trigger_policies WHERE id=$1 FOR UPDATE`, [policyId]); if (!row.rows[0] || (scope && (row.rows[0].owner !== scope.owner || row.rows[0].tenant_id !== scope.tenantId))) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); const current = collaborationTriggerPolicySchema.parse(row.rows[0].state); const next = collaborationTriggerPolicySchema.parse(change(structuredClone(current))); if (next.owner !== row.rows[0].owner || next.tenantId !== row.rows[0].tenant_id) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); await client.query('UPDATE aeeis_collaboration_trigger_policies SET owner=$2,tenant_id=$3,state=$4,updated_at=$5 WHERE id=$1', [policyId, next.owner, next.tenantId, next, next.updatedAt]); await client.query('COMMIT'); return next; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async deletePolicy(policyId: string, scope?: Ownership): Promise<void> { const result = await this.pool.query(`DELETE FROM aeeis_collaboration_trigger_policies WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [policyId, scope.owner, scope.tenantId] : [policyId]); if (!result.rowCount) throw new CollaborationTriggerNotFound('Unknown collaboration trigger policy'); }
  async claimDecision(decision: CollaborationTriggerDecision): Promise<TriggerClaim> {
    return (await this.claim(decision))!;
  }
  claimForPolicy(decision: CollaborationTriggerDecision, guard: TriggerClaimGuard): Promise<TriggerClaim | undefined> {
    return this.claim(decision, guard);
  }
  private async claim(decision: CollaborationTriggerDecision, guard?: TriggerClaimGuard): Promise<TriggerClaim | undefined> {
    const parsed = collaborationTriggerDecisionSchema.parse(decision);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize distinct events for the same policy, including raw recovery
      // claims. The lock ends before any model or external Agent invocation.
      await postgresAdvisoryXactLock(client, 'aeeis:trigger-claim', parsed.policyId);
      const duplicate = await client.query<{ state: unknown }>('SELECT state FROM aeeis_collaboration_trigger_decisions WHERE policy_id=$1 AND event_id=$2', [parsed.policyId, parsed.eventId]);
      if (duplicate.rows[0]) {
        const existing = collaborationTriggerDecisionSchema.parse(duplicate.rows[0].state);
        assertClaimScope(existing, parsed);
        await client.query('COMMIT'); return { decision: existing, claimed: false };
      }
      if (guard) {
        const row = await client.query<{ state: unknown }>('SELECT state FROM aeeis_collaboration_trigger_policies WHERE id=$1 FOR UPDATE', [parsed.policyId]);
        const current = row.rows[0] ? collaborationTriggerPolicySchema.parse(row.rows[0].state) : undefined;
        if (!policyStillMatches(current, guard, parsed)) { await client.query('COMMIT'); return undefined; }
        // PostgreSQL's clock is shared by competing API/Worker processes.
        const clock = await client.query<{ now: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
        parsed.startedAt = clock.rows[0]!.now;
        if (guard.policy.cooldownMs > 0) {
          const previous = await client.query<{ state: unknown }>(`SELECT state FROM aeeis_collaboration_trigger_decisions WHERE policy_id=$1 AND owner=$2 AND tenant_id=$3 AND state->>'state' IN ('started','triggered') ORDER BY created_at DESC, id LIMIT 1`, [parsed.policyId, parsed.owner, parsed.tenantId]);
          if (cooldownBlocks(previous.rows[0] ? collaborationTriggerDecisionSchema.parse(previous.rows[0].state) : undefined, guard, parsed.startedAt)) { await client.query('COMMIT'); return undefined; }
        }
      }
      await client.query('INSERT INTO aeeis_collaboration_trigger_decisions(id,policy_id,event_id,owner,tenant_id,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [parsed.id, parsed.policyId, parsed.eventId, parsed.owner, parsed.tenantId, parsed, parsed.startedAt]);
      await client.query('COMMIT'); return { decision: parsed, claimed: true };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async getDecision(decisionId: string, scope?: Ownership): Promise<CollaborationTriggerDecision> { const row = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_collaboration_trigger_decisions WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [decisionId, scope.owner, scope.tenantId] : [decisionId]); if (!row.rows[0]) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision'); return collaborationTriggerDecisionSchema.parse(row.rows[0].state); }
  async updateDecision(decisionId: string, change: (decision: CollaborationTriggerDecision) => CollaborationTriggerDecision, scope?: Ownership): Promise<CollaborationTriggerDecision> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const row = await client.query<{ state: unknown; owner: string; tenant_id: string }>(`SELECT state,owner,tenant_id FROM aeeis_collaboration_trigger_decisions WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''} FOR UPDATE`, scope ? [decisionId, scope.owner, scope.tenantId] : [decisionId]); if (!row.rows[0]) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision'); const current = collaborationTriggerDecisionSchema.parse(row.rows[0].state); const next = collaborationTriggerDecisionSchema.parse(change(current)); if (next.owner !== row.rows[0].owner || next.tenantId !== row.rows[0].tenant_id) throw new CollaborationTriggerNotFound('Unknown collaboration trigger decision'); await client.query('UPDATE aeeis_collaboration_trigger_decisions SET state=$2 WHERE id=$1', [decisionId, next]); await client.query('COMMIT'); return next; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async listDecisions(scope?: Ownership, policyId?: string, limit?: number): Promise<CollaborationTriggerDecision[]> {
    validateCollectionLimit(limit);
    const filters: string[] = []; const values: unknown[] = [];
    if (scope) { values.push(scope.owner, scope.tenantId); filters.push('owner=$1 AND tenant_id=$2'); }
    if (policyId !== undefined) { values.push(policyId); filters.push(`policy_id=$${values.length}`); }
    if (limit !== undefined) values.push(limit);
    const rows = await this.pool.query<{ state: unknown }>(`SELECT state FROM aeeis_collaboration_trigger_decisions${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return rows.rows.map(row => collaborationTriggerDecisionSchema.parse(row.state));
  }
  async close(): Promise<void> { await this.pool.end(); }
}

function riskRank(value: z.infer<typeof risk>): number { return value === 'high' ? 3 : value === 'medium' ? 2 : 1; }

export interface CollaborationTriggerResult { policyId: string; decision: CollaborationTriggerDecision; created: boolean; }

export const collaborationTriggerReconcileSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('resource_created'), resourceId: id, reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ outcome: z.literal('failed'), reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ outcome: z.literal('dispatch_completed'), reason: z.string().trim().min(1).max(4000), resourceId: id.optional() }).strict(),
  z.object({ outcome: z.literal('dispatch_failed'), reason: z.string().trim().min(1).max(4000) }).strict(),
]);
export type CollaborationTriggerReconcile = z.infer<typeof collaborationTriggerReconcileSchema>;

export interface CollaborationTriggerExecutors {
  runCompetition(id: string, scope: Ownership): Promise<unknown>;
  runDebate(id: string, scope: Ownership): Promise<unknown>;
}

/** Evaluates event facts and creates a durable Competition/Debate instance.
 * Model execution stays behind the existing explicit /run boundary, so a
 * trigger cannot silently spend budget merely because an external event was
 * delivered. A dispatcher can run the returned resource after reviewing the
 * durable decision. */
export class CollaborationTriggerService {
  private executors: CollaborationTriggerExecutors | undefined;
  constructor(private readonly store: CollaborationTriggerStore, private readonly collaboration: CollaborationService, executors?: CollaborationTriggerExecutors) { if (executors) this.executors = executors; }
  setExecutors(executors: CollaborationTriggerExecutors): void { this.executors = executors; }
  async createPolicy(input: unknown, scope: Ownership): Promise<CollaborationTriggerPolicy> {
    const body = z.object({ id, name: z.string().trim().min(1).max(200), enabled: z.boolean().default(true), eventTypes: z.array(collaborationTriggerEventTypeSchema).min(1).max(4), sources: z.array(source).min(1).max(4).optional(), riskAtLeast: risk.optional(), reviewConfidenceAtMost: z.number().min(0).max(1).optional(), requiredDiversityAtLeast: z.number().int().min(1).max(12).optional(), action: collaborationTriggerActionSchema, cooldownMs: z.number().int().min(0).max(31_536_000_000).default(0) }).strict().parse(input);
    const now = new Date().toISOString(); const policy = collaborationTriggerPolicySchema.parse({ schemaVersion: 1, ...body, owner: scope.owner, tenantId: scope.tenantId, createdAt: now, updatedAt: now });
    if (new Set(policy.action.participantAgentIds).size !== policy.action.participantAgentIds.length) throw new Error('Trigger action participants must be unique');
    if (policy.action.type === 'competition' && policy.action.participantAgentIds.includes(policy.action.evaluatorAgentId)) throw new Error('Trigger competition evaluator must be independent from participants');
    await this.store.createPolicy(policy); return policy;
  }
  listPolicies(scope?: Ownership, limit?: number): Promise<CollaborationTriggerPolicy[]> { return this.store.listPolicies(scope, limit); }
  getPolicy(idValue: string, scope?: Ownership): Promise<CollaborationTriggerPolicy> { return this.store.getPolicy(idValue, scope); }
  async updatePolicy(idValue: string, input: unknown, scope?: Ownership): Promise<CollaborationTriggerPolicy> {
    const change = z.object({ name: z.string().trim().min(1).max(200).optional(), enabled: z.boolean().optional(), eventTypes: z.array(collaborationTriggerEventTypeSchema).min(1).max(4).optional(), sources: z.array(source).min(1).max(4).nullable().optional(), riskAtLeast: risk.nullable().optional(), reviewConfidenceAtMost: z.number().min(0).max(1).nullable().optional(), requiredDiversityAtLeast: z.number().int().min(1).max(12).nullable().optional(), cooldownMs: z.number().int().min(0).max(31_536_000_000).optional() }).strict().parse(input);
    return this.store.updatePolicy(idValue, current => { const next = { ...current, ...change, ...(change.sources === null ? { sources: undefined } : {}), ...(change.riskAtLeast === null ? { riskAtLeast: undefined } : {}), ...(change.reviewConfidenceAtMost === null ? { reviewConfidenceAtMost: undefined } : {}), ...(change.requiredDiversityAtLeast === null ? { requiredDiversityAtLeast: undefined } : {}), updatedAt: new Date().toISOString() }; return collaborationTriggerPolicySchema.parse(next); }, scope);
  }
  deletePolicy(idValue: string, scope?: Ownership): Promise<void> { return this.store.deletePolicy(idValue, scope); }
  listDecisions(scope?: Ownership, policyId?: string, limit?: number): Promise<CollaborationTriggerDecision[]> { return this.store.listDecisions(scope, policyId, limit); }

  async reconcileDecision(decisionId: string, input: unknown, scope?: Ownership): Promise<CollaborationTriggerDecision> {
    const body = collaborationTriggerReconcileSchema.parse(input);
    const current = await this.store.getDecision(decisionId, scope);
    if (current.state === 'failed' || current.dispatchState === 'completed' || current.dispatchState === 'failed') throw new Error('Collaboration trigger decision is already terminal');
    const now = new Date().toISOString();
    return this.store.updateDecision(decisionId, decision => {
      if (decision.state === 'failed' || decision.dispatchState === 'completed' || decision.dispatchState === 'failed') throw new Error('Collaboration trigger decision changed before reconciliation');
      if (body.outcome === 'resource_created') {
        if (decision.state !== 'started' || decision.resourceId) throw new Error('Only a started decision without a resource can bind a created resource');
        return { ...decision, state: 'triggered', resourceId: body.resourceId, dispatchState: 'not_requested', completedAt: now, reason: body.reason, error: undefined };
      }
      if (body.outcome === 'failed') {
        if (decision.state !== 'started' || decision.resourceId) throw new Error('Creation failure reconciliation requires a started decision without a resource');
        return { ...decision, state: 'failed', dispatchState: 'failed', completedAt: now, error: body.reason, reason: undefined };
      }
      if (decision.state !== 'triggered' || !decision.resourceId) throw new Error('Dispatch reconciliation requires a triggered decision with a resource');
      if (body.outcome === 'dispatch_completed') return { ...decision, dispatchState: 'completed', ...(body.resourceId === undefined ? {} : { resourceId: body.resourceId }), dispatchError: undefined, reason: body.reason };
      return { ...decision, dispatchState: 'failed', dispatchError: body.reason, reason: undefined };
    }, scope);
  }

  async evaluate(input: unknown, scope?: Ownership): Promise<CollaborationTriggerResult[]> {
    const event = collaborationTriggerEventSchema.parse(input);
    if (scope && (event.owner !== scope.owner || event.tenantId !== scope.tenantId)) throw new Error('Trigger event ownership does not match the authenticated principal');
    const eventScope = { owner: event.owner, tenantId: event.tenantId };
    const policies = await this.store.listPolicies(eventScope); const results: CollaborationTriggerResult[] = [];
    for (const policy of policies) {
      if (!this.matches(policy, event)) continue;
      const decisionId = `trigger_${createHash('sha256').update(`${policy.id}:${event.eventId}`).digest('hex').slice(0, 32)}`;
      const startedAt = new Date().toISOString();
      const claimed = await this.store.claimForPolicy({ schemaVersion: 1, id: decisionId, policyId: policy.id, eventId: event.eventId, owner: event.owner, tenantId: event.tenantId, state: 'started', actionType: policy.action.type, dispatchState: 'not_requested', startedAt }, { policy, occurredAt: event.occurredAt });
      if (!claimed) continue;
      if (!claimed.claimed) { results.push({ policyId: policy.id, decision: claimed.decision, created: false }); continue; }
      try {
        const resource = policy.action.type === 'competition'
          ? await this.collaboration.createCompetition({ schemaVersion: 'competition-brief/1', taskId: event.taskId, contextVersion: event.contextVersion, goal: event.goal ?? `Triggered collaboration for ${event.taskId}`, participantAgentIds: policy.action.participantAgentIds, expectedResultType: policy.action.expectedResultType, maxRounds: policy.action.maxRounds, ...(policy.action.maxCost === undefined ? {} : { maxCost: policy.action.maxCost }), blindEvaluation: policy.action.blindEvaluation, ...(event.context ? { context: event.context } : {}) }, eventScope)
          : await this.collaboration.createDebate({ taskId: event.taskId, contextVersion: event.contextVersion, ...(event.goal === undefined ? {} : { goal: event.goal }), participantAgentIds: policy.action.participantAgentIds, maxRounds: policy.action.maxRounds, maxMessagesPerAgent: policy.action.maxMessagesPerAgent, ...(policy.action.maxTotalMessages === undefined ? {} : { maxTotalMessages: policy.action.maxTotalMessages }), ...(event.context ? { context: event.context } : {}) }, eventScope);
        let decision = await this.store.updateDecision(decisionId, current => ({ ...current, state: 'triggered', resourceId: resource.id, dispatchState: policy.action.dispatch === 'run' ? 'started' : 'not_requested', completedAt: new Date().toISOString(), reason: `Created ${policy.action.type} from ${event.eventType}` }));
        if (policy.action.dispatch === 'run') {
          try {
            if (!this.executors) throw new Error('Collaboration trigger execution is not configured');
            if (policy.action.type === 'competition') await this.executors.runCompetition(resource.id, eventScope);
            else await this.executors.runDebate(resource.id, eventScope);
            decision = await this.store.updateDecision(decisionId, current => ({ ...current, dispatchState: 'completed', dispatchError: undefined }));
          } catch (error) {
            decision = await this.store.updateDecision(decisionId, current => ({ ...current, dispatchState: 'unknown', dispatchError: error instanceof Error ? error.message : 'Triggered collaboration dispatch failed' }));
          }
        }
        results.push({ policyId: policy.id, decision, created: true });
      } catch (error) {
        const decision = await this.store.updateDecision(decisionId, current => ({ ...current, state: 'failed', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Collaboration trigger failed' }));
        results.push({ policyId: policy.id, decision, created: true });
      }
    }
    return results;
  }

  private matches(policy: CollaborationTriggerPolicy, event: CollaborationTriggerEvent): boolean {
    if (!policy.enabled || !policy.eventTypes.includes(event.eventType) || (policy.sources && !policy.sources.includes(event.source))) return false;
    if (policy.riskAtLeast && (!event.risk || riskRank(event.risk) < riskRank(policy.riskAtLeast))) return false;
    if (policy.reviewConfidenceAtMost !== undefined && (event.reviewConfidence === undefined || event.reviewConfidence > policy.reviewConfidenceAtMost)) return false;
    if (policy.requiredDiversityAtLeast !== undefined && (event.requiredDiversity === undefined || event.requiredDiversity < policy.requiredDiversityAtLeast)) return false;
    if (event.requiredDiversity !== undefined && policy.action.participantAgentIds.length < event.requiredDiversity) return false;
    if (event.allowedAgentIds && policy.action.participantAgentIds.some(agentId => !event.allowedAgentIds!.includes(agentId))) return false;
    return true;
  }
}
