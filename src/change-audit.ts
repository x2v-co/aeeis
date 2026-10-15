import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const changeActorSchema = z.object({ kind: z.enum(['user', 'agent', 'system']), id: z.string().trim().min(1).max(200) }).strict();
export const changeReasonSchema = z.object({ taskId: z.string().trim().min(1).max(200).optional(), runId: z.string().trim().min(1).max(200).optional(), trigger: z.string().trim().min(1).max(4000) }).strict()
  .refine(reason => Boolean(reason.taskId || reason.runId), 'A task or run id is required');
export const changeAuditEntrySchema = z.object({
  id: z.string().min(1), subjectKind: z.enum(['memory', 'skill']), subjectId: z.string().min(1),
  op: z.enum(['create', 'update', 'delete', 'rollback']), actor: changeActorSchema, reason: changeReasonSchema,
  at: z.string().datetime({ offset: true }), before: z.json(), after: z.json(),
  prevHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ChangeActor = z.infer<typeof changeActorSchema>;
export type ChangeReason = z.infer<typeof changeReasonSchema>;
export interface ChangeContext { actor: ChangeActor; reason: ChangeReason }
export type ChangeAuditEntry = z.infer<typeof changeAuditEntrySchema>;
export type ChangeAuditInput = ChangeContext & {
  subjectKind: ChangeAuditEntry['subjectKind']; subjectId: string; op: ChangeAuditEntry['op']; before: unknown; after: unknown;
};
export type MaybePromise<T> = T | Promise<T>;
export interface ChangeAuditApi {
  list(): MaybePromise<ChangeAuditEntry[]>;
  verifyChain(expectedHead?: string | null): MaybePromise<boolean>;
  rollback(entryId: string, actor: ChangeActor, reason: ChangeReason): MaybePromise<ChangeAuditEntry>;
}
export class ChangeAuditConflict extends Error {}

/** Canonical JSON survives JSONB object-key reordering. Snapshots are JSON, never live references. */
export function canonicalJson(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(normalized));
}
export function changeAuditHash(entry: Omit<ChangeAuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex');
}

/** A chain needs an externally retained head hash to detect removal of a valid suffix. */
export function verifyChain(entries: readonly ChangeAuditEntry[], expectedHead?: string | null): boolean {
  let previous: string | null = null;
  const ids = new Set<string>();
  try {
    for (const entry of entries) {
      changeAuditEntrySchema.parse(entry);
      const { hash, ...payload } = entry;
      if (ids.has(entry.id) || entry.prevHash !== previous || changeAuditHash(payload) !== hash) return false;
      ids.add(entry.id); previous = hash;
    }
    return expectedHead === undefined || expectedHead === previous;
  } catch { return false; }
}

export class ChangeAuditLog {
  private entries: ChangeAuditEntry[];
  constructor(entries: readonly ChangeAuditEntry[] = []) {
    if (!verifyChain(entries)) throw new ChangeAuditConflict('Change audit chain is invalid');
    this.entries = structuredClone([...entries]);
  }
  list(): ChangeAuditEntry[] { return structuredClone(this.entries); }
  verifyChain(expectedHead?: string | null): boolean { return verifyChain(this.entries, expectedHead); }
  get(id: string): ChangeAuditEntry {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new ChangeAuditConflict('Unknown change audit entry');
    return structuredClone(entry);
  }
  append(input: ChangeAuditInput): ChangeAuditEntry {
    if (!this.verifyChain()) throw new ChangeAuditConflict('Change audit chain is invalid');
    const payload = changeAuditEntrySchema.omit({ hash: true }).parse({ ...JSON.parse(JSON.stringify(input)), id: `change_${randomUUID()}`, at: new Date().toISOString(), prevHash: this.entries.at(-1)?.hash ?? null });
    const entry = { ...payload, hash: changeAuditHash(payload) };
    this.entries.push(entry);
    return structuredClone(entry);
  }
  /** Only restores the selected subject. Later changes remain in the log. */
  rollback(entryId: string, actor: ChangeActor, reason: ChangeReason, read: (entry: ChangeAuditEntry) => unknown, restore: (entry: ChangeAuditEntry, snapshot: unknown) => void): ChangeAuditEntry {
    changeActorSchema.parse(actor); changeReasonSchema.parse(reason);
    const entry = this.get(entryId), before = read(entry);
    const rollback = this.append({ subjectKind: entry.subjectKind, subjectId: entry.subjectId, op: 'rollback', actor, reason, before, after: entry.before });
    try { restore(entry, structuredClone(entry.before)); }
    catch (error) { this.entries.pop(); throw error; }
    return rollback;
  }
}

/** The transaction argument lets PostgreSQL targets use the audit transaction's client. */
export interface ChangeAuditStore<Tx = undefined> {
  list(): MaybePromise<ChangeAuditEntry[]>;
  transaction<T>(work: (log: ChangeAuditLog, tx: Tx) => MaybePromise<T>): Promise<T>;
}
export class InMemoryChangeAuditStore implements ChangeAuditStore {
  private log = new ChangeAuditLog();
  private queue: Promise<unknown> = Promise.resolve();
  list(): ChangeAuditEntry[] { return this.log.list(); }
  transaction<T>(work: (log: ChangeAuditLog, tx: undefined) => MaybePromise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const log = new ChangeAuditLog(this.log.list());
      const result = await work(log, undefined);
      this.log = log;
      return result;
    });
    this.queue = next.catch(() => undefined); return next;
  }
}
export interface ChangeAuditTarget<Tx> {
  read(entry: ChangeAuditEntry, tx: Tx): MaybePromise<unknown>;
  restore(entry: ChangeAuditEntry, snapshot: unknown, tx: Tx): MaybePromise<void>;
}
export class ChangeAuditService<Tx = undefined> {
  constructor(readonly store: ChangeAuditStore<Tx>, private readonly target: ChangeAuditTarget<Tx>) {}
  async list(): Promise<ChangeAuditEntry[]> { return this.store.list(); }
  async verifyChain(expectedHead?: string | null): Promise<boolean> { return verifyChain(await this.list(), expectedHead); }
  rollback(entryId: string, actor: ChangeActor, reason: ChangeReason): Promise<ChangeAuditEntry> {
    changeActorSchema.parse(actor); changeReasonSchema.parse(reason);
    return this.store.transaction(async (log, tx) => {
      const entry = log.get(entryId), before = await this.target.read(entry, tx);
      // Validate and hash before changing the subject. The store publishes only on success.
      const rollback = log.append({ subjectKind: entry.subjectKind, subjectId: entry.subjectId, op: 'rollback', actor, reason, before, after: entry.before });
      await this.target.restore(entry, structuredClone(entry.before), tx);
      return rollback;
    });
  }
}
