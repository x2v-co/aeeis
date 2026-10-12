import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Ownership } from '../security/principal.js';
import { requestSchema } from '../runtime/contracts.js';
import type { AgentEngine } from '../runtime/engine.js';
import { NotFound, type RunRepository } from '../runtime/repository.js';
import { assertFollowupParent, assertUnthreaded, ThreadConflict, type Thread } from '../runtime/threads.js';
import { buildThreadHistory, DEFAULT_THREAD_HISTORY_BYTES, MAX_THREAD_HISTORY_BYTES } from '../runtime/thread-history.js';

export const createThreadSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), initialRunId: z.string().min(1).optional() }).strict();
export const threadRunSchema = z.object({
  request: requestSchema.omit({ goalId: true, taskExecution: true }),
  parentRunId: z.string().min(1).optional(),
  contextBudgetBytes: z.number().int().positive().max(MAX_THREAD_HISTORY_BYTES).optional(),
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
  async followUp(id: string, input: unknown, scope: Ownership) {
    this.validateId(id);
    await this.repository.getThread(id, scope);
    const body = threadRunSchema.parse(input);
    const budget = body.contextBudgetBytes ?? this.contextBudgetBytes;
    if (budget > this.contextBudgetBytes) throw new RangeError('Thread context budget exceeds the server budget');
    const parent = body.parentRunId === undefined ? await this.repository.latestRunByThread(id, scope) : await this.repository.get(body.parentRunId, scope);
    if (parent && parent.threadId !== id) {
      // A known owner run in another thread is a state conflict, not an access grant.
      throw new ThreadConflict('Parent must belong to this thread');
    }
    assertFollowupParent(parent);
    if (!this.engine) throw new Error('Model runtime is not configured');
    const engine = this.engine;
    const history = await buildThreadHistory(this.repository, id, parent, scope, body.request.privacy, budget, (run, access) => engine.authorizeThreadHistory(run, scope, access));
    return this.engine.create(body.request, scope.owner, scope.tenantId, async run => {
      run.context.threadHistory = history;
      return this.repository.createRunInThread(run, id, parent?.id, scope, parent?.revision);
    });
  }
}
