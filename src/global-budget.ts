import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import pg from 'pg';
import type { Ownership } from './security/principal.js';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';

/** A budget shared by every billable surface owned by one tenant. */
export const globalBudgetSchema = z.object({
  calls: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
  moneyUsd: z.number().nonnegative().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Global budget must specify at least one limit');
export type GlobalBudget = z.infer<typeof globalBudgetSchema>;

// Keep monetary comparisons deterministic while preserving a numeric public
// API. Without this, 0.1 + 0.1 + 0.1 can exceed an exact 0.3 USD limit.
const USD_SCALE = 1_000_000_000_000;
export function normalizeUsd(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('USD amount must be a finite non-negative number');
  return Math.round(value * USD_SCALE) / USD_SCALE;
}
function normalizeBudget(budget: GlobalBudget): GlobalBudget {
  return { ...budget, ...(budget.moneyUsd === undefined ? {} : { moneyUsd: normalizeUsd(budget.moneyUsd) }) };
}

export const globalBudgetUsageSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  moneyUsd: z.number().nonnegative().optional(),
}).strict();
export type GlobalBudgetUsage = z.infer<typeof globalBudgetUsageSchema>;
function normalizeUsage(usage: GlobalBudgetUsage): GlobalBudgetUsage {
  return { ...usage, ...(usage.moneyUsd === undefined ? {} : { moneyUsd: normalizeUsd(usage.moneyUsd) }) };
}
/** Audit metadata supplied when an ambiguous provider call is reconciled.
 * The usage remains the accounting fact; this metadata records where the
 * operator got it so a later billing import can be checked against the same
 * reservation instead of silently overwriting history. */
export const globalBudgetReconciliationSchema = z.object({
  source: z.enum(['provider', 'invoice', 'operator']),
  provider: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().min(1).max(1000),
  reason: z.string().trim().min(1).max(2000),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type GlobalBudgetReconciliation = z.infer<typeof globalBudgetReconciliationSchema>;
export const globalBudgetReconcileSchema = z.object({
  accountKey: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().trim().min(1).max(1000),
  usage: globalBudgetUsageSchema,
  reconciliation: globalBudgetReconciliationSchema.optional(),
}).strict();
export type GlobalBudgetReconcile = z.infer<typeof globalBudgetReconcileSchema>;
const globalBudgetBillingReconciliationSchema = globalBudgetReconciliationSchema.refine(value => value.source === 'invoice', {
  message: 'Billing import reconciliation source must be invoice',
});
export const globalBudgetBillingLineSchema = z.object({
  accountKey: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().trim().min(1).max(1000),
  usage: globalBudgetUsageSchema,
  reconciliation: globalBudgetBillingReconciliationSchema,
}).strict();
export const globalBudgetBillingImportSchema = z.object({
  protocol: z.literal('aeeis-billing-import/1'),
  lines: z.array(globalBudgetBillingLineSchema).min(1).max(1000),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, line] of value.lines.entries()) {
    const key = `${line.accountKey}\u0000${line.idempotencyKey}`;
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['lines', index, 'idempotencyKey'], message: 'Duplicate billing line in one import' });
    seen.add(key);
  }
});
export type GlobalBudgetBillingImport = z.infer<typeof globalBudgetBillingImportSchema>;

const entrySchema = z.object({
  state: z.enum(['reserved', 'unknown', 'settled', 'rejected']),
  updatedAt: z.string().datetime({ offset: true }),
  usage: globalBudgetUsageSchema.optional(),
  reconciliation: globalBudgetReconciliationSchema.optional(),
}).strict();
const accountSchema = z.object({
  schemaVersion: z.literal(1), accountKey: z.string().min(1).max(1000), owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200), windowKey: z.string().min(1).max(200), budget: globalBudgetSchema,
  usedCalls: z.number().int().nonnegative(), usedTokens: z.number().int().nonnegative(), usedMoneyUsd: z.number().nonnegative(),
  unreportedTokenCalls: z.number().int().nonnegative(), unreportedMoneyCalls: z.number().int().nonnegative(),
  entries: z.record(z.string(), entrySchema), updatedAt: z.string().datetime({ offset: true }),
}).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), accounts: z.record(z.string(), accountSchema) }).strict();
export type GlobalBudgetAccount = z.infer<typeof accountSchema>;
export type GlobalBudgetEntry = z.infer<typeof entrySchema>;
export type GlobalBudgetReservation = { reserved: boolean; state: GlobalBudgetEntry['state'] };
export interface GlobalBudgetSelection { accountKey: string; owner: string; tenantId: string; windowKey: string; budget: GlobalBudget }
export type GlobalBudgetSelector = (scope: Ownership | undefined, startedAt: string) => GlobalBudgetSelection | undefined;
export const globalBudgetRuleSchema = z.object({ owner: z.string().min(1).max(200).optional(), tenantId: z.string().min(1).max(200).optional(), window: z.enum(['none', 'hour', 'day', 'month']).default('day'), budget: globalBudgetSchema }).strict();
export type GlobalBudgetRule = z.infer<typeof globalBudgetRuleSchema>;

/** Selects the most specific configured rule. Rules are intentionally simple:
 * deployment policy chooses the owner/tenant boundary and this helper derives
 * a deterministic UTC account window from the durable attempt start time. */
export function createGlobalBudgetSelector(rules: ReadonlyArray<GlobalBudgetRule>): GlobalBudgetSelector {
  const parsed = rules.map(rule => globalBudgetRuleSchema.parse(rule));
  return (scope, startedAt) => {
    const owner = scope?.owner ?? 'owner'; const tenantId = scope?.tenantId ?? 'local';
    const candidates = parsed.filter(rule => (rule.owner === undefined || rule.owner === owner) && (rule.tenantId === undefined || rule.tenantId === tenantId));
    const specificity = (rule: GlobalBudgetRule) => Number(Boolean(rule.owner)) + Number(Boolean(rule.tenantId));
    const rule = candidates.sort((a, b) => specificity(b) - specificity(a))[0];
    if (!rule) return undefined;
    const date = new Date(startedAt); if (!Number.isFinite(date.getTime())) throw new Error('Invalid global budget reservation timestamp');
    let windowKey = 'unbounded';
    if (rule.window === 'hour') windowKey = date.toISOString().slice(0, 13);
    else if (rule.window === 'day') windowKey = date.toISOString().slice(0, 10);
    else if (rule.window === 'month') windowKey = date.toISOString().slice(0, 7);
    // An omitted dimension is deliberately aggregated. A tenant rule therefore
    // shares one account across all owners in that tenant; an owner rule shares
    // one account across that owner's tenants. Explicit dimensions remain
    // visible in the account metadata for audit and reconciliation.
    const accountOwner = rule.owner ?? '*';
    const accountTenant = rule.tenantId ?? (rule.owner === undefined ? tenantId : '*');
    const raw = `${accountOwner}:${accountTenant}:${windowKey}`;
    return { accountKey: `global_${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`, owner: accountOwner, tenantId: accountTenant, windowKey, budget: rule.budget };
  };
}

export interface GlobalBudgetLedger {
  init(): Promise<void>;
  reserve(account: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, idempotencyKey: string): Promise<GlobalBudgetReservation>;
  ensureUnknown(account: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, idempotencyKey: string): Promise<void>;
  markUnknown(accountKey: string, idempotencyKey: string): Promise<void>;
  settle(accountKey: string, idempotencyKey: string, usage?: GlobalBudgetUsage): Promise<void>;
  /** Replace an explicitly unknown provider result; in-flight reservations
   * cannot be settled through the operator reconciliation boundary. */
  reconcile(accountKey: string, idempotencyKey: string, usage?: GlobalBudgetUsage, reconciliation?: GlobalBudgetReconciliation): Promise<void>;
  get(accountKey: string): Promise<GlobalBudgetAccount | undefined>;
  close(): Promise<void>;
}

function newAccount(input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>): GlobalBudgetAccount {
  const now = new Date().toISOString();
  return { schemaVersion: 1, ...input, budget: normalizeBudget(globalBudgetSchema.parse(input.budget)), usedCalls: 0, usedTokens: 0, usedMoneyUsd: 0,
    unreportedTokenCalls: 0, unreportedMoneyCalls: 0, entries: {}, updatedAt: now };
}

function assertAccount(existing: GlobalBudgetAccount | undefined, input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>): GlobalBudgetAccount {
  if (!existing) return newAccount(input);
  const budget = normalizeBudget(globalBudgetSchema.parse(input.budget));
  if (JSON.stringify(normalizeBudget(existing.budget)) !== JSON.stringify(budget)
    || existing.owner !== input.owner || existing.tenantId !== input.tenantId || existing.windowKey !== input.windowKey) {
    throw new Error('Global budget policy changed for an existing account');
  }
  existing.budget = budget;
  return existing;
}

function reserveInAccount(account: GlobalBudgetAccount, idempotencyKey: string): GlobalBudgetReservation {
  const existing = account.entries[idempotencyKey];
  if (existing) return { reserved: false, state: existing.state };
  if (account.budget.tokens !== undefined && account.unreportedTokenCalls > 0) throw new Error('Global token usage is missing; reconcile before continuing');
  if (account.budget.moneyUsd !== undefined && account.unreportedMoneyCalls > 0) throw new Error('Global USD usage is missing; reconcile before continuing');
  if (account.budget.calls !== undefined && account.usedCalls >= account.budget.calls) throw new Error('Global call budget exhausted');
  if (account.budget.tokens !== undefined && account.usedTokens >= account.budget.tokens) throw new Error('Global token budget exhausted');
  if (account.budget.moneyUsd !== undefined && account.usedMoneyUsd >= normalizeUsd(account.budget.moneyUsd)) throw new Error('Global money budget exhausted');
  account.usedCalls += 1;
  account.entries[idempotencyKey] = { state: 'reserved', updatedAt: new Date().toISOString() };
  return { reserved: true, state: 'reserved' };
}

function markUnknownInAccount(account: GlobalBudgetAccount, idempotencyKey: string): void {
  const entry = account.entries[idempotencyKey];
  if (!entry) throw new Error('Global budget reservation is missing');
  if (entry.state !== 'settled' && entry.state !== 'rejected' && entry.state !== 'unknown') {
    entry.state = 'unknown';
    if (account.budget.tokens !== undefined) account.unreportedTokenCalls += 1;
    if (account.budget.moneyUsd !== undefined) account.unreportedMoneyCalls += 1;
  }
  entry.updatedAt = new Date().toISOString(); account.updatedAt = entry.updatedAt;
}

function settleInAccount(account: GlobalBudgetAccount, idempotencyKey: string, usage: GlobalBudgetUsage): void {
  const entry = account.entries[idempotencyKey];
  if (!entry) throw new Error('Global budget reservation is missing; refuse an untracked call');
  if (entry.state === 'settled') return;
  if (entry.state === 'rejected') throw new Error('Global call was already rejected for exceeding its budget');
  const parsed = normalizeUsage(globalBudgetUsageSchema.parse(usage));
  if (entry.state === 'unknown') {
    if (account.budget.tokens !== undefined && account.unreportedTokenCalls > 0) account.unreportedTokenCalls -= 1;
    if (account.budget.moneyUsd !== undefined && account.unreportedMoneyCalls > 0) account.unreportedMoneyCalls -= 1;
  }
  const nextTokens = account.usedTokens + (parsed.tokens ?? 0);
  const nextMoney = normalizeUsd(account.usedMoneyUsd + (parsed.moneyUsd ?? 0));
  if (parsed.tokens === undefined) account.unreportedTokenCalls += 1;
  else account.usedTokens = nextTokens;
  if (parsed.moneyUsd === undefined) account.unreportedMoneyCalls += 1;
  else account.usedMoneyUsd = nextMoney;
  entry.usage = parsed;
  entry.updatedAt = new Date().toISOString();
  if (account.budget.tokens !== undefined && (nextTokens > account.budget.tokens || (parsed.tokens === undefined))) entry.state = 'rejected';
  else if (account.budget.moneyUsd !== undefined && (nextMoney > normalizeUsd(account.budget.moneyUsd) || parsed.moneyUsd === undefined)) entry.state = 'rejected';
  else entry.state = 'settled';
  account.updatedAt = entry.updatedAt;
  if (entry.state === 'rejected') throw new Error('Global budget exceeded or usage was not reported');
}

function reconcileInAccount(account: GlobalBudgetAccount, idempotencyKey: string, usage: GlobalBudgetUsage, reconciliation?: GlobalBudgetReconciliation): void {
  const entry = account.entries[idempotencyKey];
  if (!entry) throw new Error('Global budget reservation is missing');
  if (entry.state === 'settled') return;
  if (entry.state !== 'unknown') throw new Error('Global budget reservation is still in flight; provider reconciliation requires unknown state');
  if (!reconciliation) throw new Error('Global budget reconciliation requires an audit reference');
  const audit = globalBudgetReconciliationSchema.parse(reconciliation);
  let error: unknown;
  try { settleInAccount(account, idempotencyKey, usage); } catch (caught) { error = caught; }
  // Preserve the billing/provider evidence even when the reconciled spend
  // itself exceeds the configured limit and settlement rejects the call.
  const reconciled = account.entries[idempotencyKey];
  if (reconciled) { reconciled.reconciliation = audit; reconciled.updatedAt = new Date().toISOString(); account.updatedAt = reconciled.updatedAt; }
  if (error) throw error;
}

function requireAccount(accounts: Record<string, GlobalBudgetAccount>, key: string): GlobalBudgetAccount {
  const account = accounts[key];
  if (!account) throw new Error(`Unknown global budget account ${key}`);
  return account;
}

/** Atomic local ledger. It intentionally serializes one process, matching the
 * single-writer guarantee of the existing File repositories. */
export class FileGlobalBudgetLedger implements GlobalBudgetLedger {
  private state = { schemaVersion: 1 as const, accounts: {} as Record<string, GlobalBudgetAccount> };
  private loaded = false;
  private tail = Promise.resolve();
  constructor(private readonly filePath: string) {}
  async init(): Promise<void> {
    if (this.loaded) return;
    try { this.state = stateSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  async reserve(input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, key: string): Promise<GlobalBudgetReservation> {
    return this.exclusive(() => { const account = assertAccount(this.state.accounts[input.accountKey], input); const result = reserveInAccount(account, key); this.state.accounts[input.accountKey] = account; return result; });
  }
  async ensureUnknown(input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, key: string): Promise<void> {
    await this.exclusive(() => { const account = assertAccount(this.state.accounts[input.accountKey], input); if (!account.entries[key]) { reserveInAccount(account, key); markUnknownInAccount(account, key); } this.state.accounts[input.accountKey] = account; });
  }
  async markUnknown(accountKey: string, key: string): Promise<void> { await this.exclusive(() => markUnknownInAccount(requireAccount(this.state.accounts, accountKey), key)); }
  async settle(accountKey: string, key: string, usage: GlobalBudgetUsage = {}): Promise<void> { await this.exclusive(() => settleInAccount(requireAccount(this.state.accounts, accountKey), key, usage)); }
  async reconcile(accountKey: string, key: string, usage: GlobalBudgetUsage = {}, reconciliation?: GlobalBudgetReconciliation): Promise<void> { await this.exclusive(() => reconcileInAccount(requireAccount(this.state.accounts, accountKey), key, usage, reconciliation)); }
  async get(accountKey: string): Promise<GlobalBudgetAccount | undefined> { await this.init(); const value = this.state.accounts[accountKey]; return value ? structuredClone(value) : undefined; }
  async close(): Promise<void> { await this.tail; }
  protected persist(): void {
    const directory = dirname(this.filePath); mkdirSync(directory, { recursive: true, mode: 0o700 }); const temp = `${this.filePath}.${randomUUID()}.tmp`; let fd: number | undefined;
    try { fd = openSync(temp, 'wx', 0o600); writeSync(fd, `${JSON.stringify(this.state, null, 2)}\n`, undefined, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.filePath); const d = openSync(directory, 'r'); try { fsyncSync(d); } finally { closeSync(d); } }
    catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup; } throw error; }
  }
  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> { const previous = this.tail; let release!: () => void; this.tail = new Promise(resolve => { release = resolve; }); await previous; try { await this.init(); const result = await operation(); this.persist(); return result; } catch (error) { this.persist(); throw error; } finally { release(); } }
}

export class InMemoryGlobalBudgetLedger extends FileGlobalBudgetLedger {
  constructor() { super(`/tmp/aeeis-global-budget-${randomUUID()}.json`); }
  protected override persist(): void {}
}

/** PostgreSQL implementation locks exactly one account row (and an advisory
 * key while bootstrapping it), so concurrent reservations cannot oversell. */
export class PostgresGlobalBudgetLedger implements GlobalBudgetLedger {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> { await withPostgresMigrationLock(this.pool, 'global-budget', async client => { await client.query(`CREATE TABLE IF NOT EXISTS aeeis_global_budget_accounts (account_key text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, window_key text NOT NULL, budget jsonb NOT NULL, used_calls integer NOT NULL, used_tokens bigint NOT NULL, used_money_usd numeric NOT NULL, unreported_token_calls integer NOT NULL, unreported_money_calls integer NOT NULL, entries jsonb NOT NULL, updated_at timestamptz NOT NULL)`); }); }
  async reserve(input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, key: string): Promise<GlobalBudgetReservation> { return this.withAccount(input, account => { const result = reserveInAccount(account, key); return { account, result }; }); }
  async ensureUnknown(input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, key: string): Promise<void> { await this.withAccount(input, account => { if (!account.entries[key]) { reserveInAccount(account, key); markUnknownInAccount(account, key); } return { account }; }); }
  async markUnknown(accountKey: string, key: string): Promise<void> { await this.withExisting(accountKey, account => { markUnknownInAccount(account, key); return { account }; }); }
  async settle(accountKey: string, key: string, usage: GlobalBudgetUsage = {}): Promise<void> { let error: Error | undefined; await this.withExisting(accountKey, account => { try { settleInAccount(account, key, usage); } catch (e) { error = e as Error; } return { account }; }); if (error) throw error; }
  async reconcile(accountKey: string, key: string, usage: GlobalBudgetUsage = {}, reconciliation?: GlobalBudgetReconciliation): Promise<void> { let error: Error | undefined; await this.withExisting(accountKey, account => { try { reconcileInAccount(account, key, usage, reconciliation); } catch (e) { error = e as Error; } return { account }; }); if (error) throw error; }
  async get(accountKey: string): Promise<GlobalBudgetAccount | undefined> { const result = await this.pool.query('SELECT * FROM aeeis_global_budget_accounts WHERE account_key=$1', [accountKey]); return result.rows[0] ? rowToAccount(result.rows[0]) : undefined; }
  async close(): Promise<void> { await this.pool.end(); }
  private async withAccount(input: Pick<GlobalBudgetAccount, 'accountKey' | 'owner' | 'tenantId' | 'windowKey' | 'budget'>, operation: (account: GlobalBudgetAccount) => { account: GlobalBudgetAccount; result?: GlobalBudgetReservation }): Promise<GlobalBudgetReservation> {
    const client = await this.pool.connect(); try { await client.query('BEGIN'); await postgresAdvisoryXactLock(client, 'aeeis:global-budget', input.accountKey); const row = await client.query('SELECT * FROM aeeis_global_budget_accounts WHERE account_key=$1 FOR UPDATE', [input.accountKey]); const result = operation(row.rows[0] ? rowToAccount(row.rows[0]) : newAccount(input)); await saveAccount(client, result.account); await client.query('COMMIT'); return result.result!; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  private async withExisting(accountKey: string, operation: (account: GlobalBudgetAccount) => { account: GlobalBudgetAccount }): Promise<void> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const row = await client.query('SELECT * FROM aeeis_global_budget_accounts WHERE account_key=$1 FOR UPDATE', [accountKey]); if (!row.rows[0]) throw new Error(`Unknown global budget account ${accountKey}`); const result = operation(rowToAccount(row.rows[0])); await saveAccount(client, result.account); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
}

function rowToAccount(row: any): GlobalBudgetAccount { return accountSchema.parse({ schemaVersion: 1, accountKey: row.account_key, owner: row.owner, tenantId: row.tenant_id, windowKey: row.window_key, budget: row.budget, usedCalls: Number(row.used_calls), usedTokens: Number(row.used_tokens), usedMoneyUsd: Number(row.used_money_usd), unreportedTokenCalls: Number(row.unreported_token_calls), unreportedMoneyCalls: Number(row.unreported_money_calls), entries: row.entries, updatedAt: new Date(row.updated_at).toISOString() }); }
async function saveAccount(client: pg.PoolClient, account: GlobalBudgetAccount): Promise<void> { await client.query(`INSERT INTO aeeis_global_budget_accounts(account_key,owner,tenant_id,window_key,budget,used_calls,used_tokens,used_money_usd,unreported_token_calls,unreported_money_calls,entries,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(account_key) DO UPDATE SET budget=EXCLUDED.budget,used_calls=EXCLUDED.used_calls,used_tokens=EXCLUDED.used_tokens,used_money_usd=EXCLUDED.used_money_usd,unreported_token_calls=EXCLUDED.unreported_token_calls,unreported_money_calls=EXCLUDED.unreported_money_calls,entries=EXCLUDED.entries,updated_at=EXCLUDED.updated_at`, [account.accountKey, account.owner, account.tenantId, account.windowKey, account.budget, account.usedCalls, account.usedTokens, account.usedMoneyUsd, account.unreportedTokenCalls, account.unreportedMoneyCalls, account.entries, account.updatedAt]); }
