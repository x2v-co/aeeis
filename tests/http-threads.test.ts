import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository, NotFound } from '../src/runtime/repository.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });
async function fixture(contextBudgetBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-http-threads-'));
  const repository = new FileRunRepository(directory); await repository.init();
  const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' }, complete: vi.fn(async () => ({ value: {} })) };
  const engine = new AgentEngine(repository, model);
  const notify = vi.fn(async (id: string) => {
    // Dispatch sees only a fully linked run with the snapshot already persisted.
    const run = await repository.get(id);
    if (run.threadId) {
      expect(run.threadSequence).toBeGreaterThan(0);
      expect(run.context.threadHistory?.threadId).toBe(run.threadId);
    }
  });
  const app = buildApp({ repository, engine, dispatcher: { notify, close: async () => undefined },
    ...(contextBudgetBytes === undefined ? {} : { threadContextBudgetBytes: contextBudgetBytes }),
    principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
      outsider: { id: 'alice', tenantId: 'team-b', roles: ['owner'] },
      reader: { id: 'alice', tenantId: 'team-a', roles: ['agent'] },
    },
  });
  cleanup.push(async () => { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer alice' };
  return { app, repository, engine, notify, model, headers, directory };
}
describe('authenticated thread API', () => {
  it('creates empty threads and root attachments, returns compact sequence pages with owner run links', async () => {
    const { app, repository, headers } = await fixture();
    const emptyResponse = await app.inject({ method: 'POST', url: '/api/threads', headers, payload: {} });
    expect(emptyResponse.statusCode).toBe(201);
    const empty = emptyResponse.json();
    expect(empty).toMatchObject({ owner: 'alice', tenantId: 'team-a' });
    expect((await app.inject({ url: `/api/threads/${empty.id}`, headers })).json()).toMatchObject({ ...empty, runs: [] });
    const root = threadRun(); await repository.create(root);
    const created = await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { title: '  Report follow-ups  ', initialRunId: root.id } });
    expect(created.statusCode).toBe(201);
    const thread = created.json(); expect(thread.title).toBe('Report follow-ups');
    expect(await repository.get(root.id)).toMatchObject({ threadId: thread.id, threadSequence: 1 });
    const child = threadRun(); await repository.createRunInThread(child, thread.id, root.id, threadScope);
    const third = threadRun(); await repository.createRunInThread(third, thread.id, child.id, threadScope);
    const selection = vi.spyOn(repository, 'listRunsByThread');
    const first = await app.inject({ url: `/api/threads/${thread.id}?limit=2`, headers });
    expect(first.statusCode).toBe(200);
    expect(selection).toHaveBeenLastCalledWith(thread.id, threadScope, 3, 0);
    expect(first.json().runs.map((run: { threadSequence: number }) => run.threadSequence)).toEqual([1, 2]);
    expect(first.json().nextAfterSequence).toBe(2);
    expect(first.json().runs[0].links).toEqual({ run: `/runs/${root.id}`, api: `/api/runs/${root.id}` });
    expect(first.json().runs[0]).not.toHaveProperty('context');
    const second = await app.inject({ url: `/api/threads/${thread.id}?limit=2&afterSequence=2`, headers });
    expect(second.json().runs.map((run: { id: string }) => run.id)).toEqual([third.id]);
    expect(second.json()).not.toHaveProperty('nextAfterSequence');
    await app.inject({ url: `/api/threads/${thread.id}`, headers });
    expect(selection).toHaveBeenLastCalledWith(thread.id, threadScope, 51, 0);
    expect((await app.inject({ url: `/api/runs/${root.id}`, headers })).statusCode).toBe(200);
  });
  it('creates a fresh follow-up with frozen parent history, normal request budgets and independent approvals and capabilities', async () => {
    const { app, repository, headers, notify, model } = await fixture();
    const root = threadRun(); root.approval = { planHash: 'old', approved: true }; root.allowedTools = ['old-tool']; root.allowedAgents = ['old-agent'];
    await repository.create(root);
    const thread = (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { initialRunId: root.id } })).json();
    const response = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'Write the next report', maxModelCalls: 5, modelBudget: { tokens: 2000 }, externalBudget: { calls: 2 } }, contextBudgetBytes: 4096 } });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body).toMatchObject({ threadId: thread.id, parentRunId: root.id, threadSequence: 2 });
    expect(body.context.threadHistory).toMatchObject({ policyVersion: 'aeeis-thread-history/1', budgetBytes: 4096, entries: [{ runId: root.id }] });
    const child = await repository.get(body.id);
    expect(child.context).toEqual(body.context);
    expect(child).toMatchObject({ status: 'queued', goal: 'Write the next report', maxModelCalls: 5, modelBudget: { tokens: 2000 }, externalBudget: { calls: 2 }, allowedTools: [], allowedAgents: [], modelUsage: { tokens: 0, unreportedCalls: 0 } });
    expect(child.approval).toBeUndefined(); expect(child.plans).toEqual([]); expect(child.calls).toEqual([]);
    expect(child.context.sources).toEqual([]);
    expect(notify).toHaveBeenCalledWith(child.id); expect(model.complete).not.toHaveBeenCalled();
    const frozen = JSON.stringify(child.context.threadHistory);
    await repository.mutate(root.id, run => { run.goal = 'edited afterward'; });
    expect(JSON.stringify((await repository.get(child.id)).context.threadHistory)).toBe(frozen);
    expect((await repository.get(root.id)).status).toBe('succeeded');
  });
  it('creates an empty thread root and branches from an explicit terminal parent, with concurrent append sequences', async () => {
    const { app, repository, headers } = await fixture();
    const thread = (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: {} })).json();
    const rootResponse = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'root' } } });
    expect(rootResponse.statusCode).toBe(202);
    const root = rootResponse.json();
    expect(root.threadSequence).toBe(1); expect(root.parentRunId).toBeUndefined(); expect(root.context.threadHistory.entries).toEqual([]);
    await repository.mutate(root.id, run => { run.status = 'succeeded'; });
    const branches = await Promise.all(Array.from({ length: 4 }, (_, index) => app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: `branch ${index}` }, parentRunId: root.id } })));
    for (const branch of branches) {
      expect(branch.statusCode).toBe(202);
      expect(branch.json().context.threadHistory.entries.map((entry: { runId: string }) => entry.runId)).toEqual([root.id]);
    }
    expect(branches.map(response => response.json().threadSequence).sort()).toEqual([2, 3, 4, 5]);
  });
  it('defaults to the latest member and permits failed and cancelled terminal parents', async () => {
    const { app, repository, headers } = await fixture();
    const root = threadRun(); await repository.create(root);
    const thread = (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { initialRunId: root.id } })).json();
    const failed = threadRun(); failed.status = 'failed';
    await repository.createRunInThread(failed, thread.id, root.id, threadScope);
    const next = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'retry independently' } } });
    expect(next.statusCode).toBe(202);
    expect(next.json().parentRunId).toBe(failed.id);
    expect(next.json().context.threadHistory.entries.map((entry: { runId: string }) => entry.runId)).toEqual([root.id, failed.id]);
    expect((await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'live latest' } } })).statusCode).toBe(409);
    await repository.mutate(next.json().id, run => { run.status = 'cancelled'; });
    const afterCancel = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'new direction' } } });
    expect(afterCancel.statusCode).toBe(202); expect(afterCancel.json().parentRunId).toBe(next.json().id);
    expect((await repository.get(failed.id)).status).toBe('failed');
    expect((await repository.get(next.json().id)).status).toBe('cancelled');
  });
  it('requires authentication and the owner role, and hides other owners and tenants on every thread operation', async () => {
    const { app, repository, headers, notify } = await fixture();
    const thread = threadRecord(); await repository.createThread(thread);
    for (const method of ['GET', 'POST'] as const) {
      const url = method === 'GET' ? `/api/threads/${thread.id}` : `/api/threads/${thread.id}/runs`;
      const payload = method === 'GET' ? {} : { payload: { request: { goal: 'next' } } };
      expect((await app.inject({ method, url, ...payload })).statusCode).toBe(401);
      expect((await app.inject({ method, url, headers: { authorization: 'Bearer reader' }, ...payload })).statusCode).toBe(403);
      for (const token of ['bob', 'outsider']) expect((await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...payload })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/api/threads', headers: { authorization: 'Bearer reader' }, payload: {} })).statusCode).toBe(403);
    for (const id of ['bad-id', 'thread_../data', threadRecord().id]) expect((await app.inject({ url: `/api/threads/${encodeURIComponent(id)}`, headers })).statusCode).toBe(404);
    const foreign = threadRun(); foreign.owner = 'bob'; await repository.create(foreign);
    expect((await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { initialRunId: foreign.id } })).statusCode).toBe(404);
    expect(notify).not.toHaveBeenCalled();
  });
  it('returns 400 for invalid input and 409 for threaded roots, live parents, unrelated parents and privacy downgrade', async () => {
    const { app, repository, headers, notify } = await fixture();
    const root = threadRun(); root.privacy = 'private'; await repository.create(root);
    const thread = (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { initialRunId: root.id } })).json();
    expect((await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { initialRunId: root.id } })).statusCode).toBe(409);
    for (const payload of [{ title: '' }, { title: 'x'.repeat(201) }, { unknown: true }, { owner: 'bob' }, { initialRunId: 1 }]) expect((await app.inject({ method: 'POST', url: '/api/threads', headers, payload })).statusCode).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1e2', 'afterSequence=-1', 'afterSequence=2147483648', 'limit=1&limit=2', 'unknown=1']) expect((await app.inject({ url: `/api/threads/${thread.id}?${query}`, headers })).statusCode).toBe(400);
    for (const payload of [{ request: { goal: '' } }, { request: { goal: 'x', goalId: 'some-goal' } }, { request: { goal: 'x', approval: true } }, { request: { goal: 'x' }, contextBudgetBytes: 32769 }, { request: { goal: 'x', privacy: 'private' }, contextBudgetBytes: 1 }, { request: { goal: 'x' }, contextBudgetBytes: 1.5 }]) expect((await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'disclose' } } })).statusCode).toBe(409);
    const unrelated = threadRun(); await repository.create(unrelated);
    expect((await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'x', privacy: 'private' }, parentRunId: unrelated.id } })).statusCode).toBe(409);
    for (const status of ['queued', 'running', 'needs_input', 'needs_approval', 'paused'] as const) {
      await repository.mutate(root.id, run => { run.status = status; });
      expect((await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'x', privacy: 'private' } } })).statusCode).toBe(409);
    }
    expect(await repository.listRunsByThread(thread.id)).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it('rejects a changed parent at commit without persisting or dispatching a partially prepared follow-up', async () => {
    const { app, repository, headers, notify } = await fixture();
    const root = threadRun(); await repository.create(root);
    const thread = (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: { initialRunId: root.id } })).json();
    const original = repository.createRunInThread.bind(repository);
    let newId = '';
    vi.spyOn(repository, 'createRunInThread').mockImplementation(async (run, ...args) => {
      newId = run.id;
      await repository.mutate(root.id, parent => { parent.status = 'running'; });
      return original(run, ...args);
    });
    const response = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'next' } } });
    expect(response.statusCode).toBe(409);
    await expect(repository.get(newId)).rejects.toThrow(NotFound);
    expect(notify).not.toHaveBeenCalled();
  });
  it('honors server configuration up to 64 KiB and rejects invalid server budgets', async () => {
    const { app, headers } = await fixture(65536);
    const thread = (await app.inject({ method: 'POST', url: '/api/threads', headers, payload: {} })).json();
    const response = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/runs`, headers, payload: { request: { goal: 'root' }, contextBudgetBytes: 50000 } });
    expect(response.statusCode).toBe(202); expect(response.json().context.threadHistory.budgetBytes).toBe(50000);
    for (const budget of [0, 65537, NaN]) expect(() => buildApp({ repository: new FileRunRepository('/unused'), threadContextBudgetBytes: budget })).toThrow(RangeError);
  });
});
