import type { AgentRun } from '../runtime/contracts.js';
import { NotFound, type RunRepository } from '../runtime/repository.js';
import { InMemoryRunShareStore } from '../runtime/run-shares.js';
import { assertMembershipUnchanged, assertUnthreaded, prepareAttachment, threadSchema, ThreadConflict, type Thread } from '../runtime/threads.js';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import { scopedRecent, validateCollectionLimit } from './collection-query.js';

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
  createThread(thread: Thread): Promise<void> {
    return this.serial(async () => {
      const record = threadSchema.parse(thread);
      if (this.threads.has(record.id)) throw new ThreadConflict('Thread already exists');
      this.threads.set(record.id, record);
    });
  }
  async getThread(id: string, scope?: Ownership): Promise<Thread> {
    const thread = this.threads.get(id);
    if (!thread || (scope && !isOwnedBy(thread, scope))) throw new NotFound('Unknown thread');
    return structuredClone(thread);
  }
  listRunsByThread(id: string, scope?: Ownership, limit?: number): Promise<AgentRun[]> {
    return this.serial(async () => {
      validateCollectionLimit(limit);
      const thread = await this.getThread(id, scope);
      return structuredClone([...this.runs.values()].filter(run => run.threadId === id && isOwnedBy(run, thread))
        .sort((a, b) => a.threadSequence! - b.threadSequence!).slice(0, limit));
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
      if (run.events.length < before.events.length || before.events.some((event, index) => event.id !== run.events[index]?.id)) throw new Error('Run events are append-only');
      run.revision++; run.updatedAt = new Date().toISOString();
      this.runs.set(id, structuredClone(run));
      return run;
    });
  }
  async close(): Promise<void> { await this.queue; }
}
