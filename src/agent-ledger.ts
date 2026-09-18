import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';

export interface GrantBudget {
  calls?: number | undefined;
  tokens?: number | undefined;
  money?: number | undefined;
}

export interface GrantUsage {
  tokens?: number | undefined;
  money?: number | undefined;
}

export interface GrantLedger {
  reserve(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void>;
  ensureUnknown(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void>;
  markUnknown(grantId: string, idempotencyKey: string): Promise<void>;
  settle(grantId: string, idempotencyKey: string, usage?: GrantUsage): Promise<void>;
  close(): Promise<void>;
}

const budgetSchema = z.object({
  calls: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
  money: z.number().nonnegative().optional(),
}).strict();
const usageSchema = z.object({
  tokens: z.number().int().nonnegative().optional(),
  money: z.number().nonnegative().optional(),
}).strict();
const entrySchema = z.object({
  state: z.enum(['reserved', 'unknown', 'settled', 'rejected']),
  updatedAt: z.string().datetime({ offset: true }),
  usage: usageSchema.optional(),
}).strict();
const grantSchema = z.object({
  grantId: z.string().min(1),
  budget: budgetSchema,
  usedCalls: z.number().int().nonnegative(),
  usedTokens: z.number().int().nonnegative(),
  usedMoney: z.number().nonnegative(),
  entries: z.record(z.string(), entrySchema),
}).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), grants: z.record(z.string(), grantSchema) }).strict();
type LedgerState = z.infer<typeof stateSchema>;

/**
 * Durable admission and accounting for external Agent grants.
 * A call is consumed when it is reserved, so a crash cannot make an
 * already-issued side effect available for an unbounded retry.
 */
export class FileGrantLedger implements GrantLedger {
  private state: LedgerState = { schemaVersion: 1, grants: {} };
  private loaded = false;
  private tail = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = stateSchema.parse(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { schemaVersion: 1, grants: {} };
    }
    this.loaded = true;
  }

  async reserve(grantId: string, idempotencyKey: string, budget: GrantBudget): Promise<void> {
    await this.exclusive(() => {
      const parsed = budgetSchema.parse(budget);
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
      const parsed = budgetSchema.parse(budget);
      const existingGrant = this.state.grants[grantId];
      if (existingGrant && JSON.stringify(existingGrant.budget) !== JSON.stringify(parsed)) throw new Error('Delegation grant budget changed for an existing grant');
      const grant = existingGrant ?? { grantId, budget: parsed, usedCalls: 0, usedTokens: 0, usedMoney: 0, entries: {} };
      if (!grant.entries[idempotencyKey]) {
        if (grant.budget.calls !== undefined && grant.usedCalls >= grant.budget.calls) throw new Error('Delegation grant call budget is exhausted');
        grant.usedCalls += 1;
        grant.entries[idempotencyKey] = { state: 'unknown', updatedAt: new Date().toISOString() };
      }
      this.state.grants[grantId] = grant;
    });
  }

  async settle(grantId: string, idempotencyKey: string, usage: GrantUsage = {}): Promise<void> {
    await this.exclusive(() => {
      const parsed = usageSchema.parse(usage);
      const grant = this.state.grants[grantId];
      const entry = this.requireEntry(grantId, idempotencyKey);
      if (entry.state === 'settled') return;
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
      entry.state = 'settled'; entry.usage = parsed; entry.updatedAt = new Date().toISOString();
    });
  }

  async close(): Promise<void> { await this.tail; }

  private requireEntry(grantId: string, idempotencyKey: string) {
    const entry = this.state.grants[grantId]?.entries[idempotencyKey];
    if (!entry) throw new Error('Delegation grant reservation is missing; refuse an untracked external call');
    return entry;
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
