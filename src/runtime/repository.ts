import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import { FileRunShareStore, PostgresRunShareStore, runSharesMigration, type RunShareStore } from './run-shares.js';
import { FileThreadShareStore, PostgresThreadShareStore, threadSharesMigration, type ThreadShareStore } from './thread-shares.js';
import type { AgentRun } from './contracts.js';
import { withPostgresMigrationLock } from '../adapters/postgres-migration.js';
import { scopedRecent, validateCollectionLimit } from '../adapters/collection-query.js';
import { assertFollowupParent, assertMembershipUnchanged, assertUnthreaded, prepareAttachment, threadSchema, threadsMigration, ThreadConflict, validateThreadSequence, type Thread, type ThreadRepository } from './threads.js';
import { assertThreadHistoryUnchanged } from './thread-history.js';
import { assertFollowupCheckpoint, assertFollowupCommit, assertSameFollowup, FollowupLocks, threadFollowupsMigration, type ThreadFollowup } from './thread-followups.js';

export interface RunRepository extends ThreadRepository {
  readonly shares?: RunShareStore;
  readonly threadShares?: ThreadShareStore;
  create(run: AgentRun): Promise<void>;
  get(id: string, scope?: Ownership): Promise<AgentRun>;
  list(scope?: Ownership, limit?: number): Promise<AgentRun[]>;
  /** Lightweight dependency probe that must not load the Run history. */
  health?(): Promise<void>;
  /** Tenant-bounded discovery used by Room-shared read views. */
  listByTenant?(tenantId: string, limit?: number): Promise<AgentRun[]>;
  /** Stable keyset page for long-lived history views. */
  page?(scope: Ownership, limit: number, cursor?: string): Promise<RunPage>;
  /** Storage-side shared read page. The repository applies tenant, goal and
   * privacy predicates before LIMIT so Room-shared history does not require
   * loading the entire tenant into the API process. */
  pageVisible?(scope: Ownership, readableGoalIds: readonly string[], limit: number, cursor?: string): Promise<RunPage>;
  /** Paginated event projection for timeline/changefeed consumers. */
  eventsPage?(id: string, scope: Ownership, limit: number, cursor?: string): Promise<RunEventsPage>;
  /** Bounded cyclic background scan; immutable IDs avoid chasing own writes. */
  scanPage?(query: RunScanQuery): Promise<RunScanPage>;
  /** Bounded metadata scan for consumers that can read the event projection. */
  scanEventsPage?(query: RunScanQuery): Promise<RunEventScanPage>;
  /** Bounded scan for Runs whose durable state may need crash recovery. */
  scanRecoveryPage?(query: RunScanQuery): Promise<RunRecoveryScanPage>;
  /** Low-latency hint for consumers; durable scanners remain the recovery path. */
  subscribeChanges?(handler: (change: RunChange) => void | Promise<void>): Promise<() => Promise<void>>;
  /** Holds the Run lock through the callback and commit. Async callbacks must
   * not re-enter this repository; external ledger writes remain recoverable. */
  mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun>;
  close(): Promise<void>;
}
export interface RunChange { runId: string; owner: string; tenantId: string; lastEventSeq: number; updatedAt: string }
export interface RunScanQuery { afterId?: string; throughId?: string; limit: number }
export interface RunScanPage { runs: AgentRun[]; throughId?: string; done: boolean }
/** Lightweight records used by replay pumps. The Run state is loaded only
 * after the event projection reports work for a record. */
export interface RunEventScanRecord { id: string; owner: string; tenantId: string; eventCount: number; lastEventSeq: number }
export interface RunEventScanPage { runs: RunEventScanRecord[]; throughId?: string; done: boolean }
export interface RunRecoveryScanRecord { id: string; owner: string; tenantId: string }
export interface RunRecoveryScanPage { runs: RunRecoveryScanRecord[]; throughId?: string; done: boolean }
export interface RunPage { runs: AgentRun[]; nextCursor?: string }
export interface RunEventsPage { events: AgentRun['events']; nextCursor?: string }
function validateScan(query: RunScanQuery): void {
  validateCollectionLimit(query.limit);
  if (query.afterId !== undefined) validateId(query.afterId);
  if (query.throughId !== undefined) validateId(query.throughId);
}
export class NotFound extends Error {}
function validateId(id: string): void {
  if (!/^run_[a-f0-9-]{36}$/.test(id)) throw new NotFound('Unknown run');
}
function validateThreadId(id: string): void {
  if (!/^thread_[a-f0-9-]{36}$/.test(id)) throw new NotFound('Unknown thread');
}
type PageKey = { updatedAt: string; id: string };
type FileRunSummary = { id: string; owner: string; tenantId: string; updatedAt: string; eventCount: number; privacy: AgentRun['privacy']; goalId?: string; lastEventId?: string; lastEventSeq?: number; needsRecovery: boolean; threadId?: string; threadSequence?: number };
type FileThreadCreation = { thread: Thread; run: AgentRun; before: AgentRun; state: 'commit' | 'rollback' };
function encodePageKey(key: PageKey): string { return Buffer.from(JSON.stringify({ updatedAt: key.updatedAt, id: key.id }), 'utf8').toString('base64url'); }
function decodePageKey(value: string | undefined): PageKey | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PageKey>;
    if (typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt)) || typeof parsed.id !== 'string') throw new Error();
    validateId(parsed.id);
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch { throw new RangeError('Invalid run page cursor'); }
}
function recentRunCompare(left: { id: string; updatedAt: string }, right: { id: string; updatedAt: string }): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
function afterPageKey(item: { id: string; updatedAt: string }, cursor: PageKey | undefined): boolean {
  if (!cursor) return true;
  const time = Date.parse(item.updatedAt), cursorTime = Date.parse(cursor.updatedAt);
  return time < cursorTime || (time === cursorTime && item.id > cursor.id);
}
export function encodeRunEventCursor(seq: number): string { return Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url'); }
function decodeEventCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { seq?: unknown };
    if (!Number.isSafeInteger(parsed.seq) || (parsed.seq as number) < 0) throw new Error();
    return parsed.seq as number;
  } catch { throw new RangeError('Invalid run event cursor'); }
}

// Single-process local adapter. The lock prevents two API processes from sharing a directory.
// Mutations write a complete run aggregate (state, receipts, artifacts) in one replacement.
export class FileRunRepository implements RunRepository {
  readonly shares: RunShareStore;
  readonly threadShares: ThreadShareStore;
  private queue: Promise<unknown> = Promise.resolve();
  private lockPath: string;
  private indexPath: string;
  private summaries: Map<string, FileRunSummary> | undefined;
  private threadCommit: Promise<void> | undefined;
  private threadFailure: unknown;
  private followupLocks = new FollowupLocks();
  private readonly changeSubscribers = new Set<(change: RunChange) => void | Promise<void>>();
  constructor(private directory: string) { this.shares = new FileRunShareStore(directory); this.threadShares = new FileThreadShareStore(directory); this.lockPath = join(directory, '.writer.lock'); this.indexPath = join(directory, '.runs.index.json'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      await lock.writeFile(String(process.pid)); await lock.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid repository lock; inspect before recovery');
      try { process.kill(pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(this.lockPath); return this.init(); }
        throw e;
      }
      throw new Error('Data directory already has a live writer');
    }
    try { await this.recoverThreadCreations(); await this.recoverFollowupCommits(); }
    catch (error) { await unlink(this.lockPath); throw error; }
  }
  async health(): Promise<void> {
    await stat(this.directory);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.threadFailure) throw this.threadFailure; return operation(); });
    this.queue = next.catch(() => {});
    return next;
  }
  private path(id: string): string { validateId(id); return join(this.directory, `${id}.json`); }
  private eventPath(id: string): string { validateId(id); return join(this.directory, `${id}.events.json`); }
  private async saveEvents(run: AgentRun): Promise<void> {
    const path = this.eventPath(run.id), temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(run.events)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  }
  private async saveIndex(): Promise<void> {
    if (!this.summaries) return;
    const entries = await Promise.all([...this.summaries.values()].map(async summary => {
      const file = await stat(this.path(summary.id));
      return { ...summary, size: file.size, mtimeMs: file.mtimeMs };
    }));
    const temp = `${this.indexPath}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 3, entries }));
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, this.indexPath);
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async subscribeChanges(handler: (change: RunChange) => void | Promise<void>): Promise<() => Promise<void>> {
    this.changeSubscribers.add(handler);
    return async () => { this.changeSubscribers.delete(handler); };
  }
  private async save(run: AgentRun): Promise<void> {
    const path = this.path(run.id), temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(run)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    // Keep cached summaries aligned with the canonical commit even if a
    // later projection write fails; retries may not call save again.
    this.summaries?.set(run.id, this.summary(run));
    // The event file is a disposable projection. If this write fails, the
    // canonical aggregate remains authoritative and eventsPage falls back to it.
    await this.saveEvents(run);
    // The index is a disposable acceleration structure. Canonical Run and
    // event files are already durable; if index publication fails, the next
    // process rebuilds it from those files.
    try { await this.saveIndex(); } catch { /* best effort; canonical state is already durable */ }
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
    const change: RunChange = { runId: run.id, owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local', lastEventSeq: run.events.at(-1)?.seq ?? 0, updatedAt: run.updatedAt };
    for (const subscriber of this.changeSubscribers) {
      const hint = { ...change };
      void Promise.resolve().then(() => subscriber(hint)).catch(() => undefined);
    }
  }
  create(run: AgentRun): Promise<void> {
    return this.serial(async () => {
      assertUnthreaded(run);
      try { await this.get(run.id); throw new Error('Run already exists'); }
      catch (e) { if (!(e instanceof NotFound)) throw e; }
      await this.save(run);
    });
  }
  async get(id: string, scope?: Ownership): Promise<AgentRun> {
    await this.threadCommit;
    if (this.threadFailure) throw this.threadFailure;
    try {
      const run = JSON.parse(await readFile(this.path(id), 'utf8')) as AgentRun;
      if (scope && !isOwnedBy(run, scope)) throw new NotFound('Unknown run');
      return run;
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound('Unknown run'); throw e; }
  }
  private threadPath(id: string): string { validateThreadId(id); return join(this.directory, `${id}.json`); }
  private async syncDirectory(): Promise<void> {
    const dir = await open(this.directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  private async replaceJson(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    await this.syncDirectory();
  }
  /** Journal for the two-file root attachment transaction. */
  private async recoverThreadCreations(): Promise<void> {
    const journals = (await readdir(this.directory)).filter(name => /^\.thread-create-thread_[a-f0-9-]{36}\.json$/.test(name));
    for (const name of journals) {
      const path = join(this.directory, name);
      const transaction = JSON.parse(await readFile(path, 'utf8')) as FileThreadCreation;
      const thread = threadSchema.parse(transaction.thread);
      if (transaction.state === 'rollback') {
        await this.replaceJson(this.path(transaction.before.id), transaction.before);
        await unlink(this.threadPath(thread.id)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        await unlink(path); await this.syncDirectory();
        continue;
      }
      if (transaction.state !== 'commit') throw new Error('Invalid thread creation journal');
      const existing = await this.get(transaction.run.id).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
      // A committed root may already have advanced after journal cleanup failed.
      const run = existing?.threadId === thread.id ? existing : transaction.run;
      await this.replaceJson(this.path(run.id), run);
      await this.replaceJson(this.threadPath(thread.id), thread);
      await unlink(path);
      await this.syncDirectory();
    }
  }
  createThread(thread: Thread, initialRunId?: string): Promise<void> {
    return this.serial(async () => {
      const record = threadSchema.parse(thread);
      try { await this.getThread(record.id); throw new ThreadConflict('Thread already exists'); }
      catch (error) { if (!(error instanceof NotFound)) throw error; }
      if (initialRunId === undefined) { await this.replaceJson(this.threadPath(record.id), record); return; }
      const before = await this.get(initialRunId, record), run = structuredClone(before);
      assertUnthreaded(run);
      prepareAttachment(run, record, undefined, 0);
      let release!: () => void;
      this.threadCommit = new Promise<void>(resolve => { release = resolve; });
      const journal = join(this.directory, `.thread-create-${record.id}.json`);
      let committed = false;
      try {
        await this.replaceJson(journal, { thread: record, run, before, state: 'commit' } satisfies FileThreadCreation);
        await this.replaceJson(this.path(run.id), run);
        await this.replaceJson(this.threadPath(record.id), record);
        committed = true;
        this.summaries?.set(run.id, this.summary(run));
        try { await unlink(journal); await this.syncDirectory(); } catch { /* committed journal replay preserves newer root state */ }
        // Projections can be rebuilt; both canonical records are committed.
        try { await this.save(run); } catch { /* disposable projections */ }
      } catch (error) {
        if (!committed) {
          try {
            // Make rollback intent durable before restoring either canonical file.
            await this.replaceJson(journal, { thread: record, run, before, state: 'rollback' } satisfies FileThreadCreation);
            await this.replaceJson(this.path(before.id), before);
            await unlink(this.threadPath(record.id)).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
            await unlink(journal); await this.syncDirectory();
          } catch (rollbackError) {
            // Block reads/writes until restart recovery; never expose partial state.
            this.threadFailure = rollbackError;
          }
        }
        throw error;
      } finally { release(); this.threadCommit = undefined; }
    });
  }
  async getThread(id: string, scope?: Ownership): Promise<Thread> {
    await this.threadCommit;
    if (this.threadFailure) throw this.threadFailure;
    try {
      const thread = JSON.parse(await readFile(this.threadPath(id), 'utf8')) as Thread;
      if (scope && !isOwnedBy(thread, scope)) throw new NotFound('Unknown thread');
      return thread;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound('Unknown thread'); throw error; }
  }
  listRunsByThread(id: string, scope?: Ownership, limit?: number, afterSequence = 0): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      validateThreadSequence(afterSequence);
      const thread = await this.getThread(id, scope);
      await this.ensureSummaries();
      const selected = [...this.summaries!.values()].filter(run => run.threadId === id && run.threadSequence! > afterSequence && isOwnedBy(run, thread))
        .sort((a, b) => a.threadSequence! - b.threadSequence!).slice(0, limit);
      return Promise.all(selected.map(run => this.get(run.id, thread)));
    });
  }
  latestRunByThread(id: string, scope?: Ownership): Promise<AgentRun | undefined> {
    return this.serial(async () => {
      const thread = await this.getThread(id, scope);
      await this.ensureSummaries();
      const latest = [...this.summaries!.values()].filter(run => run.threadId === id && isOwnedBy(run, thread))
        .sort((a, b) => b.threadSequence! - a.threadSequence!)[0];
      return latest ? this.get(latest.id, thread) : undefined;
    });
  }
  createRunInThread(input: AgentRun, threadId: string, parentRunId?: string, scope?: Ownership, parentSnapshot?: string | number, followup?: ThreadFollowup): Promise<AgentRun> {
    return this.serial(async () => {
      const thread = await this.getThread(threadId, scope), run = structuredClone(input);
      if (followup) {
        const reservation = await this.getThreadFollowup(threadId, followup.keyHash, thread);
        if (!reservation) throw new ThreadConflict('Missing follow-up reservation');
        assertSameFollowup(reservation, followup.requestHash);
        assertFollowupCommit(reservation, run, threadId, parentRunId);
        parentSnapshot = reservation.contextSnapshot.parentHistoryHash ?? reservation.parentRevision;
      }
      assertUnthreaded(run);
      try { await this.get(run.id); throw new ThreadConflict('Run already exists'); }
      catch (error) { if (!(error instanceof NotFound)) throw error; }
      const parent = parentRunId === undefined ? undefined : await this.get(parentRunId, thread);
      assertFollowupParent(parent, parentSnapshot);
      await this.ensureSummaries();
      const last = [...this.summaries!.values()].filter(item => item.threadId === threadId).reduce((max, item) => Math.max(max, item.threadSequence!), 0);
      prepareAttachment(run, thread, parent, last);
      if (followup) {
        // The linked Run is the journal's commit intent. Readers cannot observe
        // it until the reservation and canonical membership are both published.
        let release!: () => void;
        this.threadCommit = new Promise<void>(resolve => { release = resolve; });
        try {
          const record: ThreadFollowup = { ...followup, contextSnapshot: { ...followup.contextSnapshot, run } };
          await this.replaceJson(this.followupPath(threadId, followup.keyHash), record);
          await this.replaceJson(this.path(run.id), run);
          await this.replaceJson(this.followupPath(threadId, followup.keyHash), { ...record, state: 'completed' });
          this.summaries?.set(run.id, this.summary(run));
          try { await this.save(run); } catch { /* disposable projections */ }
        } catch (error) {
          // Replay the durable commit intent at init before serving or dispatching.
          this.threadFailure = error;
          throw error;
        } finally { release(); this.threadCommit = undefined; }
      } else await this.save(run);
      return run;
    });
  }
  private followupPath(threadId: string, keyHash: string): string {
    validateThreadId(threadId);
    if (!/^[a-f0-9]{64}$/.test(keyHash)) throw new RangeError('Invalid follow-up key hash');
    return join(this.directory, `.thread-followup-${threadId}-${keyHash}.json`);
  }
  async withThreadFollowupLock<T>(threadId: string, keyHash: string, scope: Ownership, operation: () => Promise<T>): Promise<T> {
    await this.getThread(threadId, scope);
    return this.followupLocks.withLock(`${threadId}/${keyHash}`, operation);
  }
  async getThreadFollowup(threadId: string, keyHash: string, scope: Ownership): Promise<ThreadFollowup | undefined> {
    await this.getThread(threadId, scope);
    try { return JSON.parse(await readFile(this.followupPath(threadId, keyHash), 'utf8')) as ThreadFollowup; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  saveThreadFollowup(record: ThreadFollowup, scope: Ownership): Promise<void> {
    return this.serial(async () => {
      const before = await this.getThreadFollowup(record.threadId, record.keyHash, scope);
      assertFollowupCheckpoint(before, record);
      await this.replaceJson(this.followupPath(record.threadId, record.keyHash), record);
    });
  }
  async *pendingThreadFollowups(): AsyncIterable<ThreadFollowup> {
    const names = (await readdir(this.directory)).filter(name => /^\.thread-followup-thread_[a-f0-9-]{36}-[a-f0-9]{64}\.json$/.test(name)).sort();
    for (const name of names) {
      const record = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as ThreadFollowup;
      if (record.state === 'reserved') yield record;
    }
  }
  private async recoverFollowupCommits(): Promise<void> {
    for await (const record of this.pendingThreadFollowups()) {
      const prepared = record.contextSnapshot.run;
      if (!prepared?.threadId) continue;
      const thread = await this.getThread(record.threadId);
      if (prepared.id !== record.runId || prepared.threadId !== thread.id || prepared.parentRunId !== record.parentRunId || !isOwnedBy(prepared, thread)) throw new Error('Invalid follow-up commit journal');
      const existing = await this.get(record.runId, thread).catch(error => { if (error instanceof NotFound) return undefined; throw error; });
      if (existing && (existing.threadId !== thread.id || existing.threadSequence !== prepared.threadSequence)) throw new Error('Conflicting follow-up commit journal');
      // Never overwrite progress committed after the journal publication.
      if (!existing) await this.replaceJson(this.path(record.runId), prepared);
      await this.replaceJson(this.followupPath(record.threadId, record.keyHash), { ...record, state: 'completed' });
    }
  }
  attachRunToThread(runId: string, threadId: string, parentRunId?: string, scope?: Ownership): Promise<AgentRun> {
    return this.serial(async () => {
      const thread = await this.getThread(threadId, scope);
      const run = await this.get(runId, thread);
      const parent = parentRunId === undefined ? undefined : await this.get(parentRunId, thread);
      await this.ensureSummaries();
      const lastSequence = [...this.summaries!.values()].filter(item => item.threadId === threadId).reduce((max, item) => Math.max(max, item.threadSequence!), 0);
      if (prepareAttachment(run, thread, parent, lastSequence)) await this.save(run);
      return run;
    });
  }
  private summary(run: AgentRun): FileRunSummary {
    const needsRecovery = run.calls.some(call => call.state === 'started')
      || Boolean(run.pendingTool && (!run.pendingTool.receiptId || run.pendingTool.executionToken || run.pendingTool.reconcileInFlight === true))
      // An `unknown` run whose pending tool carries a receipt may be an
      // interrupted read-only call that boot recovery re-queues.
      || Boolean(run.status === 'unknown' && run.pendingTool?.receiptId)
      || Boolean(run.pendingDelegation && (!run.pendingDelegation.receiptRef || run.pendingDelegation.executionToken || run.pendingDelegation.reconcileInFlight === true))
      // Recovery also performs idempotent domain and Project Pulse projection
      // after a crash between the Run commit and the projection commit.
      || Boolean(run.taskExecution)
      || Boolean(run.goalId && run.domainPlanId)
      || Boolean(run.status === 'succeeded' && run.goalId && (run.builtinSkill === 'project-pulse/1' || run.projectSourceQuery)
        && !run.events.some(item => item.type === 'project-pulse.next-actions.projected'));
    const privacy: AgentRun['privacy'] = run.privacy ?? 'internal';
    return { id: run.id, owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local', updatedAt: run.updatedAt, eventCount: run.events.length, privacy, ...(run.goalId ? { goalId: run.goalId } : {}), ...(run.threadId ? { threadId: run.threadId, threadSequence: run.threadSequence! } : {}), needsRecovery, ...(run.events.length ? { lastEventId: run.events.at(-1)!.id, lastEventSeq: run.events.at(-1)!.seq } : { lastEventSeq: 0 }) };
  }
  private async ensureSummaries(): Promise<void> {
    if (this.summaries) return;
    const files = (await readdir(this.directory)).filter(file => /^run_[a-f0-9-]{36}\.json$/.test(file));
    const ids = files.map(file => file.slice(0, -5)).sort();
    const indexed = await this.loadIndex(ids);
    if (indexed) { this.summaries = indexed; return; }
    // Rebuild from canonical records only when the durable acceleration
    // structure is missing, malformed, or does not match the files. File
    // mtimes and UUIDs are never used for logical ordering; they only detect
    // a write that happened after the previous index publication.
    const summaries = new Map<string, FileRunSummary>();
    for (const id of ids) {
      const run = await this.get(id);
      summaries.set(run.id, this.summary(run));
    }
    this.summaries = summaries;
  }
  private async loadIndex(ids: string[]): Promise<Map<string, FileRunSummary> | undefined> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(this.indexPath, 'utf8')); } catch { return undefined; }
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 3 || !Array.isArray((raw as { entries?: unknown }).entries)) return undefined;
    const entries = (raw as { entries: unknown[] }).entries;
    if (entries.length !== ids.length) return undefined;
    const byId = new Map<string, FileRunSummary>();
    for (const item of entries) {
      if (!item || typeof item !== 'object') return undefined;
      const value = item as Record<string, unknown>;
      if (typeof value.id !== 'string' || !/^run_[a-f0-9-]{36}$/.test(value.id)
        || typeof value.owner !== 'string' || typeof value.tenantId !== 'string'
        || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
        || !Number.isSafeInteger(value.eventCount) || (value.eventCount as number) < 0
        || !['public', 'internal', 'confidential', 'private'].includes(String(value.privacy))
        || (value.goalId !== undefined && typeof value.goalId !== 'string')
        || (value.threadId !== undefined && (typeof value.threadId !== 'string' || !/^thread_[a-f0-9-]{36}$/.test(value.threadId) || !Number.isSafeInteger(value.threadSequence) || (value.threadSequence as number) < 1))
        || (value.threadId === undefined && value.threadSequence !== undefined)
        || typeof value.needsRecovery !== 'boolean' || !Number.isFinite(value.size as number)
        || !Number.isFinite(value.mtimeMs as number) || byId.has(value.id)) return undefined;
      const file = await stat(this.path(value.id)).catch(() => undefined);
      if (!file || file.size !== value.size || file.mtimeMs !== value.mtimeMs) return undefined;
      const privacy: AgentRun['privacy'] = value.privacy === 'public' || value.privacy === 'internal' || value.privacy === 'confidential' || value.privacy === 'private' ? value.privacy : 'internal';
      const summary: FileRunSummary = {
        id: value.id, owner: value.owner, tenantId: value.tenantId, updatedAt: value.updatedAt,
        eventCount: value.eventCount as number,
        privacy,
        ...(typeof value.goalId === 'string' ? { goalId: value.goalId } : {}),
        ...(typeof value.threadId === 'string' ? { threadId: value.threadId, threadSequence: value.threadSequence as number } : {}),
        needsRecovery: value.needsRecovery,
        ...(typeof value.lastEventId === 'string' ? { lastEventId: value.lastEventId } : {}),
        ...(Number.isSafeInteger(value.lastEventSeq) ? { lastEventSeq: value.lastEventSeq as number } : {}),
      };
      byId.set(summary.id, summary);
    }
    if (ids.some(id => !byId.has(id))) return undefined;
    return byId;
  }
  list(scope?: Ownership, limit?: number): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      await this.ensureSummaries();
      const selected = scopedRecent([...this.summaries!.values()], item => item.updatedAt, scope, limit);
      return Promise.all(selected.map(item => this.get(item.id, scope)));
    });
  }
  listByTenant(tenantId: string, limit?: number): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      await this.ensureSummaries();
      const selected = scopedRecent([...this.summaries!.values()], item => item.updatedAt, undefined)
        .filter(item => item.tenantId === tenantId)
        .slice(0, limit);
      return Promise.all(selected.map(item => this.get(item.id)));
    });
  }
  page(scope: Ownership, limit: number, cursor?: string): Promise<RunPage> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      const pageKey = decodePageKey(cursor);
      await this.ensureSummaries();
      const selected = [...(this.summaries ?? new Map()).values()]
        .filter(item => isOwnedBy(item, scope) && afterPageKey(item, pageKey))
        .sort(recentRunCompare);
      const page = selected.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      return { runs: await Promise.all(visible.map(item => this.get(item.id, scope))), ...(hasMore && visible.length ? { nextCursor: encodePageKey(visible.at(-1)!) } : {}) };
    });
  }
  pageVisible(scope: Ownership, readableGoalIds: readonly string[], limit: number, cursor?: string): Promise<RunPage> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      const pageKey = decodePageKey(cursor);
      await this.ensureSummaries();
      const goals = new Set(readableGoalIds);
      const selected = [...(this.summaries ?? new Map()).values()]
        .filter(item => item.tenantId === scope.tenantId && (item.owner === scope.owner || (item.goalId !== undefined && goals.has(item.goalId) && (item.privacy === 'public' || item.privacy === 'internal'))))
        .filter(item => afterPageKey(item, pageKey))
        .sort(recentRunCompare);
      const page = selected.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      const runs = await Promise.all(visible.map(item => this.get(item.id)));
      return { runs, ...(hasMore && visible.length ? { nextCursor: encodePageKey(visible.at(-1)!) } : {}) };
    });
  }
  eventsPage(id: string, scope: Ownership, limit: number, cursor?: string): Promise<RunEventsPage> {
    return this.serial(async () => {
      validateId(id); validateCollectionLimit(limit);
      const afterSeq = decodeEventCursor(cursor);
      await this.ensureSummaries();
      const summary = this.summaries!.get(id);
      if (!summary || !isOwnedBy(summary, scope)) throw new NotFound('Unknown run');
      let events: AgentRun['events'];
      try { events = JSON.parse(await readFile(this.eventPath(id), 'utf8')) as AgentRun['events']; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        events = (await this.get(id, scope)).events;
      }
      if (events.length !== summary.eventCount || (events.length > 0 && events.at(-1)!.id !== summary.lastEventId)) events = (await this.get(id, scope)).events;
      const selected = events.filter(event => event.seq > afterSeq).sort((a, b) => a.seq - b.seq);
      const page = selected.slice(0, limit + 1); const hasMore = page.length > limit;
      const visible = hasMore ? page.slice(0, limit) : page;
      return { events: visible, ...(hasMore && visible.length ? { nextCursor: encodeRunEventCursor(visible.at(-1)!.seq) } : {}) };
    });
  }
  scanPage(query: RunScanQuery): Promise<RunScanPage> {
    return this.serial(async () => {
      validateScan(query);
      // File mode needs only filenames here, not a cold parse of all Runs.
      const { readdir } = await import('node:fs/promises');
      const ids = (await readdir(this.directory)).filter(file => /^run_[a-f0-9-]{36}\.json$/.test(file)).map(file => file.slice(0, -5)).sort();
      const throughId = query.throughId ?? ids.at(-1);
      const available = ids.filter(id => (query.afterId === undefined || id > query.afterId) && throughId !== undefined && id <= throughId);
      const selected = available.slice(0, query.limit);
      return { runs: await Promise.all(selected.map(id => this.get(id))), ...(throughId ? { throughId } : {}), done: available.length <= query.limit };
    });
  }
  scanEventsPage(query: RunScanQuery): Promise<RunEventScanPage> {
    return this.serial(async () => {
      validateScan(query);
      await this.ensureSummaries();
      const ids = [...(this.summaries?.keys() ?? [])].sort();
      const throughId = query.throughId ?? ids.at(-1);
      if (!throughId) return { runs: [], done: true };
      const available = ids.filter(id => (query.afterId === undefined || id > query.afterId) && id <= throughId);
      const selected = available.slice(0, query.limit);
      return {
        runs: selected.map(id => {
          const summary = this.summaries!.get(id)!;
          return { id: summary.id, owner: summary.owner, tenantId: summary.tenantId, eventCount: summary.eventCount, lastEventSeq: summary.lastEventSeq ?? 0 };
        }),
        throughId,
        done: available.length <= query.limit,
      };
    });
  }
  scanRecoveryPage(query: RunScanQuery): Promise<RunRecoveryScanPage> {
    return this.serial(async () => {
      validateScan(query);
      await this.ensureSummaries();
      const ids = [...(this.summaries?.keys() ?? [])].sort();
      const throughId = query.throughId ?? ids.at(-1);
      if (!throughId) return { runs: [], done: true };
      const available = ids.filter(id => (query.afterId === undefined || id > query.afterId) && id <= throughId)
        .map(id => this.summaries!.get(id)!).filter(summary => summary.needsRecovery);
      const selected = available.slice(0, query.limit);
      return { runs: selected.map(summary => ({ id: summary.id, owner: summary.owner, tenantId: summary.tenantId })), throughId, done: available.length <= query.limit };
    });
  }
  mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun> {
    return this.serial(async () => {
      const run = await this.get(id, scope);
      const ownership = { owner: run.owner, tenantId: run.tenantId ?? 'local' };
      const membership = { threadId: run.threadId, parentRunId: run.parentRunId, threadSequence: run.threadSequence };
      const history = structuredClone(run.context.threadHistory);
      await change(run);
      assertMembershipUnchanged(membership, run);
      assertThreadHistoryUnchanged(history, run.context.threadHistory);
      if (!isOwnedBy(run, ownership)) throw new Error('Run ownership is immutable'); run.revision++; run.updatedAt = new Date().toISOString();
      await this.save(run); return run;
    });
  }
  async close(): Promise<void> { await this.queue; this.changeSubscribers.clear(); this.summaries = undefined; await unlink(this.lockPath); }
}

export class PostgresRunRepository implements RunRepository {
  readonly shares: RunShareStore;
  readonly threadShares: ThreadShareStore;
  private pool: pg.Pool;
  private followupLockPool: pg.Pool;
  private readonly changeSubscribers = new Map<(change: RunChange) => void | Promise<void>, PostgresChangeSubscription>();
  private changeChannel = 'aeeis_run_changes';
  private closed = false;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString }); this.shares = new PostgresRunShareStore(this.pool);
    this.threadShares = new PostgresThreadShareStore(this.pool);
    // Session locks use a separate bounded pool. Waiting same-key callers must
    // not exhaust the pool used by the lock holder's checkpoint/read queries.
    this.followupLockPool = new pg.Pool({ connectionString, max: 4 });
  }
  async init(): Promise<void> {
    const schema = await this.pool.query<{ schema: string }>('SELECT current_schema() AS schema');
    const schemaName = schema.rows[0]?.schema ?? 'public';
    this.changeChannel = `aeeis_run_changes_${createHash('sha256').update(schemaName).digest('hex').slice(0, 40)}`;
    await withPostgresMigrationLock(this.pool, 'runs', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_runs (
        id text PRIMARY KEY, revision integer NOT NULL, state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await client.query(runSharesMigration);
      await client.query(threadsMigration);
      await client.query(threadFollowupsMigration);
      await client.query(threadSharesMigration);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_runs_owner_idx ON aeeis_runs ((COALESCE(state->>'tenantId', 'local')), (COALESCE(state->>'owner', 'owner')))`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_runs_recent_idx ON aeeis_runs ((COALESCE(state->>'tenantId', 'local')), (COALESCE(state->>'owner', 'owner')), updated_at DESC, id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS aeeis_runs_shared_recent_idx ON aeeis_runs ((COALESCE(state->>'tenantId', 'local')), (state->>'goalId'), updated_at DESC, id) WHERE COALESCE(state->>'privacy', 'internal') IN ('public', 'internal')`);
      // Older builds stamped the row with transaction time independently of
      // the canonical Run. Align existing rows before using SQL top-N order.
      await client.query(`UPDATE aeeis_runs SET updated_at=(state->>'updatedAt')::timestamptz WHERE updated_at IS DISTINCT FROM (state->>'updatedAt')::timestamptz`);
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_run_events (
        run_id text NOT NULL, seq integer NOT NULL, event_id text NOT NULL, type text NOT NULL,
        at timestamptz NOT NULL, data jsonb NOT NULL, owner text NOT NULL, tenant_id text NOT NULL,
        PRIMARY KEY(run_id, seq), UNIQUE(event_id)
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS aeeis_run_events_scope_idx ON aeeis_run_events(owner, tenant_id, run_id, seq)');
      // Backfill the disposable projection for databases created before the
      // event table existed. Existing Run JSON remains the source of truth.
      await client.query(`INSERT INTO aeeis_run_events(run_id,seq,event_id,type,at,data,owner,tenant_id)
        SELECT r.id, (event->>'seq')::integer, event->>'id', event->>'type', (event->>'at')::timestamptz,
          COALESCE(event->'data','{}'::jsonb), COALESCE(r.state->>'owner','owner'), COALESCE(r.state->>'tenantId','local')
        FROM aeeis_runs r CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.state->'events','[]'::jsonb)) event
        ON CONFLICT DO NOTHING`);
    });
  }
  async health(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async create(run: AgentRun): Promise<void> {
    assertUnthreaded(run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO aeeis_runs(id, revision, state, updated_at) VALUES($1, $2, $3, $4)', [run.id, run.revision, run, run.updatedAt]);
      await this.insertEvents(client, run, 0);
      await client.query('COMMIT');
      await this.notifyChange(client, run);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  private async insertEvents(client: pg.PoolClient, run: AgentRun, from: number): Promise<void> {
    for (const item of run.events.slice(from)) {
      await client.query('INSERT INTO aeeis_run_events(run_id,seq,event_id,type,at,data,owner,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [run.id, item.seq, item.id, item.type, item.at, item.data, run.owner ?? 'owner', run.tenantId ?? 'local']);
    }
  }
  private async notifyChange(client: pg.PoolClient, run: AgentRun): Promise<void> {
    const change: RunChange = { runId: run.id, owner: run.owner ?? 'owner', tenantId: run.tenantId ?? 'local', lastEventSeq: run.events.at(-1)?.seq ?? 0, updatedAt: run.updatedAt };
    try { await client.query('SELECT pg_notify($1, $2)', [this.changeChannel, JSON.stringify(change)]); } catch { /* durable scanner fallback */ }
  }
  async subscribeChanges(handler: (change: RunChange) => void | Promise<void>): Promise<() => Promise<void>> {
    if (this.closed) throw new Error('Run repository is closed');
    const previous = this.changeSubscribers.get(handler);
    if (previous) await this.stopChangeSubscription(handler, previous);
    const subscription: PostgresChangeSubscription = { handler, client: undefined, listener: undefined, errorListener: undefined, reconnectTimer: undefined, stopped: false, reconnectAttempt: 0 };
    this.changeSubscribers.set(handler, subscription);
    try { await this.openChangeSubscription(subscription); }
    catch (error) { await this.stopChangeSubscription(handler, subscription); throw error; }
    return async () => {
      const current = this.changeSubscribers.get(handler);
      if (current !== subscription) return;
      await this.stopChangeSubscription(handler, subscription);
    };
  }
  private async openChangeSubscription(subscription: PostgresChangeSubscription): Promise<void> {
    if (this.closed || subscription.stopped) return;
    const client = await this.pool.connect();
    subscription.client = client;
    const quotedChannel = `"${this.changeChannel.replaceAll('"', '""')}"`;
    const onNotification = (message: pg.Notification) => {
      if (message.channel !== this.changeChannel || !message.payload || subscription.stopped) return;
      try {
        const parsed = JSON.parse(message.payload) as Partial<RunChange>;
        const lastEventSeq = parsed.lastEventSeq;
        if (typeof parsed.runId !== 'string' || !/^run_[a-f0-9-]{36}$/.test(parsed.runId) || typeof parsed.owner !== 'string' || parsed.owner.length > 512 || typeof parsed.tenantId !== 'string' || parsed.tenantId.length > 512 || !Number.isSafeInteger(lastEventSeq) || (lastEventSeq as number) < 0 || typeof parsed.updatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.updatedAt))) return;
        void Promise.resolve().then(() => subscription.handler(parsed as RunChange)).catch(() => undefined);
      } catch { /* hints are disposable; the durable scanner recovers */ }
    };
    const onError = () => {
      if (subscription.client !== client || subscription.stopped) return;
      subscription.client = undefined;
      client.removeListener('notification', onNotification);
      client.removeListener('error', onError);
      client.release(true);
      this.scheduleChangeReconnect(subscription);
    };
    client.on('error', onError);
    try { await client.query(`LISTEN ${quotedChannel}`); }
    catch (error) { subscription.client = undefined; client.removeListener('error', onError); client.release(true); throw error; }
    if (this.closed || subscription.stopped) {
      subscription.client = undefined;
      client.removeListener('error', onError);
      client.release(true);
      return;
    }
    subscription.listener = onNotification;
    subscription.errorListener = onError;
    subscription.reconnectAttempt = 0;
    client.on('notification', onNotification);
  }
  private scheduleChangeReconnect(subscription: PostgresChangeSubscription): void {
    if (this.closed || subscription.stopped || subscription.reconnectTimer) return;
    const delay = Math.min(30_000, 250 * 2 ** Math.min(subscription.reconnectAttempt++, 7));
    subscription.reconnectTimer = setTimeout(() => {
      subscription.reconnectTimer = undefined;
      void this.openChangeSubscription(subscription).catch(() => this.scheduleChangeReconnect(subscription));
    }, delay);
    subscription.reconnectTimer.unref?.();
  }
  private async stopChangeSubscription(handler: (change: RunChange) => void | Promise<void>, subscription: PostgresChangeSubscription): Promise<void> {
    subscription.stopped = true;
    if (subscription.reconnectTimer) { clearTimeout(subscription.reconnectTimer); subscription.reconnectTimer = undefined; }
    if (this.changeSubscribers.get(handler) === subscription) this.changeSubscribers.delete(handler);
    const client = subscription.client;
    subscription.client = undefined;
    if (!client) return;
    if (subscription.listener) client.removeListener('notification', subscription.listener);
    if (subscription.errorListener) client.removeListener('error', subscription.errorListener);
    client.release(true);
  }
  async get(id: string, scope?: Ownership): Promise<AgentRun> {
    validateId(id);
    const result = await this.pool.query(`SELECT state FROM aeeis_runs WHERE id=$1${scope ? " AND COALESCE(state->>'owner', 'owner')=$2 AND COALESCE(state->>'tenantId', 'local')=$3" : ''}`, scope ? [id, scope.owner, scope.tenantId] : [id]);
    if (!result.rows[0]) throw new NotFound('Unknown run');
    return result.rows[0].state as AgentRun;
  }
  async createThread(thread: Thread, initialRunId?: string): Promise<void> {
    const record = threadSchema.parse(thread);
    if (initialRunId !== undefined) validateId(initialRunId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Reserve/lock the thread before the root, matching the append lock order.
      const result = await client.query('INSERT INTO aeeis_threads(id,owner,tenant_id,title,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', [record.id, record.owner, record.tenantId, record.title ?? null, record.createdAt]);
      if (!result.rowCount) throw new ThreadConflict('Thread already exists');
      let root: AgentRun | undefined;
      if (initialRunId !== undefined) {
        const result = await client.query<{ state: AgentRun }>('SELECT state FROM aeeis_runs WHERE id=$1 FOR UPDATE', [initialRunId]);
        root = result.rows[0]?.state;
        if (!root || !isOwnedBy(root, record)) throw new NotFound('Unknown run');
        assertUnthreaded(root);
        prepareAttachment(root, record, undefined, 0);
      }
      if (root) await client.query('UPDATE aeeis_runs SET thread_id=$2,parent_run_id=$3,thread_sequence=$4,revision=$5,state=$6,updated_at=$7 WHERE id=$1', [root.id, record.id, null, 1, root.revision, root, root.updatedAt]);
      await client.query('COMMIT');
      if (root) await this.notifyChange(client, root);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async getThread(id: string, scope?: Ownership): Promise<Thread> {
    validateThreadId(id);
    const result = await this.pool.query<ThreadRow>(`SELECT * FROM aeeis_threads WHERE id=$1${scope ? ' AND owner=$2 AND tenant_id=$3' : ''}`, scope ? [id, scope.owner, scope.tenantId] : [id]);
    if (!result.rows[0]) throw new NotFound('Unknown thread');
    return threadFromRow(result.rows[0]);
  }
  async listRunsByThread(id: string, scope?: Ownership, limit?: number, afterSequence = 0): Promise<AgentRun[]> {
    validateCollectionLimit(limit);
    validateThreadSequence(afterSequence);
    const thread = await this.getThread(id, scope);
    const values: unknown[] = [id, thread.owner, thread.tenantId];
    // Preserve the existing no-cursor query shape for storage callers.
    if (afterSequence > 0) values.push(afterSequence);
    const cursorClause = afterSequence > 0 ? ' AND thread_sequence > $4' : '';
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: AgentRun }>(`SELECT state FROM aeeis_runs WHERE thread_id=$1 AND COALESCE(state->>'owner','owner')=$2 AND COALESCE(state->>'tenantId','local')=$3${cursorClause} ORDER BY thread_sequence ASC${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(row => row.state);
  }
  async latestRunByThread(id: string, scope?: Ownership): Promise<AgentRun | undefined> {
    const thread = await this.getThread(id, scope);
    const result = await this.pool.query<{ state: AgentRun }>("SELECT state FROM aeeis_runs WHERE thread_id=$1 AND COALESCE(state->>'owner','owner')=$2 AND COALESCE(state->>'tenantId','local')=$3 ORDER BY thread_sequence DESC LIMIT 1", [id, thread.owner, thread.tenantId]);
    return result.rows[0]?.state;
  }
  async createRunInThread(input: AgentRun, threadId: string, parentRunId?: string, scope?: Ownership, parentSnapshot?: string | number, followup?: ThreadFollowup): Promise<AgentRun> {
    validateId(input.id); validateThreadId(threadId);
    if (parentRunId !== undefined) validateId(parentRunId);
    const run = structuredClone(input);
    assertUnthreaded(run);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const threads = await client.query<ThreadRow>('SELECT * FROM aeeis_threads WHERE id=$1 FOR UPDATE', [threadId]);
      const row = threads.rows[0];
      if (!row || (scope && !isOwnedBy({ owner: row.owner, tenantId: row.tenant_id }, scope))) throw new NotFound('Unknown thread');
      const thread = threadFromRow(row);
      if (followup) {
        const result = await client.query('SELECT * FROM aeeis_thread_followups WHERE thread_id=$1 AND key_hash=$2 FOR UPDATE', [threadId, followup.keyHash]);
        if (!result.rows[0]) throw new ThreadConflict('Missing follow-up reservation');
        const reservation = followupFromRow(result.rows[0]);
        assertSameFollowup(reservation, followup.requestHash);
        assertFollowupCommit(reservation, run, threadId, parentRunId);
        parentSnapshot = reservation.contextSnapshot.parentHistoryHash ?? reservation.parentRevision;
      }
      let parent: AgentRun | undefined;
      if (parentRunId !== undefined) {
        const parents = await client.query<{ state: AgentRun }>('SELECT state FROM aeeis_runs WHERE id=$1 FOR SHARE', [parentRunId]);
        parent = parents.rows[0]?.state;
        if (!parent || !isOwnedBy(parent, thread)) throw new NotFound('Unknown run');
      }
      assertFollowupParent(parent, parentSnapshot);
      const last = await client.query<{ seq: number }>('SELECT COALESCE(MAX(thread_sequence),0) AS seq FROM aeeis_runs WHERE thread_id=$1', [threadId]);
      prepareAttachment(run, thread, parent, last.rows[0]!.seq);
      const inserted = await client.query('INSERT INTO aeeis_runs(id,revision,state,updated_at,thread_id,parent_run_id,thread_sequence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING', [run.id, run.revision, run, run.updatedAt, threadId, parentRunId ?? null, run.threadSequence]);
      if (!inserted.rowCount) throw new ThreadConflict('Run already exists');
      await this.insertEvents(client, run, 0);
      if (followup) await client.query("UPDATE aeeis_thread_followups SET state='completed' WHERE thread_id=$1 AND key_hash=$2", [threadId, followup.keyHash]);
      await client.query('COMMIT');
      await this.notifyChange(client, run);
      return run;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async withThreadFollowupLock<T>(threadId: string, keyHash: string, scope: Ownership, operation: () => Promise<T>): Promise<T> {
    await this.getThread(threadId, scope);
    const client = await this.followupLockPool.connect();
    const key = `thread-followup/${threadId}/${keyHash}`;
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      locked = true;
      return await operation();
    } finally {
      // Never return a connection with a session lock to the pool.
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      finally { client.release(true); }
    }
  }
  async getThreadFollowup(threadId: string, keyHash: string, scope: Ownership): Promise<ThreadFollowup | undefined> {
    await this.getThread(threadId, scope);
    const result = await this.pool.query('SELECT * FROM aeeis_thread_followups WHERE thread_id=$1 AND key_hash=$2', [threadId, keyHash]);
    return result.rows[0] && followupFromRow(result.rows[0]);
  }
  async saveThreadFollowup(record: ThreadFollowup, scope: Ownership): Promise<void> {
    assertFollowupCheckpoint(await this.getThreadFollowup(record.threadId, record.keyHash, scope), record);
    const result = await this.pool.query(`INSERT INTO aeeis_thread_followups(thread_id,key_hash,request_hash,run_id,state,request,parent_run_id,parent_revision,context_snapshot,created_at)
      VALUES($1,$2,$3,$4,'reserved',$5,$6,$7,$8,$9)
      ON CONFLICT(thread_id,key_hash) DO UPDATE SET context_snapshot=EXCLUDED.context_snapshot
      WHERE aeeis_thread_followups.request_hash=EXCLUDED.request_hash AND aeeis_thread_followups.state='reserved'`,
    [record.threadId, record.keyHash, record.requestHash, record.runId, record.request, record.parentRunId ?? null, record.parentRevision ?? null, record.contextSnapshot, record.createdAt]);
    if (!result.rowCount) throw new ThreadConflict('Idempotency-Key was already used with different input or completed');
  }
  async *pendingThreadFollowups(): AsyncIterable<ThreadFollowup> {
    let after: [string, string] | undefined;
    while (true) {
      const result = await this.pool.query(`SELECT * FROM aeeis_thread_followups WHERE state='reserved'${after ? ' AND (thread_id,key_hash)>($1,$2)' : ''} ORDER BY thread_id,key_hash LIMIT 100`, after);
      for (const row of result.rows) yield followupFromRow(row);
      if (result.rows.length < 100) return;
      const last = result.rows.at(-1)!;
      after = [last.thread_id, last.key_hash];
    }
  }
  async attachRunToThread(runId: string, threadId: string, parentRunId?: string, scope?: Ownership): Promise<AgentRun> {
    validateId(runId); validateThreadId(threadId);
    if (parentRunId !== undefined) validateId(parentRunId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the thread first: every append, including across processes, uses
      // this order. Existing parent membership cannot change through mutate.
      const threads = await client.query<ThreadRow>('SELECT * FROM aeeis_threads WHERE id=$1 FOR UPDATE', [threadId]);
      const row = threads.rows[0];
      if (!row || (scope && !isOwnedBy({ owner: row.owner, tenantId: row.tenant_id }, scope))) throw new NotFound('Unknown thread');
      const thread = threadFromRow(row);
      const runs = await client.query<{ state: AgentRun }>('SELECT state FROM aeeis_runs WHERE id=$1 FOR UPDATE', [runId]);
      const run = runs.rows[0]?.state;
      if (!run || !isOwnedBy(run, thread)) throw new NotFound('Unknown run');
      let parent: AgentRun | undefined;
      if (parentRunId !== undefined) {
        const parents = await client.query<{ state: AgentRun }>('SELECT state FROM aeeis_runs WHERE id=$1', [parentRunId]);
        parent = parents.rows[0]?.state;
        if (!parent || !isOwnedBy(parent, thread)) throw new NotFound('Unknown run');
      }
      const last = await client.query<{ seq: number }>('SELECT COALESCE(MAX(thread_sequence),0) AS seq FROM aeeis_runs WHERE thread_id=$1', [threadId]);
      const changed = prepareAttachment(run, thread, parent, last.rows[0]!.seq);
      if (changed) await client.query('UPDATE aeeis_runs SET thread_id=$2,parent_run_id=$3,thread_sequence=$4,revision=$5,state=$6,updated_at=$7 WHERE id=$1', [runId, threadId, parentRunId ?? null, run.threadSequence, run.revision, run, run.updatedAt]);
      await client.query('COMMIT');
      if (changed) await this.notifyChange(client, run);
      return run;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async list(scope?: Ownership, limit?: number): Promise<AgentRun[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = scope ? [scope.owner, scope.tenantId] : [];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query(`SELECT state FROM aeeis_runs${scope ? " WHERE COALESCE(state->>'owner', 'owner')=$1 AND COALESCE(state->>'tenantId', 'local')=$2" : ''} ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(r => r.state as AgentRun);
  }
  async listByTenant(tenantId: string, limit?: number): Promise<AgentRun[]> {
    validateCollectionLimit(limit);
    const values: unknown[] = [tenantId];
    if (limit !== undefined) values.push(limit);
    const result = await this.pool.query<{ state: AgentRun }>(`SELECT state FROM aeeis_runs WHERE COALESCE(state->>'tenantId', 'local')=$1 ORDER BY updated_at DESC, id${limit === undefined ? '' : ` LIMIT $${values.length}`}`, values);
    return result.rows.map(row => row.state);
  }
  async page(scope: Ownership, limit: number, cursor?: string): Promise<RunPage> {
    validateCollectionLimit(limit);
    const pageKey = decodePageKey(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId];
    const cursorClause = pageKey ? ` AND (updated_at < $3::timestamptz OR (updated_at = $3::timestamptz AND id > $4))` : '';
    if (pageKey) values.push(pageKey.updatedAt, pageKey.id);
    values.push(limit + 1);
    const result = await this.pool.query<{ state: AgentRun }>(
      `SELECT state FROM aeeis_runs WHERE COALESCE(state->>'owner', 'owner')=$1 AND COALESCE(state->>'tenantId', 'local')=$2${cursorClause} ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { runs: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodePageKey({ id: visible.at(-1)!.state.id, updatedAt: visible.at(-1)!.state.updatedAt }) } : {}) };
  }
  async pageVisible(scope: Ownership, readableGoalIds: readonly string[], limit: number, cursor?: string): Promise<RunPage> {
    validateCollectionLimit(limit);
    const pageKey = decodePageKey(cursor);
    const values: unknown[] = [scope.owner, scope.tenantId, [...new Set(readableGoalIds)]];
    const cursorClause = pageKey ? ` AND (updated_at < $4::timestamptz OR (updated_at = $4::timestamptz AND id > $5))` : '';
    if (pageKey) values.push(pageKey.updatedAt, pageKey.id);
    values.push(limit + 1);
    const result = await this.pool.query<{ state: AgentRun }>(
      `SELECT state FROM aeeis_runs
        WHERE COALESCE(state->>'tenantId', 'local')=$2
          AND (
            COALESCE(state->>'owner', 'owner')=$1
            OR (
              COALESCE(state->>'goalId', '') = ANY($3::text[])
              AND COALESCE(state->>'privacy', 'internal') IN ('public', 'internal')
            )
          )${cursorClause}
        ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const visible = hasMore ? result.rows.slice(0, limit) : result.rows;
    return { runs: visible.map(row => row.state), ...(hasMore && visible.length ? { nextCursor: encodePageKey({ id: visible.at(-1)!.state.id, updatedAt: visible.at(-1)!.state.updatedAt }) } : {}) };
  }
  async eventsPage(id: string, scope: Ownership, limit: number, cursor?: string): Promise<RunEventsPage> {
    validateId(id); validateCollectionLimit(limit);
    const afterSeq = decodeEventCursor(cursor);
    const visibleRun = await this.pool.query('SELECT 1 FROM aeeis_runs WHERE id=$1 AND COALESCE(state->>\'owner\',\'owner\')=$2 AND COALESCE(state->>\'tenantId\',\'local\')=$3', [id, scope.owner, scope.tenantId]);
    if (!visibleRun.rows[0]) throw new NotFound('Unknown run');
    const values: unknown[] = [id, scope.owner, scope.tenantId, afterSeq, limit + 1];
    const result = await this.pool.query<{ seq: number; event_id: string; type: string; at: string; data: Record<string, unknown> }>(
      'SELECT seq,event_id,type,at,data FROM aeeis_run_events WHERE run_id=$1 AND owner=$2 AND tenant_id=$3 AND seq>$4 ORDER BY seq ASC LIMIT $5', values);
    const hasMore = result.rows.length > limit; const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const events = rows.map(row => ({ id: row.event_id, seq: row.seq, type: row.type, at: new Date(row.at).toISOString(), data: row.data }));
    return { events, ...(hasMore && events.length ? { nextCursor: encodeRunEventCursor(events.at(-1)!.seq) } : {}) };
  }
  async scanPage(query: RunScanQuery): Promise<RunScanPage> {
    validateScan(query);
    const throughId = query.throughId ?? (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_runs ORDER BY id DESC LIMIT 1')).rows[0]?.id;
    if (!throughId) return { runs: [], done: true };
    const result = await this.pool.query<{ state: AgentRun }>(
      'SELECT state FROM aeeis_runs WHERE id > $1 AND id <= $2 ORDER BY id ASC LIMIT $3',
      [query.afterId ?? '', throughId, query.limit]);
    return { runs: result.rows.map(row => row.state), throughId, done: result.rows.length < query.limit };
  }
  async scanEventsPage(query: RunScanQuery): Promise<RunEventScanPage> {
    validateScan(query);
    const throughId = query.throughId ?? (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_runs ORDER BY id DESC LIMIT 1')).rows[0]?.id;
    if (!throughId) return { runs: [], done: true };
    const result = await this.pool.query<{ id: string; owner: string; tenant_id: string; event_count: number; last_event_seq: number }>(
      `SELECT id,
              COALESCE(state->>'owner', 'owner') AS owner,
              COALESCE(state->>'tenantId', 'local') AS tenant_id,
              jsonb_array_length(COALESCE(state->'events', '[]'::jsonb)) AS event_count,
              COALESCE((state->'events'->-1->>'seq')::integer, 0) AS last_event_seq
         FROM aeeis_runs
        WHERE id > $1 AND id <= $2
        ORDER BY id ASC
        LIMIT $3`,
      [query.afterId ?? '', throughId, query.limit],
    );
    return {
      runs: result.rows.map(row => ({ id: row.id, owner: row.owner, tenantId: row.tenant_id, eventCount: Number(row.event_count), lastEventSeq: Number(row.last_event_seq) })),
      throughId,
      done: result.rows.length < query.limit,
    };
  }
  async scanRecoveryPage(query: RunScanQuery): Promise<RunRecoveryScanPage> {
    validateScan(query);
    const throughId = query.throughId ?? (await this.pool.query<{ id: string }>('SELECT id FROM aeeis_runs ORDER BY id DESC LIMIT 1')).rows[0]?.id;
    if (!throughId) return { runs: [], done: true };
    const result = await this.pool.query<{ id: string; owner: string; tenant_id: string }>(
      `SELECT id,
              COALESCE(state->>'owner', 'owner') AS owner,
              COALESCE(state->>'tenantId', 'local') AS tenant_id
         FROM aeeis_runs
        WHERE id > $1 AND id <= $2
          AND (
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(state->'calls', '[]'::jsonb)) call WHERE call->>'state'='started')
            OR (state->'pendingTool' IS NOT NULL AND ((state->'pendingTool'->>'receiptId') IS NULL OR (state->'pendingTool'->>'executionToken') IS NOT NULL OR (state->'pendingTool'->>'reconcileInFlight')='true'))
            OR (state->>'status'='unknown' AND (state->'pendingTool'->>'receiptId') IS NOT NULL)
            OR (state->'pendingDelegation' IS NOT NULL AND ((state->'pendingDelegation'->>'receiptRef') IS NULL OR (state->'pendingDelegation'->>'executionToken') IS NOT NULL OR (state->'pendingDelegation'->>'reconcileInFlight')='true'))
            OR state->'taskExecution' IS NOT NULL
            OR (state->>'goalId' IS NOT NULL AND state->>'domainPlanId' IS NOT NULL)
            OR (state->>'status'='succeeded' AND state->>'goalId' IS NOT NULL
                AND (state->>'builtinSkill'='project-pulse/1' OR state->>'projectSourceQuery' IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(state->'events', '[]'::jsonb)) pulse_event WHERE pulse_event->>'type'='project-pulse.next-actions.projected'))
          )
        ORDER BY id ASC
        LIMIT $3`,
      [query.afterId ?? '', throughId, query.limit],
    );
    return { runs: result.rows.map(row => ({ id: row.id, owner: row.owner, tenantId: row.tenant_id })), throughId, done: result.rows.length < query.limit };
  }
  async mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun> {
    validateId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT state FROM aeeis_runs WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new NotFound('Unknown run');
      const run = result.rows[0].state as AgentRun;
      if (scope && !isOwnedBy(run, scope)) throw new NotFound('Unknown run');
      const ownership = { owner: run.owner, tenantId: run.tenantId ?? 'local' };
      const eventCount = run.events.length;
      const eventIds = run.events.map(item => item.id);
      const membership = { threadId: run.threadId, parentRunId: run.parentRunId, threadSequence: run.threadSequence };
      const history = structuredClone(run.context.threadHistory);
      await change(run);
      assertMembershipUnchanged(membership, run);
      assertThreadHistoryUnchanged(history, run.context.threadHistory);
      if (!isOwnedBy(run, ownership)) throw new Error('Run ownership is immutable');
      if (run.events.length < eventCount || eventIds.some((id, index) => run.events[index]?.id !== id)) throw new Error('Run events are append-only');
      run.revision++; run.updatedAt = new Date().toISOString();
      await client.query('UPDATE aeeis_runs SET revision=$2, state=$3, updated_at=$4 WHERE id=$1', [id, run.revision, run, run.updatedAt]);
      await this.insertEvents(client, run, eventCount);
      await client.query('COMMIT');
      await this.notifyChange(client, run); return run;
    } catch(e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; const entries = [...this.changeSubscribers.entries()]; await Promise.all(entries.map(([handler, subscription]) => this.stopChangeSubscription(handler, subscription))); await Promise.all([this.pool.end(), this.followupLockPool.end()]); }
}

function followupFromRow(row: Record<string, any>): ThreadFollowup {
  return {
    threadId: row.thread_id, keyHash: row.key_hash, requestHash: row.request_hash, runId: row.run_id,
    state: row.state, request: row.request, contextSnapshot: row.context_snapshot,
    ...(row.parent_run_id === null ? {} : { parentRunId: row.parent_run_id }),
    ...(row.parent_revision === null ? {} : { parentRevision: row.parent_revision }),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type ThreadRow = { id: string; owner: string; tenant_id: string; title: string | null; created_at: Date };
function threadFromRow(row: ThreadRow): Thread {
  return { id: row.id, owner: row.owner, tenantId: row.tenant_id, ...(row.title === null ? {} : { title: row.title }), createdAt: row.created_at.toISOString() };
}

interface PostgresChangeSubscription {
  handler: (change: RunChange) => void | Promise<void>;
  client: pg.PoolClient | undefined;
  listener: ((message: pg.Notification) => void) | undefined;
  errorListener: (() => void) | undefined;
  reconnectTimer: NodeJS.Timeout | undefined;
  reconnectAttempt: number;
  stopped: boolean;
}
