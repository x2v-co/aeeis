import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService, runNoticeText } from '../src/application/conversation-service.js';
import { ThreadService } from '../src/application/thread-service.js';
import { FileConversationStore } from '../src/adapters/conversation-store.js';
import { FileConversationThreadIndex, InMemoryConversationThreadIndex } from '../src/adapters/conversation-thread-index.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-run-notices-'));
  const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
  const store = new FileConversationStore(join(directory, 'conversations')); await store.init();
  const index = new FileConversationThreadIndex(join(directory, 'conversation-threads.json')); await index.init();
  const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' }, complete: vi.fn(async () => ({ value: { summary: 'Work', nodes: [{ id: 'work', title: 'Work', instruction: 'Complete task', dependsOn: [] }] }, usage: { inputTokens: 10, outputTokens: 5 } })) };
  const engine = new AgentEngine(repository, model), threads = new ThreadService(repository, engine);
  const app = buildApp({ repository, engine, conversationStore: store, conversationThreads: index, dispatcher: { notify: vi.fn(async () => undefined), close: async () => undefined }, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
  cleanup.push(async () => { await app.close(); await index.close(); await store.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer alice' };
  const create = async () => (await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {} })).json();
  const fresh = async (id: string) => store.get(id, scope);
  const post = (id: string, body: object) => app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: body });
  const execute = async (id: string, body: object) => {
    const current = await fresh(id);
    const response = await post(id, { focus: 'switch', intent: 'execute', expectedRevision: current.revision, ...body });
    expect(response.statusCode, response.body).toBe(202);
    return response.json() as { runId: string; message: { route: { taskIds: string[] } } };
  };
  const notices = async (id: string) => (await fresh(id)).messages.filter(message => message.role === 'notification');
  return { directory, repository, store, index, engine, threads, app, create, fresh, post, execute, notices };
}

describe('Run notices without opening the chat', () => {
  it('writes one plain-worded notice when a Run stops to wait, and links the thread before the Run starts', async () => {
    const f = await fixture(), entry = await f.create();
    const started = await f.execute(entry.id, { text: '整理周报', newTask: { title: '周报' } });
    const run = await f.repository.get(started.runId);
    expect(await f.index.get(run.threadId!, scope)).toMatchObject({ conversationId: entry.id, taskId: started.message.route.taskIds[0] });
    // Still running: nothing to say yet.
    expect(await f.app.aeeisRunNotice!(run)).toBe(false);
    await f.engine.advance(started.runId);
    const waiting = await f.repository.get(started.runId);
    expect(waiting.status).toBe('needs_approval');
    expect(await f.app.aeeisRunNotice!(waiting)).toBe(true);
    const written = await f.notices(entry.id);
    expect(written.map(message => message.text)).toEqual(['等你批准：周报']);
    expect(written[0]!.notificationRunId).toBe(started.runId);
    // The scanner sees the Run again on every sweep: the index skips it without a second line.
    const mutate = vi.spyOn(f.store, 'mutate');
    expect(await f.app.aeeisRunNotice!(waiting)).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    // Opening the chat writes nothing more for the same state.
    const sync = await f.app.inject({ method: 'POST', url: `/api/conversations/${entry.id}/notifications/sync`, headers: { authorization: 'Bearer alice' }, payload: {} });
    expect(sync.json().messages.filter((message: { role: string }) => message.role === 'notification')).toHaveLength(1);
    // A real change of state is a new notice.
    await f.repository.mutate(started.runId, current => { current.status = 'succeeded'; });
    expect(await f.app.aeeisRunNotice!(await f.repository.get(started.runId))).toBe(true);
    expect((await f.notices(entry.id)).map(message => message.text)).toEqual(['等你批准：周报', '做完了：周报']);
  });

  it('keeps a replaced Run quiet; only the newest Run of a thread speaks', async () => {
    const f = await fixture(), entry = await f.create();
    const first = await f.execute(entry.id, { text: '第一次', newTask: { title: '核对' } });
    await f.repository.mutate(first.runId, current => { current.status = 'succeeded'; });
    const second = await f.execute(entry.id, { text: '再来一次', taskIds: first.message.route.taskIds });
    expect((await f.repository.get(second.runId)).threadId).toBe((await f.repository.get(first.runId)).threadId);
    const old = await f.repository.get(first.runId);
    expect(await f.app.aeeisRunNotice!(old)).toBe(false);
    expect(await f.notices(entry.id)).toEqual([]);
  });

  it('fills the index once at launch and counts every existing Run as already noticed', async () => {
    const f = await fixture(), entry = await f.create();
    const started = await f.execute(entry.id, { text: '旧任务', newTask: { title: '旧任务' } });
    await f.engine.advance(started.runId);
    const waiting = await f.repository.get(started.runId);
    // A fresh index, as on the first deploy: nothing linked yet.
    const index = new InMemoryConversationThreadIndex();
    const service = new ConversationService(f.store, f.repository, f.threads, undefined, undefined, undefined, undefined, index);
    expect(await service.noticeRun(waiting)).toBe(false);
    expect(await service.seedThreadIndex()).toBe(1);
    expect(await index.seeded()).toBe(true);
    expect(await service.seedThreadIndex()).toBe(0);
    // The old waiting Run does not flood the chat at launch...
    expect(await service.noticeRun(waiting)).toBe(false);
    expect(await f.notices(entry.id)).toEqual([]);
    // ...but a change after launch does notify, even after an unrelated write moved updatedAt.
    await f.repository.mutate(started.runId, current => { current.updatedAt = new Date(Date.now() + 1000).toISOString(); });
    expect(await service.noticeRun(await f.repository.get(started.runId))).toBe(false);
    await f.repository.mutate(started.runId, current => { current.status = 'failed'; });
    expect(await service.noticeRun(await f.repository.get(started.runId))).toBe(true);
    expect((await f.notices(entry.id)).map(message => message.text)).toEqual(['没做完：旧任务']);
  });

  it('keeps the index across a restart and refuses another owner', async () => {
    const f = await fixture(), entry = await f.create();
    const started = await f.execute(entry.id, { text: '记下', newTask: { title: '记下' } });
    const threadId = (await f.repository.get(started.runId)).threadId!;
    await f.index.markNotified(threadId, scope, { runId: started.runId, key: 'k1' });
    await f.index.markSeeded();
    const reopened = new FileConversationThreadIndex(join(f.directory, 'conversation-threads.json')); await reopened.init();
    expect(await reopened.get(threadId, scope)).toMatchObject({ conversationId: entry.id, notified: { runId: started.runId, key: 'k1' } });
    expect(await reopened.seeded()).toBe(true);
    expect(await reopened.get(threadId, { owner: 'bob', tenantId: 'team-a' })).toBeUndefined();
    expect(await reopened.link({ threadId, conversationId: 'other', taskId: 'other', ...scope })).toBe(false);
  });

  it('calls a finished routine Run a brief, through the real routine start', async () => {
    const f = await fixture();
    const service = new ConversationService(f.store, f.repository, f.threads, undefined, undefined, undefined, undefined, f.index);
    const started = await service.startRoutine({ agentId: 'aeeis', text: '整理今天的情报', taskTitle: '工作日情报简报', runOptions: {}, key: 'routine-delivery-1', source: { kind: 'routine', routineId: `routine_${randomUUID()}`, deliveryId: 'delivery_1', trigger: 'schedule' } }, scope, true);
    await f.repository.mutate(started.runId, current => { current.status = 'succeeded'; });
    expect(await service.noticeRun(await f.repository.get(started.runId))).toBe(true);
    expect((await f.notices(started.conversationId)).map(message => message.text)).toEqual(['简报到了：工作日情报简报']);
  });

  it('still starts the work when the thread link fails, and links the thread when the chat opens', async () => {
    const f = await fixture(), entry = await f.create();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const link = vi.spyOn(f.index, 'link').mockRejectedValueOnce(new Error('database hiccup'));
    const started = await f.execute(entry.id, { text: '照常开工', newTask: { title: '照常开工' } });
    const threadId = (await f.repository.get(started.runId)).threadId!;
    expect(link).toHaveBeenCalledTimes(1);
    expect(await f.index.get(threadId, scope)).toBeUndefined();
    await f.engine.advance(started.runId);
    // Without a link the notifier cannot find the chat yet...
    expect(await f.app.aeeisRunNotice!(await f.repository.get(started.runId))).toBe(false);
    // ...opening the chat writes the notice as today and repairs the link.
    await f.app.inject({ method: 'POST', url: `/api/conversations/${entry.id}/notifications/sync`, headers: { authorization: 'Bearer alice' }, payload: {} });
    expect(await f.index.get(threadId, scope)).toMatchObject({ conversationId: entry.id });
    expect((await f.notices(entry.id)).map(message => message.text)).toEqual(['等你批准：照常开工']);
    await f.repository.mutate(started.runId, current => { current.status = 'cancelled'; });
    expect(await f.app.aeeisRunNotice!(await f.repository.get(started.runId))).toBe(true);
  });

  it('gives up once on a notice its chat refuses, instead of retrying every sweep', async () => {
    const f = await fixture(), entry = await f.create();
    const started = await f.execute(entry.id, { text: '满了', newTask: { title: '满了' } });
    await f.engine.advance(started.runId);
    const waiting = await f.repository.get(started.runId);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { Conflict } = await import('../src/runtime/engine.js');
    vi.spyOn(f.store, 'mutate').mockRejectedValueOnce(new Conflict('Invalid conversation state or capacity exceeded (100 tasks / 1000 messages)'));
    expect(await f.app.aeeisRunNotice!(waiting)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect((await f.index.get(waiting.threadId!, scope))?.notified?.runId).toBe(started.runId);
    // The next sweep skips it without touching the chat.
    expect(await f.app.aeeisRunNotice!(waiting)).toBe(false);
    expect(f.store.mutate).toHaveBeenCalledTimes(1);
    // Other failures are not swallowed: the sweep retries them.
    await f.repository.mutate(started.runId, current => { current.status = 'failed'; });
    vi.spyOn(f.store, 'mutate').mockRejectedValueOnce(new Error('database down'));
    await expect(f.app.aeeisRunNotice!(await f.repository.get(started.runId))).rejects.toThrow('database down');
    expect((await f.index.get(waiting.threadId!, scope))?.notified?.key).not.toBe(undefined);
    expect(await f.app.aeeisRunNotice!(await f.repository.get(started.runId))).toBe(true);
  });

  it('says what happened in plain words, never a status name', () => {
    expect(runNoticeText('早报', 'succeeded', true)).toBe('简报到了：早报');
    expect(runNoticeText('早报', 'succeeded', false)).toBe('做完了：早报');
    expect(runNoticeText('早报', 'needs_approval', false)).toBe('等你批准：早报');
    expect(runNoticeText('早报', 'needs_input', false)).toBe('等你回答：早报');
    expect(runNoticeText('早报', 'failed', false)).toBe('没做完：早报');
    expect(runNoticeText('早报', 'cancelled', false)).toBe('已取消：早报');
    expect(runNoticeText('早报', 'unknown', false)).toBe('状态读不到，待核查：早报');
  });
});
