import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { postgresAdvisoryXactLock } from './adapters/postgres-lock.js';
import { createPostgresPool } from './adapters/postgres-pool.js';
import { digestProtocol } from './protocol.js';
import type { Ownership } from './security/principal.js';

/**
 * A Work Grant is the owner's standing authorization for one line of work: which tools and agents a Run may use,
 * how much it may spend, and until when. A Run that references an active grant does not wait for plan approval
 * when its plan stays inside the grant, including after a replan. Actions whose effect reaches outside the Run's
 * isolated workspace still ask; a grant never covers them. Only the owner creates or revokes a grant.
 */
const ref = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const budgetSchema = z.object({
  tokens: z.number().int().positive().optional(),
  moneyUsd: z.number().positive().optional(),
}).strict().refine(value => value.tokens !== undefined || value.moneyUsd !== undefined, 'A grant budget needs tokens or moneyUsd');
export type WorkGrantBudget = z.infer<typeof budgetSchema>;
export const MAX_WORK_GRANT_HOURS = 24 * 7;
const MAX_ALLOCATIONS = 1000;

const allocationSchema = z.object({
  runId: z.string().min(1).max(200),
  tokens: z.number().int().positive().optional(),
  moneyUsd: z.number().positive().optional(),
  at: z.string().datetime({ offset: true }),
  /** Set once the Run has ended: tokens and moneyUsd then hold what it spent, not what it reserved. */
  settledAt: z.string().datetime({ offset: true }).optional(),
  /** Dimensions whose spend was not known when it settled, so their whole reservation stayed. A later settlement that
   * knows them shrinks them then; nothing else about a settled allocation changes. */
  held: z.array(z.enum(['tokens', 'moneyUsd'])).min(1).max(2).optional(),
}).strict();
export type WorkGrantAllocation = z.infer<typeof allocationSchema>;

export const workGrantSchema = z.object({
  schemaVersion: z.literal('work-grant/1'),
  grantId: z.string().regex(/^wg_[a-f0-9]{32}$/),
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  tools: z.array(ref).max(50),
  agents: z.array(ref).max(20),
  /** `perRun` caps one Run; `total` is shared by every Run under this grant. Each Run reserves its cap when it is
   * created; once the Run ends, the reservation shrinks to what it spent and the rest returns to `total`. */
  budget: z.object({ perRun: budgetSchema, total: budgetSchema }).strict(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(['active', 'revoked']),
  revokedAt: z.string().datetime({ offset: true }).optional(),
  allocations: z.array(allocationSchema).max(MAX_ALLOCATIONS),
  revision: z.number().int().nonnegative(),
}).strict();
export type WorkGrant = z.infer<typeof workGrantSchema>;

export const createWorkGrantSchema = z.object({
  title: z.string().trim().min(1).max(200),
  tools: z.array(ref).max(50).default([]),
  agents: z.array(ref).max(20).default([]),
  budget: z.object({ perRun: budgetSchema, total: budgetSchema }).strict(),
  durationHours: z.number().int().min(1).max(MAX_WORK_GRANT_HOURS),
}).strict().superRefine((value, context) => {
  if (!value.tools.length && !value.agents.length) context.addIssue({ code: 'custom', path: ['tools'], message: 'A grant needs at least one tool or agent' });
  for (const key of ['tokens', 'moneyUsd'] as const) {
    const perRun = value.budget.perRun[key], total = value.budget.total[key];
    if ((perRun === undefined) !== (total === undefined)) context.addIssue({ code: 'custom', path: ['budget', 'total', key], message: `perRun and total must both set ${key} or both leave it out` });
    else if (perRun !== undefined && total !== undefined && perRun > total) context.addIssue({ code: 'custom', path: ['budget', 'perRun', key], message: `perRun ${key} cannot exceed total` });
  }
});
export type CreateWorkGrant = z.input<typeof createWorkGrantSchema>;

export type WorkGrantState = 'active' | 'revoked' | 'expired' | 'exhausted';
export class WorkGrantConflict extends Error {}
export class WorkGrantNotFound extends Error {}

export interface WorkGrantStore {
  init?(): Promise<void>;
  create(scope: Ownership, input: CreateWorkGrant, now?: string): Promise<WorkGrant>;
  get(scope: Ownership, grantId: string): Promise<WorkGrant>;
  list(scope: Ownership): Promise<WorkGrant[]>;
  revoke(scope: Ownership, grantId: string, now?: string): Promise<WorkGrant>;
  /** Reserves one Run's budget. Repeating it for the same Run returns the first reservation. */
  allocate(scope: Ownership, grantId: string, runId: string, requested: WorkGrantBudget | undefined, now?: string): Promise<{ grant: WorkGrant; allocation: WorkGrantAllocation }>;
  /** Shrinks an ended Run's reservation to what it spent. Settling again only fills in dimensions it held as unknown. */
  settle?(scope: Ownership, grantId: string, runId: string, spent: WorkGrantSpend, now?: string): Promise<WorkGrant>;
  /** Restores a settled Run's reservation before it runs again. */
  reopen?(scope: Ownership, grantId: string, runId: string, reserved: WorkGrantSpend): Promise<WorkGrant>;
  close?(): Promise<void>;
}

export function workGrantState(grant: WorkGrant, now = new Date().toISOString()): WorkGrantState {
  if (grant.status === 'revoked') return 'revoked';
  if (Date.parse(now) >= Date.parse(grant.expiresAt)) return 'expired';
  const remaining = workGrantRemaining(grant);
  if (remaining.tokens === 0 || remaining.moneyUsd === 0 || grant.allocations.length >= MAX_ALLOCATIONS) return 'exhausted';
  return 'active';
}

/** What `total` still allows after every reservation. A dimension the grant does not limit stays undefined. */
export function workGrantRemaining(grant: WorkGrant): { tokens?: number; moneyUsd?: number } {
  const used = (key: 'tokens' | 'moneyUsd') => grant.allocations.reduce((sum, item) => sum + (item[key] ?? 0), 0);
  const total = grant.budget.total;
  return {
    ...(total.tokens === undefined ? {} : { tokens: Math.max(0, total.tokens - used('tokens')) }),
    ...(total.moneyUsd === undefined ? {} : { moneyUsd: Math.max(0, roundUsd(total.moneyUsd - used('moneyUsd'))) }),
  };
}

/** The part of a grant a Run freezes. Its digest shows later that the Run ran under exactly this grant. */
export function workGrantDigest(grant: WorkGrant): string {
  return digestProtocol({ schemaVersion: 'work-grant/1', grantId: grant.grantId, owner: grant.owner, tenantId: grant.tenantId, tools: grant.tools, agents: grant.agents, budget: grant.budget, expiresAt: grant.expiresAt });
}

export function newWorkGrant(scope: Ownership, raw: CreateWorkGrant, now: string): WorkGrant {
  const input = createWorkGrantSchema.parse(raw);
  return workGrantSchema.parse({
    schemaVersion: 'work-grant/1', grantId: `wg_${randomUUID().replaceAll('-', '')}`, owner: scope.owner, tenantId: scope.tenantId,
    title: input.title, tools: [...new Set(input.tools)].sort(), agents: [...new Set(input.agents)].sort(), budget: input.budget,
    createdAt: now, expiresAt: new Date(Date.parse(now) + input.durationHours * 3_600_000).toISOString(),
    status: 'active', allocations: [], revision: 0,
  });
}

export function revokeWorkGrant(grant: WorkGrant, now: string): WorkGrant {
  if (grant.status === 'revoked') return grant;
  return { ...grant, status: 'revoked', revokedAt: now, revision: grant.revision + 1 };
}

/** A Run gets the smaller of what it asked for, the per-Run cap and what is left. */
export function allocateWorkGrant(grant: WorkGrant, runId: string, requested: WorkGrantBudget | undefined, now: string): { grant: WorkGrant; allocation: WorkGrantAllocation } {
  const existing = grant.allocations.find(item => item.runId === runId);
  if (existing) return { grant, allocation: existing };
  const state = workGrantState(grant, now);
  if (state !== 'active') throw new WorkGrantConflict(state === 'revoked' ? '这份授权已撤销' : state === 'expired' ? '这份授权已过期' : '这份授权的预算已用完');
  const remaining = workGrantRemaining(grant);
  const pick = (key: 'tokens' | 'moneyUsd') => {
    const cap = grant.budget.perRun[key];
    if (cap === undefined) return undefined;
    const value = Math.min(cap, remaining[key] ?? cap, requested?.[key] ?? cap);
    return key === 'moneyUsd' ? roundUsd(value) : value;
  };
  const tokens = pick('tokens'), moneyUsd = pick('moneyUsd');
  const allocation = allocationSchema.parse({ runId, ...(tokens === undefined ? {} : { tokens }), ...(moneyUsd === undefined ? {} : { moneyUsd }), at: now });
  return { grant: { ...grant, allocations: [...grant.allocations, allocation], revision: grant.revision + 1 }, allocation };
}

/** What an ended Run spent. A dimension left out was not reported, so that part of the reservation stays. */
export interface WorkGrantSpend { tokens?: number; moneyUsd?: number }
export function settleWorkGrant(grant: WorkGrant, runId: string, spent: WorkGrantSpend, now: string): WorkGrant {
  const index = grant.allocations.findIndex(item => item.runId === runId);
  const current = grant.allocations[index];
  if (!current || (current.settledAt && !current.held)) return grant;
  const known = (used: number | undefined) => used !== undefined && Number.isFinite(used) && used >= 0;
  // Settled already: only a dimension it held can still change, and only once its spend is known.
  const open = (key: 'tokens' | 'moneyUsd') => !current.settledAt || Boolean(current.held?.includes(key));
  const shrink = (key: 'tokens' | 'moneyUsd', round: (value: number) => number) => {
    const reserved = current[key], used = spent[key];
    return reserved === undefined || !open(key) || !known(used) ? reserved : round(Math.min(reserved, used!));
  };
  const tokens = shrink('tokens', Math.ceil), moneyUsd = shrink('moneyUsd', value => Math.ceil(value * 1e6) / 1e6);
  const held = (['tokens', 'moneyUsd'] as const).filter(key => current[key] !== undefined && open(key) && !known(spent[key]));
  if (current.settledAt && held.length === current.held!.length) return grant;
  const settled = allocationSchema.parse({ runId, ...(tokens ? { tokens } : {}), ...(moneyUsd ? { moneyUsd } : {}), at: current.at, settledAt: current.settledAt ?? now, ...(held.length ? { held } : {}) });
  const allocations = [...grant.allocations]; allocations[index] = settled;
  return { ...grant, allocations, revision: grant.revision + 1 };
}

/**
 * Puts a settled Run's whole reservation back, for a retry or replan that will spend again. Refused when what the
 * settlement returned has since been reserved by other Runs.
 */
export function reopenWorkGrant(grant: WorkGrant, runId: string, reserved: WorkGrantSpend): WorkGrant {
  const index = grant.allocations.findIndex(item => item.runId === runId);
  const current = grant.allocations[index];
  if (!current?.settledAt) return grant;
  const remaining = workGrantRemaining(grant);
  for (const key of ['tokens', 'moneyUsd'] as const) {
    const extra = (reserved[key] ?? 0) - (current[key] ?? 0);
    if (extra > 0 && remaining[key] !== undefined && extra > remaining[key]! + 1e-9) throw new WorkGrantConflict('这份授权剩下的预算不够这件 Run 再做一次');
  }
  const reopened = allocationSchema.parse({ runId, ...(reserved.tokens ? { tokens: reserved.tokens } : {}), ...(reserved.moneyUsd ? { moneyUsd: reserved.moneyUsd } : {}), at: current.at });
  const allocations = [...grant.allocations]; allocations[index] = reopened;
  return { ...grant, allocations, revision: grant.revision + 1 };
}

function roundUsd(value: number): number { return Math.round(value * 1e6) / 1e6; }
function owned(grant: WorkGrant | undefined, scope: Ownership, grantId: string): WorkGrant {
  if (!grant || grant.owner !== scope.owner || grant.tenantId !== scope.tenantId) throw new WorkGrantNotFound(`Work grant not found: ${grantId}`);
  return grant;
}

export class InMemoryWorkGrantStore implements WorkGrantStore {
  private readonly grants = new Map<string, WorkGrant>();
  async create(scope: Ownership, input: CreateWorkGrant, now = new Date().toISOString()) {
    const grant = newWorkGrant(scope, input, now); this.grants.set(grant.grantId, grant); return structuredClone(grant);
  }
  async get(scope: Ownership, grantId: string) { return structuredClone(owned(this.grants.get(grantId), scope, grantId)); }
  async list(scope: Ownership) { return [...this.grants.values()].filter(item => item.owner === scope.owner && item.tenantId === scope.tenantId).map(item => structuredClone(item)); }
  async revoke(scope: Ownership, grantId: string, now = new Date().toISOString()) {
    const next = revokeWorkGrant(owned(this.grants.get(grantId), scope, grantId), now); this.grants.set(grantId, next); return structuredClone(next);
  }
  async allocate(scope: Ownership, grantId: string, runId: string, requested: WorkGrantBudget | undefined, now = new Date().toISOString()) {
    const result = allocateWorkGrant(owned(this.grants.get(grantId), scope, grantId), runId, requested, now);
    this.grants.set(grantId, result.grant); return structuredClone(result);
  }
  async settle(scope: Ownership, grantId: string, runId: string, spent: WorkGrantSpend, now = new Date().toISOString()) {
    const next = settleWorkGrant(owned(this.grants.get(grantId), scope, grantId), runId, spent, now);
    this.grants.set(grantId, next); return structuredClone(next);
  }
  async reopen(scope: Ownership, grantId: string, runId: string, reserved: WorkGrantSpend) {
    const next = reopenWorkGrant(owned(this.grants.get(grantId), scope, grantId), runId, reserved);
    this.grants.set(grantId, next); return structuredClone(next);
  }
}

/** Durable single-writer JSON store. */
export class JsonWorkGrantStore implements WorkGrantStore {
  private grants: WorkGrant[] = [];
  private loaded = false;
  private lockOwned = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}
  async init(): Promise<void> {
    if (this.loaded) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    try { const fd = openSync(lockPath, 'wx', 0o600); try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); } }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8'));
      try { process.kill(pid, 0); } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        unlinkSync(lockPath); return this.init();
      }
      throw new Error('Work grant store already has a live writer');
    }
    this.lockOwned = true;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as { grants?: unknown };
      this.grants = z.array(workGrantSchema).parse(parsed.grants ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { await this.close(); throw error; }
    }
    this.loaded = true;
  }
  async create(scope: Ownership, input: CreateWorkGrant, now = new Date().toISOString()) {
    return this.serial(async () => { const grant = newWorkGrant(scope, input, now); this.persist([...this.grants, grant]); return structuredClone(grant); });
  }
  async get(scope: Ownership, grantId: string) {
    return this.serial(async () => structuredClone(owned(this.grants.find(item => item.grantId === grantId), scope, grantId)));
  }
  async list(scope: Ownership) {
    return this.serial(async () => this.grants.filter(item => item.owner === scope.owner && item.tenantId === scope.tenantId).map(item => structuredClone(item)));
  }
  async revoke(scope: Ownership, grantId: string, now = new Date().toISOString()) {
    return this.serial(async () => {
      const current = owned(this.grants.find(item => item.grantId === grantId), scope, grantId);
      const next = revokeWorkGrant(current, now);
      if (next !== current) this.replace(next);
      return structuredClone(next);
    });
  }
  async allocate(scope: Ownership, grantId: string, runId: string, requested: WorkGrantBudget | undefined, now = new Date().toISOString()) {
    return this.serial(async () => {
      const current = owned(this.grants.find(item => item.grantId === grantId), scope, grantId);
      const result = allocateWorkGrant(current, runId, requested, now);
      if (result.grant !== current) this.replace(result.grant);
      return structuredClone(result);
    });
  }
  async settle(scope: Ownership, grantId: string, runId: string, spent: WorkGrantSpend, now = new Date().toISOString()) {
    return this.serial(async () => {
      const current = owned(this.grants.find(item => item.grantId === grantId), scope, grantId);
      const next = settleWorkGrant(current, runId, spent, now);
      if (next !== current) this.replace(next);
      return structuredClone(next);
    });
  }
  async reopen(scope: Ownership, grantId: string, runId: string, reserved: WorkGrantSpend) {
    return this.serial(async () => {
      const current = owned(this.grants.find(item => item.grantId === grantId), scope, grantId);
      const next = reopenWorkGrant(current, runId, reserved);
      if (next !== current) this.replace(next);
      return structuredClone(next);
    });
  }
  async close(): Promise<void> {
    if (this.lockOwned) { try { unlinkSync(`${this.filePath}.lock`); } catch { /* already gone */ } this.lockOwned = false; }
    this.loaded = false;
  }
  private replace(next: WorkGrant) { this.persist(this.grants.map(item => item.grantId === next.grantId ? next : item)); }
  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      if (!this.loaded || !this.lockOwned) throw new Error('Work grant store is not open');
      return await operation();
    } finally { release(); }
  }
  private persist(next: WorkGrant[]): void {
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, 'wx', 0o600); writeSync(fd, `${JSON.stringify({ grants: next }, null, 2)}\n`, undefined, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, this.filePath);
      const directory = openSync(dirname(this.filePath), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
      this.grants = next.map(item => structuredClone(item));
    } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* the temp file is already gone */ } throw error; }
  }
}

export class PostgresWorkGrantStore implements WorkGrantStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'work-grants', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_work_grants (seq bigserial NOT NULL, grant_id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL, state jsonb NOT NULL, revision integer NOT NULL, created_at timestamptz NOT NULL)');
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_work_grants_owner ON aeeis_work_grants (tenant_id, owner, seq)');
    });
  }
  async create(scope: Ownership, input: CreateWorkGrant, now = new Date().toISOString()) {
    const grant = newWorkGrant(scope, input, now);
    await this.pool.query('INSERT INTO aeeis_work_grants(grant_id, owner, tenant_id, state, revision, created_at) VALUES($1,$2,$3,$4,$5,$6)', [grant.grantId, grant.owner, grant.tenantId, grant, grant.revision, grant.createdAt]);
    return grant;
  }
  async get(scope: Ownership, grantId: string) {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_work_grants WHERE grant_id=$1 AND tenant_id=$2 AND owner=$3', [grantId, scope.tenantId, scope.owner]);
    return owned(result.rows[0] ? workGrantSchema.parse(result.rows[0].state) : undefined, scope, grantId);
  }
  async list(scope: Ownership) {
    const result = await this.pool.query<{ state: unknown }>('SELECT state FROM aeeis_work_grants WHERE tenant_id=$1 AND owner=$2 ORDER BY seq', [scope.tenantId, scope.owner]);
    return result.rows.map(row => workGrantSchema.parse(row.state));
  }
  async revoke(scope: Ownership, grantId: string, now = new Date().toISOString()) {
    return this.change(scope, grantId, current => { const next = revokeWorkGrant(current, now); return { next, result: next }; });
  }
  async allocate(scope: Ownership, grantId: string, runId: string, requested: WorkGrantBudget | undefined, now = new Date().toISOString()) {
    return this.change(scope, grantId, current => { const result = allocateWorkGrant(current, runId, requested, now); return { next: result.grant, result }; });
  }
  async settle(scope: Ownership, grantId: string, runId: string, spent: WorkGrantSpend, now = new Date().toISOString()) {
    return this.change(scope, grantId, current => { const next = settleWorkGrant(current, runId, spent, now); return { next, result: next }; });
  }
  async reopen(scope: Ownership, grantId: string, runId: string, reserved: WorkGrantSpend) {
    return this.change(scope, grantId, current => { const next = reopenWorkGrant(current, runId, reserved); return { next, result: next }; });
  }
  async close(): Promise<void> { await this.pool.end(); }
  private async change<T>(scope: Ownership, grantId: string, apply: (current: WorkGrant) => { next: WorkGrant; result: T }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:work-grants', grantId);
      const row = await client.query<{ state: unknown }>('SELECT state FROM aeeis_work_grants WHERE grant_id=$1 AND tenant_id=$2 AND owner=$3', [grantId, scope.tenantId, scope.owner]);
      const current = owned(row.rows[0] ? workGrantSchema.parse(row.rows[0].state) : undefined, scope, grantId);
      const { next, result } = apply(current);
      if (next !== current) await client.query('UPDATE aeeis_work_grants SET state=$2, revision=$3 WHERE grant_id=$1', [grantId, next, next.revision]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
