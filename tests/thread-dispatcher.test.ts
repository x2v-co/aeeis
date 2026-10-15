import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ThreadService } from '../src/application/thread-service.js';
import { LocalDispatcher, notifyTemporalRunWorkflow } from '../src/runtime/dispatcher.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';
import { followupModel } from './support/thread-followup-contract.js';

describe('thread run dispatch linkage', () => {
  it('starts a new workflow with the child run ID, retries signal/start races and wakes only the child on approval and answer', async () => {
    const repository = new InMemoryRunRepository(), parent = threadRun(), thread = threadRecord();
    await repository.create(parent); await repository.createThread(thread, parent.id);
    const engine = new AgentEngine(repository, followupModel());
    const signal = vi.fn().mockRejectedValueOnce(new WorkflowNotFoundError('missing', 'child', undefined)).mockResolvedValue(undefined);
    const client = { workflow: { getHandle: vi.fn((_id: string) => ({ signal })), start: vi.fn(async () => { throw new WorkflowExecutionAlreadyStartedError('racing API started', 'child', 'agentRunWorkflow'); }) } };
    const dispatcher = { notify: (id: string) => notifyTemporalRunWorkflow(client, 'thread-queue', id), close: async () => undefined };
    const app = buildApp({ repository, engine, dispatcher, principalTokens: { alice: { id: threadScope.owner, tenantId: threadScope.tenantId, roles: ['owner'] } } });
    const headers = { authorization: 'Bearer alice', 'idempotency-key': 'child-post' }, payload = { request: { goal: 'next' } }, url = `/api/threads/${thread.id}/runs`;
    try {
      const before = await repository.get(parent.id);
      const response = await app.inject({ method: 'POST', url, headers, payload });
      expect(response.statusCode).toBe(202);
      const child = response.json();
      expect(client.workflow.start).toHaveBeenCalledOnce();
      expect(client.workflow.start).toHaveBeenCalledWith('agentRunWorkflow', { taskQueue: 'thread-queue', workflowId: child.id, args: [child.id] });
      expect(signal).toHaveBeenCalledTimes(2);
      await repository.mutate(child.id, run => {
        run.plans = [{ version: 1, hash: 'child-hash', summary: 'Next', createdAt: run.createdAt, nodes: [{ id: 'draft', title: 'Draft', instruction: 'Draft next result', dependsOn: [] }] }];
        run.status = 'needs_approval'; run.approval = { planHash: 'child-hash', approved: false };
      });
      expect((await app.inject({ method: 'POST', url: `/api/runs/${child.id}/approve`, headers, payload: { planHash: 'child-hash', planVersion: 1 } })).statusCode).toBe(200);
      await repository.mutate(child.id, run => { run.status = 'needs_input'; run.question = { taskId: 'draft', text: 'Which audience?' }; });
      expect((await app.inject({ method: 'POST', url: `/api/runs/${child.id}/answer`, headers, payload: { answer: 'the team' } })).statusCode).toBe(200);
      const retry = await app.inject({ method: 'POST', url, headers, payload });
      expect(retry.json().id).toBe(child.id); expect(retry.json().context).toEqual(child.context);
      for (const [id] of client.workflow.getHandle.mock.calls) expect(id).toBe(child.id);
      expect(client.workflow.start).toHaveBeenCalledOnce(); expect(await repository.get(parent.id)).toEqual(before);
      expect((await repository.get(child.id)).answers).toEqual([expect.objectContaining({ answer: 'the team' })]);
    } finally { await app.close(); await repository.close(); }
  });
  it('drives the same independent child in local mode without advancing the terminal parent', async () => {
    const repository = new InMemoryRunRepository(), parent = threadRun(), thread = threadRecord();
    await repository.create(parent); await repository.createThread(thread, parent.id);
    const child = await new ThreadService(repository, new AgentEngine(repository, followupModel())).followUp(thread.id, { request: { goal: 'next' }, idempotencyKey: 'local-post' }, threadScope);
    const advance = vi.fn(async (id: string) => { await repository.mutate(id, run => { run.status = 'needs_approval'; }); return 'needs_approval' as const; });
    const dispatcher = new LocalDispatcher({ advance } as unknown as AgentEngine);
    await dispatcher.notify(child.id); await dispatcher.close();
    expect(advance).toHaveBeenCalledOnce(); expect(advance).toHaveBeenCalledWith(child.id);
    expect((await repository.get(parent.id)).status).toBe('succeeded');
    expect((await repository.get(child.id)).threadSequence).toBe(2);
    await repository.close();
  });
});
