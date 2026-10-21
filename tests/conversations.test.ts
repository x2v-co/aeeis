import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationService } from '../src/application/conversation-service.js';
import { ThreadService } from '../src/application/thread-service.js';
import { FileConversationStore } from '../src/adapters/conversation-store.js';
import { AgentEngine, Conflict } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversations-'));
  const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
  const store = new FileConversationStore(join(directory, 'conversations')); await store.init();
  const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' }, complete: vi.fn(async () => ({ value: { summary: 'Work', nodes: [{ id: 'work', title: 'Work', instruction: 'Complete task', dependsOn: [] }] }, usage: { inputTokens: 10, outputTokens: 5 } })) };
  const engine = new AgentEngine(repository, model), threads = new ThreadService(repository, engine);
  const service = new ConversationService(store, repository, threads);
  const notify = vi.fn(async (id: string) => {
    const run = await repository.get(id);
    expect(run.threadId).toBeDefined();
    const entries = await store.list(scope);
    expect(entries.some(entry => entry.messages.some(message => message.execution?.runId === id && message.execution.state === 'completed'))).toBe(true);
  });
  const app = buildApp({ repository, engine, conversationStore: store, dispatcher: { notify, close: async () => undefined }, principalTokens: {
    alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
    bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
    elsewhere: { id: 'alice', tenantId: 'team-b', roles: ['owner'] },
    agent: { id: 'alice', tenantId: 'team-a', roles: ['agent'] },
  } });
  cleanup.push(async () => { await app.close(); await store.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: 'Bearer alice' };
  const create = async () => (await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: {} })).json();
  const post = (id: string, body: object, key: string = randomUUID()) => app.inject({ method: 'POST', url: `/api/conversations/${id}/messages`, headers: { ...headers, 'idempotency-key': key }, payload: body });
  const fresh = async (id: string) => (await app.inject({ method: 'GET', url: `/api/conversations/${id}`, headers })).json();
  const addTask = async (id: string, title: string, intent = 'discuss') => {
    const current = await fresh(id);
    const response = await post(id, { text: `${title}的需求`, newTask: { title }, intent, focus: 'switch', expectedRevision: current.revision });
    expect(response.statusCode, response.body).toBe(intent === 'execute' ? 202 : 200);
    return response.json();
  };
  return { directory, repository, store, model, engine, threads, service, app, notify, headers, create, post, fresh, addTask };
}

describe('single-entry conversation routing', () => {
  it('persists task focus and discussion without invoking a model or creating a Run', async () => {
    const f = await fixture(), entry = await f.create();
    const result = await f.addTask(entry.id, 'AEEIS 工作记忆');
    expect(result.conversation.focusTaskId).toBe(result.message.route.taskIds[0]);
    expect(result.message.route.reason).toBe('new-task');
    expect(result.runId).toBeUndefined();
    expect(await f.repository.list()).toEqual([]);
    expect(f.model.complete).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
    expect((await f.fresh(entry.id)).messages).toHaveLength(1);
  });
  it('keeps side questions separate from focus and supports explicit focus switching', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, 'AEEIS'), b = await f.addTask(entry.id, 'Grok 迁移');
    const aId = a.message.route.taskIds[0], bId = b.message.route.taskIds[0];
    const side = await f.post(entry.id, { text: 'AEEIS 的预算是什么？', expectedRevision: b.conversation.revision });
    expect(side.json().message.route).toMatchObject({ taskIds: [aId], reason: 'name', focusEffect: 'keep' });
    expect(side.json().conversation.focusTaskId).toBe(bId);
    const follow = await f.post(entry.id, { text: '这个先暂停讨论', expectedRevision: side.json().conversation.revision });
    expect(follow.json().message.route.taskIds).toEqual([bId]);
    const switched = await f.app.inject({ method: 'POST', url: `/api/conversations/${entry.id}/focus`, headers: f.headers, payload: { taskId: aId, expectedRevision: follow.json().conversation.revision } });
    expect(switched.json().focusTaskId).toBe(aId);
    expect(f.notify).not.toHaveBeenCalled();
  });
  it('routes replies to their original task and rejects conflicting selectors', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '任务甲'), b = await f.addTask(entry.id, '任务乙');
    const reply = await f.post(entry.id, { text: '这里补充一下', replyTo: a.message.id, expectedRevision: b.conversation.revision });
    expect(reply.json().message.route).toMatchObject({ reason: 'reply', taskIds: a.message.route.taskIds });
    expect(reply.json().conversation.focusTaskId).toBe(b.message.route.taskIds[0]);
    const conflict = await f.post(entry.id, { text: '继续', replyTo: a.message.id, taskIds: b.message.route.taskIds, expectedRevision: reply.json().conversation.revision, intent: 'execute' });
    expect(conflict.statusCode).toBe(409); expect(f.notify).not.toHaveBeenCalled();
    expect((await f.post(entry.id, { text: '继续', replyTo: 'not-a-message', expectedRevision: 0 })).statusCode).toBe(404);
  });
  it('clarifies an ambiguous continuation and never guesses an execution target', async () => {
    const f = await fixture(), entry = await f.create();
    await f.addTask(entry.id, '任务甲'); const b = await f.addTask(entry.id, '任务乙');
    const cleared = await f.service.focus(entry.id, { taskId: null, expectedRevision: b.conversation.revision }, scope);
    const response = await f.post(entry.id, { text: '继续吧', intent: 'execute', expectedRevision: cleared.revision });
    expect(response.statusCode).toBe(200);
    expect(response.json().message.route.status).toBe('clarify');
    expect(response.json().message.route.candidateTaskIds).toHaveLength(2);
    expect(response.json().runId).toBeUndefined();
    expect(await f.repository.list()).toHaveLength(0); expect(f.notify).not.toHaveBeenCalled();
  });
  it('allows multi-task discussion but requires one explicit execution target', async () => {
    const f = await fixture(), entry = await f.create();
    await f.addTask(entry.id, '任务甲'); const b = await f.addTask(entry.id, '任务乙');
    const compared = await f.post(entry.id, { text: '比较任务甲和任务乙', expectedRevision: b.conversation.revision });
    expect(compared.json().message.route.taskIds).toHaveLength(2);
    const execute = await f.post(entry.id, { text: '继续任务甲和任务乙', expectedRevision: compared.json().conversation.revision, intent: 'execute' });
    expect(execute.json().message.route.status).toBe('clarify'); expect(f.notify).not.toHaveBeenCalled();
  });
  it('keeps short titles and the discussion focus from starting a Run', async () => {
    const f = await fixture(), entry = await f.create();
    await f.addTask(entry.id, '报告');
    await f.addTask(entry.id, 'API');
    const budget = await f.addTask(entry.id, '年度预算');
    const budgetId = budget.message.route.taskIds[0];
    const discuss = await f.post(entry.id, { text: '生成报告', expectedRevision: budget.conversation.revision });
    expect(discuss.json().message.route).toMatchObject({ status: 'routed', reason: 'focus', taskIds: [budgetId] });
    expect(discuss.json().conversation.focusTaskId).toBe(budgetId);
    const apis = await f.post(entry.id, { text: '比较 APIs', expectedRevision: discuss.json().conversation.revision });
    expect(apis.json().message.route).toMatchObject({ reason: 'focus', taskIds: [budgetId] });
    const execute = await f.post(entry.id, { text: '生成报告', expectedRevision: apis.json().conversation.revision, intent: 'execute' });
    expect(execute.statusCode).toBe(200);
    expect(execute.json().message.route.status).toBe('clarify');
    expect(execute.json().runId).toBeUndefined();
    expect(execute.json().response).toContain('没有触发执行');
    expect(await f.repository.list()).toHaveLength(0);
    expect(f.notify).not.toHaveBeenCalled();
  });
  it('releases a task when preparation fails before a Run exists and replays the same key without executing', async () => {
    const f = await fixture(), entry = await f.create();
    const task = await f.addTask(entry.id, '年度预算');
    vi.spyOn(ThreadService.prototype, 'followUp').mockRejectedValueOnce(new Conflict('dispatcher refused'));
    const failed = await f.post(entry.id, { text: '生成报告', taskIds: task.message.route.taskIds, expectedRevision: 0, intent: 'execute' }, 'prep-fail');
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toEqual({ error: 'dispatcher refused' });
    const stored = await f.store.get(entry.id, scope);
    const reserved = stored.messages.at(-1)!;
    expect(reserved.execution?.state).toBe('cancelled');
    expect(stored.tasks.find(item => item.id === reserved.execution?.taskId)?.pendingMessageId).toBeUndefined();
    const replay = await f.post(entry.id, { text: '生成报告', taskIds: task.message.route.taskIds, expectedRevision: 0, intent: 'execute' }, 'prep-fail');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().runId).toBeUndefined();
    expect(replay.json().response).toContain('这次执行没有创建');
    const again = await f.post(entry.id, { text: '重新执行', taskIds: task.message.route.taskIds, expectedRevision: replay.json().conversation.revision, intent: 'execute' }, 'prep-retry');
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().runId).toBeDefined();
  });
  it('keeps the reservation when the Run exists and the same key finishes it', async () => {
    const f = await fixture(), entry = await f.create();
    const task = await f.addTask(entry.id, '年度预算');
    const original = ThreadService.prototype.followUp;
    vi.spyOn(ThreadService.prototype, 'followUp').mockImplementationOnce(async function (this: ThreadService, ...args) {
      await original.apply(this, args);
      throw new Conflict('lost acknowledgement');
    });
    const failed = await f.post(entry.id, { text: '开始执行', taskIds: task.message.route.taskIds, expectedRevision: 0, intent: 'execute' }, 'lost-ack');
    expect(failed.statusCode).toBe(409);
    expect(failed.json()).toEqual({ error: 'lost acknowledgement', retrySameRequest: true });
    const stored = await f.store.get(entry.id, scope);
    const reserved = stored.messages.at(-1)!;
    expect(reserved.execution?.state).toBe('pending');
    expect(stored.tasks.find(item => item.id === reserved.execution?.taskId)?.pendingMessageId).toBe(reserved.id);
    const replay = await f.post(entry.id, { text: '开始执行', taskIds: task.message.route.taskIds, expectedRevision: 0, intent: 'execute' }, 'lost-ack');
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json().runId).toBe(reserved.execution?.runId);
    expect((await f.store.get(entry.id, scope)).messages.at(-1)!.execution?.state).toBe('completed');
  });
  it('rejects stale implicit/focus-changing messages while permitting independent explicit task writes', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '任务甲'), b = await f.addTask(entry.id, '任务乙');
    expect((await f.post(entry.id, { text: '继续吧', expectedRevision: a.conversation.revision, intent: 'execute' })).statusCode).toBe(409);
    expect((await f.post(entry.id, { text: '切换', taskIds: a.message.route.taskIds, focus: 'switch', expectedRevision: a.conversation.revision })).statusCode).toBe(409);
    const replies = await Promise.all([a, b].map(task => f.post(entry.id, { text: '补充独立笔记', taskIds: task.message.route.taskIds, expectedRevision: 0 })));
    expect(replies.map(response => response.statusCode)).toEqual([200, 200]);
    expect((await f.fresh(entry.id)).messages).toHaveLength(4);
  });
  it('creates two isolated Run threads and freezes task-local discussion before dispatch', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '任务甲'), b = await f.addTask(entry.id, '任务乙');
    await f.post(entry.id, { text: '甲的预算只有 11 元', taskIds: a.message.route.taskIds, expectedRevision: 0 });
    await f.post(entry.id, { text: '乙的预算只有 29 元', taskIds: b.message.route.taskIds, expectedRevision: 0 });
    const results = await Promise.all([a, b].map(task => f.post(entry.id, { text: '生成报告', taskIds: task.message.route.taskIds, expectedRevision: 0, intent: 'execute' })));
    expect(results.map(response => response.statusCode), results.map(response => response.body).join('\n')).toEqual([202, 202]);
    const runs = await Promise.all(results.map(response => f.repository.get(response.json().runId)));
    expect(runs[0]!.threadId).not.toBe(runs[1]!.threadId);
    expect(JSON.stringify(runs[0]!.context)).toContain('11 元'); expect(JSON.stringify(runs[0]!.context)).not.toContain('29 元');
    expect(JSON.stringify(runs[1]!.context)).toContain('29 元'); expect(JSON.stringify(runs[1]!.context)).not.toContain('11 元');
    expect(runs.every(run => !!run.workingMemory)).toBe(true);
    await f.repository.mutate(runs[0]!.id, run => {
      run.workingMemory!.originals.push({ id: 'wm_original_secret', taskId: 'inspect', planVersion: 1, planHash: 'hash', phase: 'executor', locator: 'observations/0', capturedAtEventSeq: 1, text: 'SECRET ORIGINAL FACT', contentHash: 'abc', evidenceRefs: [], accessHash: 'def' });
      run.workingMemory!.summaries.push(
        { version: 1, manifestId: 'wm_manifest_a', callId: 'call_a', status: 'active', items: [{ text: 'SECRET SUMMARY TEXT', references: ['wm_slice_a'] }], contentHash: 'ghi' },
        { version: 2, manifestId: 'wm_manifest_b', callId: 'call_b', status: 'rejected', items: [], contentHash: 'jkl' },
      );
    });
    const projected = await f.fresh(entry.id);
    expect(projected.tasks.find(task => task.latestRunId === runs[0]!.id)?.memory).toEqual({ originals: 1, activeSummaries: 1 });
    expect(projected.tasks.find(task => task.latestRunId === runs[1]!.id)?.memory).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    expect(f.notify).toHaveBeenCalledTimes(2); expect(f.model.complete).not.toHaveBeenCalled();
    expect(JSON.stringify(results[0]!.json().conversation)).not.toContain('"request"');
    expect((await f.post(entry.id, { text: '再执行一次', taskIds: a.message.route.taskIds, expectedRevision: 0, intent: 'execute' })).statusCode).toBe(409);
    expect((await f.post(entry.id, { text: '可以继续讨论', taskIds: a.message.route.taskIds, expectedRevision: 0 })).statusCode).toBe(200);
  });
  it('deduplicates concurrent/lost-response submissions without rerouting after a focus switch', async () => {
    const f = await fixture(), entry = await f.create();
    const payload = { text: '检查状态', newTask: { title: '独立任务' }, expectedRevision: entry.revision, intent: 'execute', focus: 'switch' };
    const replies = await Promise.all(Array.from({ length: 5 }, () => f.post(entry.id, payload, 'same-request')));
    expect(replies.map(response => response.statusCode), replies.map(response => response.body).join('\n')).toEqual(Array(5).fill(202));
    expect(new Set(replies.map(response => response.json().runId)).size).toBe(1);
    expect(await f.repository.list()).toHaveLength(1);
    expect((await f.fresh(entry.id)).messages).toHaveLength(1);
    await f.repository.mutate(replies[0]!.json().runId, run => { run.status = 'succeeded'; });
    const b = await f.addTask(entry.id, '另一个任务');
    f.notify.mockClear();
    const retry = await f.post(entry.id, payload, 'same-request');
    expect(retry.json().message).toEqual(replies[0]!.json().message);
    expect(retry.json().conversation.focusTaskId).toBe(b.message.route.taskIds[0]); expect(f.notify).not.toHaveBeenCalled();
    expect((await f.post(entry.id, { ...payload, text: '不同请求' }, 'same-request')).statusCode).toBe(409);
  });
  it('keeps notifications task-bound without stealing focus and supports replying to them', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '后台任务', 'execute'), b = await f.addTask(entry.id, '前台讨论');
    await f.engine.advance(a.runId);
    const sync = await f.app.inject({ method: 'POST', url: `/api/conversations/${entry.id}/notifications/sync`, headers: f.headers, payload: {} });
    const notification = sync.json().messages.find((message: any) => message.role === 'notification');
    expect(notification.notificationRunId).toBe(a.runId);
    expect(sync.json().focusTaskId).toBe(b.message.route.taskIds[0]);
    const again = await f.app.inject({ method: 'POST', url: `/api/conversations/${entry.id}/notifications/sync`, headers: f.headers, payload: {} });
    expect(again.json().messages).toHaveLength(sync.json().messages.length); expect(again.json().revision).toBe(sync.json().revision);
    const reply = await f.post(entry.id, { text: '为什么要审批？', replyTo: notification.id, expectedRevision: 0 });
    expect(reply.json().message.route.taskIds).toEqual(a.message.route.taskIds);
    expect((await f.repository.get(a.runId)).status).toBe('needs_approval');
  });
  it('recovers a Run committed before the conversation acknowledgement and keeps focus after restart', async () => {
    const f = await fixture(), entry = await f.create();
    const original = f.threads.followUp.bind(f.threads);
    vi.spyOn(f.threads, 'followUp').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('lost acknowledgement'); });
    await expect(f.service.post(entry.id, { text: '执行任务', newTask: { title: '恢复任务' }, expectedRevision: 0, intent: 'execute', focus: 'switch' }, scope, 'recover-me', true)).rejects.toThrow('lost acknowledgement');
    const before = await f.store.get(entry.id, scope);
    expect(before.messages[0]!.execution?.state).toBe('pending'); expect(await f.repository.list()).toHaveLength(1);
    await f.store.close(); await f.repository.close();
    const restoredRuns = new FileRunRepository(join(f.directory, 'runs')), restoredStore = new FileConversationStore(join(f.directory, 'conversations'));
    await restoredRuns.init(); await restoredStore.init();
    try {
      const engine = new AgentEngine(restoredRuns, f.model);
      const service = new ConversationService(restoredStore, restoredRuns, new ThreadService(restoredRuns, engine));
      await service.recover();
      const after = await restoredStore.get(entry.id, scope);
      expect(after.focusTaskId).toBe(before.focusTaskId);
      expect(after.messages[0]!.execution?.state).toBe('completed');
      expect(await restoredRuns.list()).toHaveLength(1); expect(f.model.complete).not.toHaveBeenCalled();
    } finally { await restoredStore.close(); await restoredRuns.close(); await f.repository.init(); }
  });
  it('isolates owner/tenant access and denies non-owner routing before returning candidates', async () => {
    const f = await fixture(), entry = await f.create(); await f.addTask(entry.id, '私有任务');
    for (const token of ['bob', 'elsewhere', 'agent']) {
      const headers = { authorization: `Bearer ${token}`, 'idempotency-key': 'guess' };
      for (const [method, path, payload] of [['GET', '', undefined], ['POST', '/messages', { text: '继续', expectedRevision: 0 }], ['POST', '/focus', { taskId: null, expectedRevision: 0 }], ['POST', '/notifications/sync', {}]] as const) {
        const response = await f.app.inject({ method, url: `/api/conversations/${entry.id}${path}`, headers, ...(payload ? { payload } : {}) });
        expect(response.statusCode).toBe(token === 'agent' ? 403 : 404); expect(response.body).not.toContain('私有任务');
      }
      const list = await f.app.inject({ method: 'GET', url: '/api/conversations', headers });
      if (token !== 'agent') expect(list.json()).toEqual([]);
    }
  });
  it('keeps Run continuation in the task Thread without importing another task history', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '任务甲', 'execute');
    await f.repository.mutate(a.runId, run => { run.status = 'succeeded'; });
    await f.addTask(entry.id, '任务乙', 'execute');
    const response = await f.post(entry.id, { text: '继续甲的报告', taskIds: a.message.route.taskIds, intent: 'execute', expectedRevision: 0 });
    expect(response.statusCode, response.body).toBe(202);
    const next = await f.repository.get(response.json().runId), previous = await f.repository.get(a.runId);
    expect(next.threadId).toBe(previous.threadId); expect(next.parentRunId).toBe(a.runId);
    expect(JSON.stringify(next.context)).not.toContain('任务乙');
    expect(next.threadSequence).toBe(2);
  });
  it('appends routing corrections without rewriting history and uses corrected notes only for their new task', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '任务甲'), b = await f.addTask(entry.id, '任务乙');
    const note = (await f.post(entry.id, { text: '特有约束 beta-only-fact', taskIds: a.message.route.taskIds, expectedRevision: 0 })).json();
    const correction = await f.post(entry.id, { text: '纠正这条讨论的任务归属', correctsMessageId: note.message.id, taskIds: b.message.route.taskIds, expectedRevision: note.conversation.revision });
    expect(correction.statusCode, correction.body).toBe(200);
    const original = correction.json().conversation.messages.find((message: any) => message.id === note.message.id);
    expect(original.route.taskIds).toEqual(a.message.route.taskIds);
    expect(original.effectiveTaskIds).toEqual(b.message.route.taskIds);
    expect(original.text).toBe('特有约束 beta-only-fact');
    expect(correction.json().response).toContain('已有执行记录不变');
    expect((await f.post(entry.id, { text: '补充', replyTo: note.message.id, expectedRevision: 0 })).json().message.route.taskIds).toEqual(b.message.route.taskIds);
    const started = await Promise.all([a, b].map(task => f.post(entry.id, { text: '执行', taskIds: task.message.route.taskIds, expectedRevision: 0, intent: 'execute' })));
    const runs = await Promise.all(started.map(response => f.repository.get(response.json().runId)));
    expect(JSON.stringify(runs[0]!.context)).not.toContain('beta-only-fact');
    expect(JSON.stringify(runs[1]!.context)).toContain('beta-only-fact');
    const current = await f.fresh(entry.id);
    expect((await f.post(entry.id, { text: '改已执行消息', correctsMessageId: started[0]!.json().message.id, taskIds: b.message.route.taskIds, expectedRevision: current.revision })).statusCode).toBe(409);
    expect((await f.post(entry.id, { text: '过期纠正', correctsMessageId: note.message.id, taskIds: a.message.route.taskIds, expectedRevision: note.conversation.revision })).statusCode).toBe(409);
  });
  it('uses only the latest correction when one discussion is reassigned twice', async () => {
    const f = await fixture(), entry = await f.create();
    const a = await f.addTask(entry.id, '任务甲'), b = await f.addTask(entry.id, '任务乙'), c = await f.addTask(entry.id, '任务丙');
    const aId = a.message.route.taskIds[0]!, bId = b.message.route.taskIds[0]!, cId = c.message.route.taskIds[0]!;
    const note = (await f.post(entry.id, { text: 'triple-correction-fact', taskIds: [aId], expectedRevision: 0 })).json();
    const first = await f.post(entry.id, { text: '纠正这条讨论的任务归属', correctsMessageId: note.message.id, taskIds: [bId], expectedRevision: note.conversation.revision });
    expect(first.statusCode, first.body).toBe(200);
    const second = await f.post(entry.id, { text: '纠正这条讨论的任务归属', correctsMessageId: note.message.id, taskIds: [cId], expectedRevision: first.json().conversation.revision });
    expect(second.statusCode, second.body).toBe(200);
    const current = await f.fresh(entry.id);
    const original = current.messages.find((message: any) => message.id === note.message.id)!;
    expect(original.route.taskIds).toEqual([aId]);
    expect(original.effectiveTaskIds).toEqual([cId]);
    expect((await f.post(entry.id, { text: '补充后续约束', replyTo: note.message.id, expectedRevision: 0 })).json().message.route.taskIds).toEqual([cId]);
    const started = await Promise.all([aId, bId, cId].map(taskId => f.post(entry.id, { text: '执行', taskIds: [taskId], expectedRevision: 0, intent: 'execute' })));
    expect(started.map(response => response.statusCode), started.map(response => response.body).join('\n')).toEqual([202, 202, 202]);
    const runs = await Promise.all(started.map(response => f.repository.get(response.json().runId)));
    expect(JSON.stringify(runs[0]!.context)).not.toContain('triple-correction-fact');
    expect(JSON.stringify(runs[1]!.context)).not.toContain('triple-correction-fact');
    expect(JSON.stringify(runs[1]!.context)).not.toContain('纠正这条讨论');
    expect(JSON.stringify(runs[2]!.context)).toContain('triple-correction-fact');
  });
  it('rejects forged scope, empty keys and undeclared input without mutation', async () => {
    const f = await fixture(), entry = await f.create();
    for (const extra of [{ owner: 'bob' }, { tenantId: 'other' }, { runId: 'run_fake' }]) expect((await f.post(entry.id, { text: 'hello', expectedRevision: 0, ...extra })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: `/api/conversations/${entry.id}/messages`, headers: f.headers, payload: { text: 'hello', expectedRevision: 0 } })).statusCode).toBe(400);
    expect((await f.fresh(entry.id)).messages).toHaveLength(0);
  });
});
