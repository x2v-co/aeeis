import pg from 'pg';
import { withPostgresMigrationLock } from './postgres-migration.js';
import { postgresAdvisoryXactLock } from './postgres-lock.js';
import {
  grantRecordSchema,
  grantBudgetSchema,
  grantLedgerGrantSchema,
  grantUsageSchema,
  type GrantBudget,
  type GrantLedger,
  type GrantLedgerGrant,
  type GrantUsage,
  type GrantRecord,
  type GrantRegistration,
  type GrantAuthorizationReceipt,
  type GrantLifecycleStatus,
} from '../agent-ledger.js';
import { delegationGrantSchema, digestProtocol } from '../protocol.js';

/** PostgreSQL-backed Grant budget ledger.
 * Every reserve/settle operation locks exactly one grant row, so concurrent
 * Agent calls cannot bypass calls, token, or money budgets. The entry state is
 * kept durable because unknown outcomes must be reconciled after restart.
 */
export class PostgresGrantLedger implements GrantLedger {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'agent-grant-ledger', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_agent_grant_ledger (
          grant_id text PRIMARY KEY,
          budget jsonb NOT NULL,
          used_calls integer NOT NULL,
          used_tokens bigint NOT NULL,
          used_money numeric NOT NULL,
          entries jsonb NOT NULL,
          updated_at timestamptz NOT NULL
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_agent_grant_registry (
          grant_id text PRIMARY KEY,
          digest text NOT NULL,
          subject_agent_id text NOT NULL,
          issuer_agent_id text NOT NULL,
          task_id text NOT NULL,
          resource_refs jsonb NOT NULL,
          revocation_ref text NOT NULL,
          issued_at text NOT NULL,
          expires_at text NOT NULL,
          status text NOT NULL CHECK (status IN ('active','revoked','expired')),
          registered_at text NOT NULL,
          revoked_at text,
          revoked_by text,
          revocation_reason text,
          history jsonb NOT NULL
        );
      `);
    });
  }

  async ensureGrant(registration: GrantRegistration): Promise<GrantRecord> {
    const grant = delegationGrantSchema.parse(registration.grant);
    if (!/^[a-f0-9]{64}$/.test(registration.digest) || registration.digest !== digestProtocol(grant)) throw new Error('Delegation grant digest does not match its contents');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await postgresAdvisoryXactLock(client, 'aeeis:grant', grant.grantId);
      const result = await client.query('SELECT * FROM aeeis_agent_grant_registry WHERE grant_id=$1 FOR UPDATE', [grant.grantId]);
      if (result.rows[0]) {
        const current = rowToRecord(result.rows[0]);
        if (current.digest !== registration.digest || current.subjectAgentId !== grant.subjectAgentId || current.issuerAgentId !== grant.issuerAgentId || current.taskId !== grant.taskId || current.revocationRef !== grant.revocationRef) throw new Error('Delegation grant changed for an existing grant');
        await client.query('COMMIT'); return current;
      }
      if (new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
      const registeredAt = registration.registeredAt ?? new Date().toISOString();
      const record: GrantRecord = { grantId: grant.grantId, digest: registration.digest, subjectAgentId: grant.subjectAgentId, issuerAgentId: grant.issuerAgentId, taskId: grant.taskId, resourceRefs: [...grant.resourceRefs], revocationRef: grant.revocationRef, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt, status: 'active', registeredAt, history: [{ status: 'active', at: registeredAt, actor: 'aeeis' }] };
      await client.query(`INSERT INTO aeeis_agent_grant_registry(grant_id,digest,subject_agent_id,issuer_agent_id,task_id,resource_refs,revocation_ref,issued_at,expires_at,status,registered_at,history) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb)`, [record.grantId, record.digest, record.subjectAgentId, record.issuerAgentId, record.taskId, JSON.stringify(record.resourceRefs), record.revocationRef, record.issuedAt, record.expiresAt, record.status, record.registeredAt, JSON.stringify(record.history)]);
      await client.query('COMMIT'); return record;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getGrant(grantId: string): Promise<GrantRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await postgresAdvisoryXactLock(client, 'aeeis:grant', grantId);
      const result = await client.query('SELECT * FROM aeeis_agent_grant_registry WHERE grant_id=$1 FOR UPDATE', [grantId]);
      if (!result.rows[0]) { await client.query('COMMIT'); return undefined; }
      const record = rowToRecord(result.rows[0]);
      if (record.status === 'active' && new Date(record.expiresAt).getTime() <= Date.now()) {
        record.status = 'expired'; record.history.push({ status: 'expired', at: new Date().toISOString(), actor: 'aeeis' });
        await saveRecord(client, record);
      }
      await client.query('COMMIT'); return record;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async revokeGrant(grantId: string, input: { at?: string; actor?: string; reason?: string } = {}): Promise<GrantRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await postgresAdvisoryXactLock(client, 'aeeis:grant', grantId);
      const result = await client.query('SELECT * FROM aeeis_agent_grant_registry WHERE grant_id=$1 FOR UPDATE', [grantId]);
      if (!result.rows[0]) throw new Error('Unknown delegation grant');
      const record = rowToRecord(result.rows[0]);
      if (record.status !== 'revoked') {
        const at = input.at ?? new Date().toISOString(); record.status = 'revoked'; record.revokedAt = at;
        if (input.actor !== undefined) record.revokedBy = input.actor;
        if (input.reason !== undefined) record.revocationReason = input.reason;
        record.history.push({ status: 'revoked', at, ...(input.actor === undefined ? {} : { actor: input.actor }), ...(input.reason === undefined ? {} : { reason: input.reason }) });
        await saveRecord(client, record);
      }
      await client.query('COMMIT'); return record;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async reserve(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void> {
    const parsed = grantBudgetSchema.parse(budget);
    await this.withGrant(grantId, async (current, client) => {
      await assertActiveIfRegistered(client, grantId);
      const grant = assertBudget(current, grantId, parsed);
      const existing = grant.entries[idempotencyKey];
      if (existing) throw new Error(existing.state === 'settled' ? 'Delegation grant call was already settled; reconcile the persisted receipt' : 'Delegation grant call is already reserved; reconcile before submitting again');
      if (grant.budget.calls !== undefined && grant.usedCalls >= grant.budget.calls) throw new Error('Delegation grant call budget is exhausted');
      grant.usedCalls += 1;
      grant.entries[idempotencyKey] = { state: 'reserved', updatedAt: new Date().toISOString() };
      return grant;
    });
  }

  async ensureUnknown(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void> {
    const parsed = grantBudgetSchema.parse(budget);
    await this.withGrant(grantId, async (current, client) => {
      const grant = assertBudget(current, grantId, parsed);
      if (!grant.entries[idempotencyKey]) {
        await assertActiveIfRegistered(client, grantId);
        if (grant.budget.calls !== undefined && grant.usedCalls >= grant.budget.calls) throw new Error('Delegation grant call budget is exhausted');
        grant.usedCalls += 1;
        grant.entries[idempotencyKey] = { state: 'unknown', updatedAt: new Date().toISOString() };
      }
      return grant;
    });
  }

  async markUnknown(grantId: string, idempotencyKey: string): Promise<void> {
    await this.withGrant(grantId, async (current, client) => {
      const grant = requireGrant(current, grantId);
      const entry = requireEntry(grant, idempotencyKey);
      if (entry.state === 'settled' || entry.state === 'rejected') return grant;
      entry.state = 'unknown';
      entry.updatedAt = new Date().toISOString();
      return grant;
    });
  }

  async settle(grantId: string, idempotencyKey: string, usage: GrantUsage = {}): Promise<GrantAuthorizationReceipt> {
    const parsed = grantUsageSchema.parse(usage);
    let budgetError: Error | undefined;
    let authorization!: GrantAuthorizationReceipt;
    await this.withGrant(grantId, async (current, client) => {
      const grant = requireGrant(current, grantId);
      const entry = requireEntry(grant, idempotencyKey);
      if (entry.state === 'settled') {
        const status = entry.authorization ? undefined : await this.settlementGrantStatus(client, grantId);
        authorization = entry.authorization ?? { grantId, idempotencyKey, decision: status?.status === 'active' ? 'authorized' : 'isolated', grantStatus: status?.status ?? 'unregistered', settledAt: entry.updatedAt, ...(status?.digest ? { grantDigest: status.digest } : {}) };
        if (!entry.authorization) entry.authorization = authorization;
        return grant;
      }
      if (entry.state === 'rejected') throw new Error('Delegation grant call was already rejected for exceeding its budget');
      const nextTokens = grant.usedTokens + (parsed.tokens ?? 0);
      const nextMoney = grant.usedMoney + (parsed.money ?? 0);
      if (grant.budget.tokens !== undefined && nextTokens > grant.budget.tokens) {
        entry.state = 'rejected'; entry.usage = parsed; entry.updatedAt = new Date().toISOString();
        grant.usedTokens = nextTokens;
        budgetError = new Error('Delegation grant token budget is exhausted');
      } else if (grant.budget.money !== undefined && nextMoney > grant.budget.money) {
        entry.state = 'rejected'; entry.usage = parsed; entry.updatedAt = new Date().toISOString();
        grant.usedMoney = nextMoney;
        budgetError = new Error('Delegation grant money budget is exhausted');
      } else {
        grant.usedTokens = nextTokens; grant.usedMoney = nextMoney;
        const status = await this.settlementGrantStatus(client, grantId);
        const settledAt = new Date().toISOString();
        authorization = { grantId, idempotencyKey, decision: status.status === 'active' ? 'authorized' : 'isolated', grantStatus: status.status, settledAt, ...(status.digest ? { grantDigest: status.digest } : {}) };
        entry.state = 'settled'; entry.usage = parsed; entry.updatedAt = settledAt; entry.authorization = authorization;
      }
      return grant;
    });
    if (budgetError) throw budgetError;
    return authorization;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withGrant(grantId: string, operation: (grant: GrantLedgerGrant | undefined, client: pg.PoolClient) => Promise<GrantLedgerGrant>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the grant key even before its first row exists; otherwise two
      // concurrent bootstrap reservations could race on the INSERT path.
      await postgresAdvisoryXactLock(client, 'aeeis:grant', grantId);
      const result = await client.query<{ budget: unknown; used_calls: number; used_tokens: string; used_money: string; entries: unknown }>(
        'SELECT budget, used_calls, used_tokens, used_money, entries FROM aeeis_agent_grant_ledger WHERE grant_id=$1 FOR UPDATE', [grantId],
      );
      const current = result.rows[0]
        ? grantLedgerGrantSchema.parse({ grantId, budget: result.rows[0].budget, usedCalls: result.rows[0].used_calls, usedTokens: Number(result.rows[0].used_tokens), usedMoney: Number(result.rows[0].used_money), entries: result.rows[0].entries })
        : undefined;
      const next = await operation(current, client);
      const parsed = grantLedgerGrantSchema.parse(next);
      await client.query(
        `INSERT INTO aeeis_agent_grant_ledger(grant_id,budget,used_calls,used_tokens,used_money,entries,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(grant_id) DO UPDATE SET budget=EXCLUDED.budget,used_calls=EXCLUDED.used_calls,used_tokens=EXCLUDED.used_tokens,used_money=EXCLUDED.used_money,entries=EXCLUDED.entries,updated_at=EXCLUDED.updated_at`,
        [grantId, parsed.budget, parsed.usedCalls, parsed.usedTokens, parsed.usedMoney, parsed.entries, new Date().toISOString()],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Read and, when necessary, expire the immutable Grant under the same
   * transaction/advisory lock as the accounting entry. */
  private async settlementGrantStatus(client: pg.PoolClient, grantId: string): Promise<{ status: GrantLifecycleStatus | 'unregistered'; digest?: string }> {
    const result = await client.query('SELECT * FROM aeeis_agent_grant_registry WHERE grant_id=$1 FOR UPDATE', [grantId]);
    if (!result.rows[0]) return { status: 'unregistered' };
    const record = rowToRecord(result.rows[0]);
    if (record.status === 'active' && new Date(record.expiresAt).getTime() <= Date.now()) {
      record.status = 'expired'; record.history.push({ status: 'expired', at: new Date().toISOString(), actor: 'aeeis' });
      await saveRecord(client, record);
    }
    return { status: record.status, digest: record.digest };
  }
}

function assertBudget(current: GrantLedgerGrant | undefined, grantId: string, budget: GrantBudget): GrantLedgerGrant {
  if (current && JSON.stringify(current.budget) !== JSON.stringify(budget)) throw new Error('Delegation grant budget changed for an existing grant');
  return current ?? { grantId, budget, usedCalls: 0, usedTokens: 0, usedMoney: 0, entries: {} };
}

function requireGrant(current: GrantLedgerGrant | undefined, grantId: string): GrantLedgerGrant {
  if (!current) throw new Error(`Delegation grant ${grantId} is not reserved`);
  return current;
}

function requireEntry(grant: GrantLedgerGrant, idempotencyKey: string) {
  const entry = grant.entries[idempotencyKey];
  if (!entry) throw new Error('Delegation grant reservation is missing; refuse an untracked external call');
  return entry;
}

function rowToRecord(row: Record<string, unknown>): GrantRecord {
  return grantRecordSchema.parse({
    grantId: row.grant_id, digest: row.digest, subjectAgentId: row.subject_agent_id, issuerAgentId: row.issuer_agent_id,
    taskId: row.task_id, resourceRefs: row.resource_refs, revocationRef: row.revocation_ref, issuedAt: row.issued_at,
    expiresAt: row.expires_at, status: row.status, registeredAt: row.registered_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}), ...(row.revoked_by ? { revokedBy: row.revoked_by } : {}),
    ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}), history: row.history,
  });
}

async function saveRecord(client: pg.PoolClient, record: GrantRecord): Promise<void> {
  await client.query(`UPDATE aeeis_agent_grant_registry SET status=$2,revoked_at=$3,revoked_by=$4,revocation_reason=$5,history=$6::jsonb WHERE grant_id=$1`, [record.grantId, record.status, record.revokedAt ?? null, record.revokedBy ?? null, record.revocationReason ?? null, JSON.stringify(record.history)]);
}

/** Legacy direct ledger callers may have no registry row. Once a Grant is
 * registered, reservation and revocation share the transaction lock. */
async function assertActiveIfRegistered(client: pg.PoolClient, grantId: string): Promise<void> {
  const result = await client.query('SELECT status,expires_at FROM aeeis_agent_grant_registry WHERE grant_id=$1 FOR UPDATE', [grantId]);
  if (!result.rows[0]) return;
  if (result.rows[0].status !== 'active') throw new Error(`Delegation grant is ${result.rows[0].status}`);
  if (new Date(String(result.rows[0].expires_at)).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
}
