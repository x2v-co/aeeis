import type { AgentRun } from '../runtime/contracts.js';
import { NotFound, type RunRepository } from '../runtime/repository.js';
import { InMemoryRunShareStore } from '../runtime/run-shares.js';
import { assertFollowupParent, assertMembershipUnchanged, assertUnthreaded, prepareAttachment, threadSchema, ThreadConflict, validateThreadSequence, type Thread } from '../runtime/threads.js';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import { scopedRecent, validateCollectionLimit } from './collection-query.js';
import { assertThreadHistoryUnchanged } from '../runtime/thread-history.js';

/** Ephemeral adapter with the same serial write and ownership contract as file mode. */
export class InMemoryRunRepository implements RunRepository {
  readonly shares = new InMemoryRunShareStore();
  private runs = new Map<string, AgentRun>();
  private threads = new Map<string, Thread>();
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  create(run: AgentRun): Promise<void> {
    return this.serial(async () => {
      assertUnthreaded(run);
      if (this.runs.has(run.id)) throw new Error('Run already exists');
      this.runs.set(run.id, structuredClone(run));
    });
  }
  async get(id: string, scope?: Ownership): Promise<AgentRun> {
    const run = this.runs.get(id);
    if (!run || (scope && !isOwnedBy(run, scope))) throw new NotFound('Unknown run');
    return structuredClone(run);
  }
  async list(scope?: Ownership, limit?: number): Promise<AgentRun[]> {
    return structuredClone(scopedRecent([...this.runs.values()], run => run.updatedAt, scope, limit));
  }
  createThread(thread: Thread, initialRunId?: string): Promise<void> {
    return this.serial(async () => {
      const record = threadSchema.parse(thread);
      if (this.threads.has(record.id)) throw new ThreadConflict('Thread already exists');
      const root = initialRunId === undefined ? undefined : await this.get(initialRunId, record);
      if (root) { assertUnthreaded(root); prepareAttachment(root, record, undefined, 0); }
      this.threads.set(record.id, record);
      if (root) this.runs.set(root.id, root);
    });
  }
  async getThread(id: string, scope?: Ownership): Promise<Thread> {
    const thread = this.threads.get(id);
    if (!thread || (scope && !isOwnedBy(thread, scope))) throw new NotFound('Unknown thread');
    return structuredClone(thread);
  }
  listRunsByThread(id: string, scope?: Ownership, limit?: number, afterSequence = 0): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      validateThreadSequence(afterSequence);
      const thread = await this.getThread(id, scope);
      return structuredClone([...this.runs.values()].filter(run => run.threadId === id && run.threadSequence! > afterSequence && isOwnedBy(run, thread))
        .sort((a, b) => a.threadSequence! - b.threadSequence!).slice(0, limit));
    });
  }
  latestRunByThread(id: string, scope?: Ownership): Promise<AgentRun | undefined> {
    return this.serial(async () => {
      const thread = await this.getThread(id, scope);
      const latest = [...this.runs.values()].filter(run => run.threadId === id && isOwnedBy(run, thread))
        .sort((a, b) => b.threadSequence! - a.threadSequence!)[0];
      return latest && structuredClone(latest);
    });
  }
  createRunInThread(input: AgentRun, threadId: string, parentRunId?: string, scope?: Ownership, parentRevision?: number): Promise<AgentRun> {
    return this.serial(async () => {
      const thread = await this.getThread(threadId, scope), run = structuredClone(input);
      assertUnthreaded(run);
      if (this.runs.has(run.id)) throw new ThreadConflict('Run already exists');
      const parent = parentRunId === undefined ? undefined : await this.get(parentRunId, thread);
      assertFollowupParent(parent, parentRevision);
      const last = [...this.runs.values()].filter(item => item.threadId === threadId).reduce((max, item) => Math.max(max, item.threadSequence!), 0);
      prepareAttachment(run, thread, parent, last);
      this.runs.set(run.id, structuredClone(run));
      return run;
    });
  }
  attachRunToThread(runId: string, threadId: string, parentRunId?: string, scope?: Ownership): Promise<AgentRun> {
    return this.serial(async () => {
      const thread = await this.getThread(threadId, scope);
      const run = await this.get(runId, thread);
      const parent = parentRunId === undefined ? undefined : await this.get(parentRunId, thread);
      const lastSequence = [...this.runs.values()].filter(item => item.threadId === threadId).reduce((max, item) => Math.max(max, item.threadSequence!), 0);
      if (prepareAttachment(run, thread, parent, lastSequence)) this.runs.set(runId, structuredClone(run));
      return run;
    });
  }
  mutate(id: string, change: (run: AgentRun) => void | Promise<void>, scope?: Ownership): Promise<AgentRun> {
    return this.serial(async () => {
      const before = await this.get(id, scope), run = structuredClone(before);
      await change(run);
      if (!isOwnedBy(run, { owner: before.owner, tenantId: before.tenantId ?? 'local' })) throw new Error('Run ownership is immutable');
      assertMembershipUnchanged(before, run);
      assertThreadHistoryUnchanged(before.context.threadHistory, run.context.threadHistory);
      if (run.events.length < before.events.length || before.events.some((event, index) => event.id !== run.events[index]?.id)) throw new Error('Run events are append-only');
      run.revision++; run.updatedAt = new Date().toISOString();
      this.runs.set(id, structuredClone(run));
      return run;
    });
  }
  async close(): Promise<void> { await this.queue; }
}
