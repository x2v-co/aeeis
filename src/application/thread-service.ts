import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ownership } from '../security/principal.js';
import { requestSchema } from '../runtime/contracts.js';
import type { AgentEngine, CreateRunCheckpoint } from '../runtime/engine.js';
import { NotFound, type RunRepository } from '../runtime/repository.js';
import { assertFollowupParent, assertUnthreaded, followupParentHash, ThreadConflict, type Thread } from '../runtime/threads.js';
import { buildThreadHistory, DEFAULT_THREAD_HISTORY_BYTES, MAX_THREAD_HISTORY_BYTES } from '../runtime/thread-history.js';
import { assertSameFollowup, followupHash, followupRunId, idempotencyKeySchema, type ThreadFollowup } from '../runtime/thread-followups.js';
import type { AgentRun } from '../runtime/contracts.js';

export const createThreadSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), initialRunId: z.string().min(1).optional() }).strict();
export const threadRunSchema = z.object({
  request: requestSchema.omit({ goalId: true, taskExecution: true }),
  parentRunId: z.string().min(1).optional(),
  contextBudgetBytes: z.number().int().positive().max(MAX_THREAD_HISTORY_BYTES).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();
export const threadPageSchema = z.object({
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(50),
  afterSequence: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(0).max(2147483647)).default(0),
}).strict();

export class ThreadService {
  constructor(private repository: RunRepository, private engine?: Pick<AgentEngine, 'create' | 'authorizeThreadHistory'>, private contextBudgetBytes = DEFAULT_THREAD_HISTORY_BYTES) {
    if (!Number.isSafeInteger(contextBudgetBytes) || contextBudgetBytes <= 0 || contextBudgetBytes > MAX_THREAD_HISTORY_BYTES) throw new RangeError('Invalid server thread context byte budget');
  }
  private validateId(id: string): void { if (!/^thread_[a-f0-9-]{36}$/.test(id)) throw new NotFound('Unknown thread'); }
  async create(input: unknown, scope: Ownership): Promise<Thread> {
    const body = createThreadSchema.parse(input);
    if (body.initialRunId !== undefined) assertUnthreaded(await this.repository.get(body.initialRunId, scope));
    const thread: Thread = { id: `thread_${randomUUID()}`, ...scope, ...(body.title ? { title: body.title } : {}), createdAt: new Date().toISOString() };
    await this.repository.createThread(thread, body.initialRunId);
    return thread;
  }
  async get(id: string, query: unknown, scope: Ownership) {
    this.validateId(id);
    const thread = await this.repository.getThread(id, scope);
    const { limit, afterSequence } = threadPageSchema.parse(query);
    const page = await this.repository.listRunsByThread(id, scope, limit + 1, afterSequence);
    const runs = page.slice(0, limit).map(run => ({
      id: run.id, threadId: id, threadSequence: run.threadSequence!, ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
      goal: run.goal, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt,
      links: { run: `/runs/${run.id}`, api: `/api/runs/${run.id}` },
    }));
    return { ...thread, runs, ...(page.length > limit ? { nextAfterSequence: runs.at(-1)!.threadSequence } : {}) };
  }
  async followUp(id: string, input: unknown, scope: Ownership, headerKey?: unknown): Promise<AgentRun> {
    this.validateId(id);
    await this.repository.getThread(id, scope);
    const body = threadRunSchema.parse(input);
    const key = idempotencyKeySchema.parse(headerKey ?? body.idempotencyKey);
    if (headerKey !== undefined && body.idempotencyKey !== undefined && key !== body.idempotencyKey) throw new RangeError('Header and body idempotency keys must match');
    const budget = body.contextBudgetBytes ?? this.contextBudgetBytes;
    // Preserve default-parent intent rather than hashing the moving latest Run.
    const request = { request: body.request, ...(body.parentRunId === undefined ? {} : { parentRunId: body.parentRunId }), contextBudgetBytes: budget };
    const keyHash = followupHash(key), requestHash = followupHash({ ...request, contextBudgetBytes: body.contextBudgetBytes ?? null });
    return this.repository.withThreadFollowupLock(id, keyHash, scope, async () => {
      let record = await this.repository.getThreadFollowup(id, keyHash, scope);
      if (record) assertSameFollowup(record, requestHash);
      else {
        if (budget > this.contextBudgetBytes) throw new RangeError('Thread context budget exceeds the server budget');
        const parent = body.parentRunId === undefined ? await this.repository.latestRunByThread(id, scope) : await this.repository.get(body.parentRunId, scope);
        if (parent && parent.threadId !== id) throw new ThreadConflict('Parent must belong to this thread');
        assertFollowupParent(parent);
        record = {
          threadId: id, keyHash, requestHash, runId: followupRunId(id, keyHash, scope), state: 'reserved', request,
          ...(parent ? { parentRunId: parent.id, parentRevision: parent.revision } : {}),
          contextSnapshot: parent ? { parentHistoryHash: followupParentHash(parent) } : {}, createdAt: new Date().toISOString(),
        };
        await this.repository.saveThreadFollowup(record, scope);
      }
      return this.initialize(record, scope);
    });
  }
  private async initialize(record: ThreadFollowup, scope: Ownership): Promise<AgentRun> {
    if (record.state === 'completed') return this.repository.get(record.runId, scope);
    if (!this.engine) throw new Error('Model runtime is not configured');
    const engine = this.engine;
    const parent = record.parentRunId === undefined ? undefined : await this.repository.get(record.parentRunId, scope);
    const parentSnapshot = record.contextSnapshot.parentHistoryHash ?? record.parentRevision;
    assertFollowupParent(parent, parentSnapshot);
    if (!record.contextSnapshot.history) {
      record.contextSnapshot.history = await buildThreadHistory(this.repository, record.threadId, parent, scope, record.request.request.privacy, record.request.contextBudgetBytes, (run, access) => engine.authorizeThreadHistory(run, scope, access));
      await this.repository.saveThreadFollowup(record, scope);
    } else if (parent) await engine.authorizeThreadHistory(parent, scope, record.contextSnapshot.history.accessProvenance);
    const commit = (run: AgentRun) => this.repository.createRunInThread(run, record.threadId, record.parentRunId, scope, parentSnapshot, record);
    if (record.contextSnapshot.run) return commit(record.contextSnapshot.run);
    const checkpoint: CreateRunCheckpoint = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
      const stages = record.contextSnapshot.preparation ??= {};
      const previous = stages[stage];
      if (previous?.state === 'completed') return structuredClone(previous.value) as T;
      // A crash between a provider call and checkpoint publication is ambiguous.
      // Keep the request reserved for explicit recovery instead of resending it.
      if (previous?.state === 'started') throw new ThreadConflict(`Follow-up preparation ${stage} has an unknown outcome; reconcile before retrying`);
      stages[stage] = { state: 'started' };
      await this.repository.saveThreadFollowup(record, scope);
      let value: T;
      try { value = await operation(); }
      catch (error) {
        // Preparation has not committed a Run. Preserve completed snapshots,
        // but allow a failed retrieval/selection to be retried with this key.
        stages[stage] = { state: 'failed' };
        await this.repository.saveThreadFollowup(record, scope);
        throw error;
      }
      stages[stage] = { state: 'completed', ...(value === undefined ? {} : { value }) };
      await this.repository.saveThreadFollowup(record, scope);
      return value;
    };
    return engine.create(record.request.request, scope.owner, scope.tenantId, async run => {
      run.context.threadHistory = record.contextSnapshot.history!;
      record.contextSnapshot.run = run;
      await this.repository.saveThreadFollowup(record, scope);
      return commit(run);
    }, record.runId, checkpoint);
  }
  /** Called before boot dispatch. Re-read under the same-key lock so another
   * API's completed reservation cannot be initialized a second time. */
  async recover(): Promise<void> {
    for await (const pending of this.repository.pendingThreadFollowups()) {
      const thread = await this.repository.getThread(pending.threadId);
      const scope = { owner: thread.owner, tenantId: thread.tenantId };
      try {
        await this.repository.withThreadFollowupLock(thread.id, pending.keyHash, scope, async () => {
          const current = await this.repository.getThreadFollowup(thread.id, pending.keyHash, scope);
          if (current) await this.initialize(current, scope);
        });
      } catch (error) {
        // Validation/ACL/provider failures remain reserved and undispatchable;
        // recovery of other committed Runs must still proceed.
        console.error('Thread follow-up recovery failed', pending.runId, error instanceof Error ? error.name : 'Error');
      }
    }
  }
}
