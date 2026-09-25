import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { digestProtocol, type DelegationGrant } from './protocol.js';

export interface GrantBudget {
  calls?: number | undefined;
  tokens?: number | undefined;
  money?: number | undefined;
}

export interface GrantUsage {
  tokens?: number | undefined;
  money?: number | undefined;
}

export type GrantLifecycleStatus = 'active' | 'revoked' | 'expired';

/** Durable linearization result for a provider settlement.  The decision is
 * made while the Grant registry and accounting entry are protected by the
 * same ledger lock.  A later revoke therefore cannot retroactively change a
 * result that was already authorized at this boundary. */
export interface GrantAuthorizationReceipt {
  grantId: string;
  idempotencyKey: string;
  decision: 'authorized' | 'isolated';
  grantStatus: GrantLifecycleStatus | 'unregistered';
  settledAt: string;
  grantDigest?: string | undefined;
}

/** The durable identity and authorization binding for a delegation Grant.
 * A budget ledger entry alone is insufficient: after a process restart AEEIS
 * must still know which task/agent a grant belonged to and whether its
 * revocation reference has been withdrawn. */
export interface GrantRegistration {
  grant: DelegationGrant;
  digest: string;
  registeredAt?: string;
}

export interface GrantRecord {
  grantId: string;
  digest: string;
  subjectAgentId: string;
  issuerAgentId: string;
  taskId: string;
  resourceRefs: string[];
  revocationRef: string;
  issuedAt: string;
  expiresAt: string;
  status: GrantLifecycleStatus;
  registeredAt: string;
  revokedAt?: string | undefined;
  revokedBy?: string | undefined;
  revocationReason?: string | undefined;
  history: Array<{ status: GrantLifecycleStatus; at: string; actor?: string | undefined; reason?: string | undefined }>;
}

export interface GrantLedger {
  ensureGrant(registration: GrantRegistration): Promise<GrantRecord>;
  getGrant(grantId: string): Promise<GrantRecord | undefined>;
  revokeGrant(grantId: string, input?: { at?: string; actor?: string; reason?: string }): Promise<GrantRecord>;
  reserve(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void>;
  ensureUnknown(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void>;
  markUnknown(grantId: string, idempotencyKey: string): Promise<void>;
  settle(grantId: string, idempotencyKey: string, usage?: GrantUsage): Promise<GrantAuthorizationReceipt>;
  close(): Promise<void>;
}

export const grantBudgetSchema = z.object({
  calls: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
  money: z.number().nonnegative().optional(),
}).strict();
export const grantUsageSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  money: z.number().nonnegative().optional(),
}).strict();
const grantHistorySchema = z.object({
  status: z.enum(['active', 'revoked', 'expired']), at: z.string().datetime({ offset: true }),
  actor: z.string().min(1).max(200).optional(), reason: z.string().max(2000).optional(),
}).strict();
export const grantRecordSchema = z.object({
  grantId: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  subjectAgentId: z.string().min(1), issuerAgentId: z.string().min(1), taskId: z.string().min(1),
  resourceRefs: z.array(z.string().min(1).max(200)).max(100), revocationRef: z.string().min(1),
  issuedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(['active', 'revoked', 'expired']), registeredAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).optional(), revokedBy: z.string().min(1).max(200).optional(),
  revocationReason: z.string().max(2000).optional(), history: z.array(grantHistorySchema).min(1).max(20),
}).strict();
export const grantLedgerEntrySchema = z.object({
  state: z.enum(['reserved', 'unknown', 'settled', 'rejected']),
  updatedAt: z.string().datetime({ offset: true }),
  usage: grantUsageSchema.optional(),
  authorization: z.object({
    grantId: z.string().min(1), idempotencyKey: z.string().min(1),
    decision: z.enum(['authorized', 'isolated']),
    grantStatus: z.enum(['active', 'revoked', 'expired', 'unregistered']),
    settledAt: z.string().datetime({ offset: true }), grantDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
}).strict();
export const grantLedgerGrantSchema = z.object({
  grantId: z.string().min(1),
  budget: grantBudgetSchema,
  usedCalls: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  usedMoney: z.number().nonnegative(),
  entries: z.record(z.string(), grantLedgerEntrySchema),
}).strict();
const stateSchema = z.object({ schemaVersion: z.literal(2), registrations: z.record(z.string(), grantRecordSchema), grants: z.record(z.string(), grantLedgerGrantSchema) }).strict();
type LedgerState = z.infer<typeof stateSchema>;
export type GrantLedgerEntry = z.infer<typeof grantLedgerEntrySchema>;
export type GrantLedgerGrant = z.infer<typeof grantLedgerGrantSchema>;

function validateRegistration(registration: GrantRegistration): Omit<GrantRecord, 'registeredAt' | 'status' | 'history'> {
  const grant = registration.grant;
  if (!grant.revocationRef) throw new Error('Delegation grant revocation reference is required');
  if (!/^[a-f0-9]{64}$/.test(registration.digest)) throw new Error('Delegation grant digest is invalid');
  if (registration.digest !== digestProtocol(grant)) throw new Error('Delegation grant digest does not match its contents');
  return {
    grantId: grant.grantId, digest: registration.digest, subjectAgentId: grant.subjectAgentId,
    issuerAgentId: grant.issuerAgentId, taskId: grant.taskId, resourceRefs: [...grant.resourceRefs],
    revocationRef: grant.revocationRef, issuedAt: grant.issuedAt, expiresAt: grant.expiresAt,
  };
}

/**
 * Durable admission and accounting for external Agent grants.
 * A call is consumed when it is reserved, so a crash cannot make an
 * already-issued side effect available for an unbounded retry.
 */
export class FileGrantLedger implements GrantLedger {
  private state: LedgerState = { schemaVersion: 2, registrations: {}, grants: {} };
  private loaded = false;
  private tail = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      // Version 1 only stored budget accounting. Keep those entries usable;
      // a grant registration is created when the first request is retried.
      if (parsed && typeof parsed === 'object' && (parsed as { schemaVersion?: unknown }).schemaVersion === 1) {
        const legacy = parsed as { grants?: unknown };
        this.state = { schemaVersion: 2, registrations: {}, grants: z.record(z.string(), grantLedgerGrantSchema).parse(legacy.grants ?? {}) };
      } else this.state = stateSchema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { schemaVersion: 2, registrations: {}, grants: {} };
    }
    this.loaded = true;
  }

  async ensureGrant(registration: GrantRegistration): Promise<GrantRecord> {
    return this.exclusive(() => {
      const grant = validateRegistration(registration);
      const existing = this.state.registrations[grant.grantId];
      if (existing) {
        if (existing.digest !== grant.digest) throw new Error('Delegation grant changed for an existing grant');
        if (existing.subjectAgentId !== grant.subjectAgentId || existing.issuerAgentId !== grant.issuerAgentId || existing.taskId !== grant.taskId || existing.revocationRef !== grant.revocationRef) throw new Error('Delegation grant binding changed for an existing grant');
        if (existing.status === 'active' && new Date(existing.expiresAt).getTime() <= Date.now()) this.expireGrant(existing);
        return structuredClone(existing);
      }
      if (new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error('Delegation grant has expired');
      const now = registration.registeredAt ?? new Date().toISOString();
      const created: GrantRecord = { ...grant, registeredAt: now, status: 'active', history: [{ status: 'active', at: now, actor: 'aeeis' }] };
      this.state.registrations[grant.grantId] = created;
      if (!this.state.grants[grant.grantId]) this.state.grants[grant.grantId] = { grantId: grant.grantId, budget: grantBudgetSchema.parse(registration.grant.budget), usedCalls: 0, usedTokens: 0, usedMoney: 0, entries: {} };
      return structuredClone(created);
    });
  }

  async getGrant(grantId: string): Promise<GrantRecord | undefined> {
    await this.init();
    const current = this.state.registrations[grantId];
    if (current && current.status === 'active' && new Date(current.expiresAt).getTime() <= Date.now()) {
      await this.exclusive(() => this.expireGrant(current));
      return structuredClone(this.state.registrations[grantId]);
    }
    return current ? structuredClone(current) : undefined;
  }

  async revokeGrant(grantId: string, input: { at?: string; actor?: string; reason?: string } = {}): Promise<GrantRecord> {
    return this.exclusive(() => {
      const current = this.state.registrations[grantId];
      if (!current) throw new Error('Unknown delegation grant');
      if (current.status === 'revoked') return structuredClone(current);
      const at = input.at ?? new Date().toISOString();
      current.status = 'revoked'; current.revokedAt = at;
      if (input.actor) current.revokedBy = input.actor;
      if (input.reason) current.revocationReason = input.reason;
      current.history.push({ status: 'revoked', at, ...(input.actor ? { actor: input.actor } : {}), ...(input.reason ? { reason: input.reason } : {}) });
      return structuredClone(current);
    });
  }

  private expireGrant(current: GrantRecord): void {
    if (current.status !== 'active') return;
    const at = new Date().toISOString(); current.status = 'expired'; current.history.push({ status: 'expired', at, actor: 'aeeis' });
  }

  async reserve(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void> {
    await this.exclusive(() => {
      this.assertRegisteredGrantUsable(grantId);
      const parsed = grantBudgetSchema.parse(budget);
      const grant = this.state.grants[grantId];
      if (grant && JSON.stringify(grant.budget) !== JSON.stringify(parsed)) throw new Error('Delegation grant budget changed for an existing grant');
      const current = grant ?? { grantId, budget: parsed, usedCalls: 0, usedTokens: 0, usedMoney: 0, entries: {} };
      const existing = current.entries[idempotencyKey];
      if (existing) throw new Error(existing.state === 'settled' ? 'Delegation grant call was already settled; reconcile the persisted receipt' : 'Delegation grant call is already reserved; reconcile before submitting again');
      if (current.budget.calls !== undefined && current.usedCalls >= current.budget.calls) throw new Error('Delegation grant call budget is exhausted');
      current.usedCalls += 1;
      current.entries[idempotencyKey] = { state: 'reserved', updatedAt: new Date().toISOString() };
      this.state.grants[grantId] = current;
    });
  }

  async markUnknown(grantId: string, idempotencyKey: string): Promise<void> {
    await this.exclusive(() => {
      const entry = this.requireEntry(grantId, idempotencyKey);
      if (entry.state === 'settled' || entry.state === 'rejected') return;
      entry.state = 'unknown'; entry.updatedAt = new Date().toISOString();
    });
  }

  async ensureUnknown(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void> {
    await this.exclusive(() => {
      const parsed = grantBudgetSchema.parse(budget);
      const existingGrant = this.state.grants[grantId];
      if (existingGrant && JSON.stringify(existingGrant.budget) !== JSON.stringify(parsed)) throw new Error('Delegation grant budget changed for an existing grant');
      const grant = existingGrant ?? { grantId, budget: parsed, usedCalls: 0, usedTokens: 0, usedMoney: 0, entries: {} };
      if (!grant.entries[idempotencyKey]) {
        this.assertRegisteredGrantUsable(grantId);
        if (grant.budget.calls !== undefined && grant.usedCalls >= grant.budget.calls) throw new Error('Delegation grant call budget is exhausted');
        grant.usedCalls += 1;
        grant.entries[idempotencyKey] = { state: 'unknown', updatedAt: new Date().toISOString() };
      }
      this.state.grants[grantId] = grant;
    });
  }

  async settle(grantId: string, idempotencyKey: string, usage: GrantUsage = {}): Promise<GrantAuthorizationReceipt> {
    return this.exclusive(() => {
      const parsed = grantUsageSchema.parse(usage);
      const grant = this.state.grants[grantId];
      const entry = this.requireEntry(grantId, idempotencyKey);
      if (entry.state === 'settled') {
        if (entry.authorization) return structuredClone(entry.authorization);
        const current = this.state.registrations[grantId];
        if (current?.status === 'active' && new Date(current.expiresAt).getTime() <= Date.now()) this.expireGrant(current);
        const fallback: GrantAuthorizationReceipt = { grantId, idempotencyKey, decision: current?.status === 'active' ? 'authorized' : 'isolated', grantStatus: current?.status ?? 'unregistered', settledAt: entry.updatedAt, ...(current?.digest ? { grantDigest: current.digest } : {}) };
        entry.authorization = fallback;
        return fallback;
      }
      if (entry.state === 'rejected') throw new Error('Delegation grant call was already rejected for exceeding its budget');
      const nextTokens = (grant?.usedTokens ?? 0) + (parsed.tokens ?? 0);
      const nextMoney = (grant?.usedMoney ?? 0) + (parsed.money ?? 0);
      if (grant?.budget.tokens !== undefined && nextTokens > grant.budget.tokens) {
        entry.state = 'rejected'; entry.usage = parsed; entry.updatedAt = new Date().toISOString();
        grant.usedTokens = nextTokens;
        this.state.grants[grantId] = grant;
        throw new Error('Delegation grant token budget is exhausted');
      }
      if (grant?.budget.money !== undefined && nextMoney > grant.budget.money) {
        entry.state = 'rejected'; entry.usage = parsed; entry.updatedAt = new Date().toISOString();
        grant.usedMoney = nextMoney;
        this.state.grants[grantId] = grant;
        throw new Error('Delegation grant money budget is exhausted');
      }
      if (grant) {
        grant.usedTokens = nextTokens; grant.usedMoney = nextMoney;
        this.state.grants[grantId] = grant;
      }
      const current = this.state.registrations[grantId];
      if (current?.status === 'active' && new Date(current.expiresAt).getTime() <= Date.now()) this.expireGrant(current);
      const settledAt = new Date().toISOString();
      const authorization: GrantAuthorizationReceipt = { grantId, idempotencyKey, decision: current?.status === 'active' ? 'authorized' : 'isolated', grantStatus: current?.status ?? 'unregistered', settledAt, ...(current?.digest ? { grantDigest: current.digest } : {}) };
      entry.state = 'settled'; entry.usage = parsed; entry.updatedAt = settledAt; entry.authorization = authorization;
      return authorization;
    });
  }

  async close(): Promise<void> { await this.tail; }

  private requireEntry(grantId: string, idempotencyKey: string) {
    const entry = this.state.grants[grantId]?.entries[idempotencyKey];
    if (!entry) throw new Error('Delegation grant reservation is missing; refuse an untracked external call');
    return entry;
  }

  private assertGrantUsable(grantId: string): GrantRecord {
    const current = this.state.registrations[grantId];
    if (!current) throw new Error('Delegation grant is not registered');
    if (current.status === 'active' && new Date(current.expiresAt).getTime() <= Date.now()) this.expireGrant(current);
    if (current.status !== 'active') throw new Error(`Delegation grant is ${current.status}`);
    return current;
  }

  private assertRegisteredGrantUsable(grantId: string): void {
    if (!this.state.registrations[grantId]) return; // legacy direct ledger callers
    this.assertGrantUsable(grantId);
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const result = await operation();
      this.persist();
      return result;
    } catch (error) {
      // Operations such as a budget rejection deliberately mutate the ledger
      // before throwing; persist that terminal state before surfacing the error.
      this.persist();
      throw error;
    } finally { release(); }
  }

  protected persist(): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      writeSync(descriptor, `${JSON.stringify(this.state, null, 2)}\n`, undefined, 'utf8');
      fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(tempPath, this.filePath);
      const directoryDescriptor = openSync(directory, 'r');
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(tempPath); } catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError; }
      throw error;
    }
  }
}

export class InMemoryGrantLedger extends FileGrantLedger {
  constructor() { super(`/tmp/aeeis-grant-ledger-${randomUUID()}.json`); }
  override async init(): Promise<void> { /* starts empty; persistence is unnecessary for isolated tests */ }
  override async close(): Promise<void> {}
  protected override persist(): void {}
}
