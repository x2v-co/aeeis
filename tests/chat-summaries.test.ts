import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSummaryService, FileChatSummaryStore, InMemoryChatSummaryStore, SummarizingConversationStore, conversationSummary, foldRoomEvents, summarizedRoom } from '../src/chat-summaries.js';
import { FileConversationStore } from '../src/adapters/conversation-store.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { buildApp } from '../src/runtime/http.js';
import type { Conversation, ConversationMessage } from '../src/conversations.js';
import type { SessionEvent } from '../src/session-events.js';
import type { Room } from '../src/contracts.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, SessionEventService } from '../src/session-events.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });

let seq = 0;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 26, 8, minute)).toISOString();
const route = { status: 'general' as const, reason: 'unassigned' as const, taskIds: [], candidateTaskIds: [], focusEffect: 'keep' as const };
const hex = (value: string) => createHash('sha256').update(value).digest('hex');
const message = (text: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({ id: `message_${++seq}`, keyHash: hex(`k${seq}`), requestHash: hex(`r${seq}`), role: 'user', text, createdAt: new Date(Date.UTC(2026, 10, 26, 9, 0, seq)).toISOString(), route, ...extra });
const conversation = (messages: ConversationMessage[]): Conversation => ({ schemaVersion: 'conversation/1', id: 'conversation_1', title: '研究', agentId: 'bot_research1', ...scope, revision: messages.length, createdAt: at(0), updatedAt: at(0), recentTaskIds: [], tasks: [], messages } as Conversation);
const room = (extra: Partial<Room> = {}): Room => ({ id: 'room_1', title: '产品群', owner: 'alice', tenantId: 'team-a', chat: 'group', status: 'active', createdAt: at(0), updatedAt: at(0), ...extra });
const event = (sequence: number, extra: Partial<SessionEvent>): SessionEvent => ({ id: `event_${sequence}`, roomId: 'room_1', owner: 'alice', tenantId: 'team-a', sequence, type: 'message', actorId: 'bot_research1', actorType: 'agent', operation: 'publish', revision: 1, content: `第 ${sequence} 句`, createdAt: at(sequence), ...extra } as SessionEvent);

describe('chat summaries', () => {
  it('counts what someone else said in a conversation, never your own lines', () => {
    const summary = conversationSummary(conversation([
      message('我来问一句'),
      message('从飞书发来的', { speaker: { role: 'user', id: 'alice' }, source: { kind: 'channel', channel: 'feishu', externalEventId: 'e1', receivedAt: at(1) } }),
      message('Bot 的回答', { speaker: { role: 'agent', id: 'bot_research1' } }),
      message('简报到了：早报', { role: 'notification', notificationRunId: 'run_1' }),
      message('我保存的产物', { role: 'notification', speaker: { role: 'user', id: 'alice' }, source: { kind: 'artifact', artifactId: 'a1', title: '产物' } }),
      message('我最后说的', {}),
    ]));
    expect(summary).toMatchObject({ kind: 'direct', backing: 'conversation', counterpart: 'bot_research1', title: '研究', newCount: 2, preview: '简报到了：早报' });
    // Sorted by the last line of any kind, so your own reply moves the chat up.
    expect(summary.lastActivityAt).toBe(new Date(Date.UTC(2026, 10, 26, 9, 0, seq)).toISOString());
  });

  it('does not count a group line copied into a Bot chat, nor the edit records of an imported line', () => {
    const original = message('Bot 在私聊里说的', { speaker: { role: 'agent', id: 'bot_research1' }, source: { kind: 'room', roomId: 'room_d', eventId: 'event_a', hash: 'h', operation: 'publish', referenceOnly: false } });
    const summary = conversationSummary(conversation([
      message('群里 AEEIS 的回答', { speaker: { role: 'agent', id: 'aeeis' }, source: { kind: 'channel', channel: 'room', externalEventId: 'event_g', receivedAt: at(1) } }),
      original,
      message('改过一次', { speaker: { role: 'agent', id: 'bot_research1' }, source: { kind: 'room', roomId: 'room_d', eventId: 'event_b', hash: 'h', operation: 'revise', targetMessageId: original.id, referenceOnly: false } }),
      message('（已撤回）', { speaker: { role: 'agent', id: 'bot_research1' }, source: { kind: 'room', roomId: 'room_d', eventId: 'event_c', hash: 'h', operation: 'retract', targetMessageId: original.id, referenceOnly: false } }),
    ]));
    expect(summary.newCount).toBe(1);
    expect(summary.preview).toBe('（已撤回）');
  });

  it('counts only other people\'s new posts in a group room; edits and retractions only change the preview', () => {
    const events = [
      event(1, {}),
      event(2, { actorId: 'alice', actorType: 'principal', content: '我说的' }),
      event(3, { actorId: 'system', actorType: 'system', type: 'system', content: '已送到' }),
      event(4, { type: 'task_update', content: '任务板更新' }),
      event(5, { type: 'canonical_response', actorId: 'aeeis', content: 'AEEIS 的回答' }),
      event(6, { type: 'canonical_response', actorId: 'aeeis', operation: 'revise', targetEventId: 'event_5', revision: 2, content: '改过的回答' }),
    ];
    let summary = foldRoomEvents(room(), scope, undefined, events);
    expect(summary).toMatchObject({ kind: 'group', backing: 'room', title: '产品群', newCount: 2, preview: '改过的回答', previewEventId: 'event_6', sourceRevision: 6 });
    // Replaying events already folded changes nothing.
    expect(foldRoomEvents(room(), scope, summary, events)).toEqual(summary);
    summary = foldRoomEvents(room(), scope, summary, [event(7, { type: 'canonical_response', actorId: 'aeeis', operation: 'retract', targetEventId: 'event_6', content: 'Retracted: 错了' })]);
    expect(summary).toMatchObject({ newCount: 2, preview: '（已撤回）', sourceRevision: 7 });
    // An edit of an older line does not take over the preview.
    summary = foldRoomEvents(room(), scope, summary, [event(8, {}), event(9, { operation: 'revise', targetEventId: 'event_1', revision: 2, content: '旧的改了' })]);
    expect(summary).toMatchObject({ newCount: 3, preview: '第 8 句' });
  });

  it('summarizes group rooms only', () => {
    expect(summarizedRoom(room())).toBe(true);
    expect(summarizedRoom(room({ chat: 'direct' }))).toBe(false);
    expect(summarizedRoom(room({ chat: 'unclassified', description: '私聊' }))).toBe(false);
    expect(summarizedRoom(room({ chat: 'group', description: '侧线程' }))).toBe(false);
  });

  it('keeps the newer summary and never lowers a read marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-chat-summaries-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const store = new FileChatSummaryStore(join(directory, 'chat-summaries.json')); await store.init();
    const newer = foldRoomEvents(room(), scope, undefined, [event(1, {}), event(2, {})]);
    await store.put(newer);
    await store.put(foldRoomEvents(room(), scope, undefined, [event(1, {})]));
    expect((await store.get('room_1', scope))?.newCount).toBe(2);
    await store.put({ ...newer, owner: 'bob', sourceRevision: 99 });
    expect((await store.get('room_1', scope))?.sourceRevision).toBe(2);
    expect(await store.get('room_1', { owner: 'bob', tenantId: 'team-a' })).toBeUndefined();
    await store.markRead({ principalId: 'alice', tenantId: 'team-a', chatId: 'room_1', readCount: 2, readAt: at(3) });
    await store.markRead({ principalId: 'alice', tenantId: 'team-a', chatId: 'room_1', readCount: 1, readAt: at(4) });
    const reopened = new FileChatSummaryStore(join(directory, 'chat-summaries.json')); await reopened.init();
    expect((await reopened.reads('alice', 'team-a')).map(item => item.readCount)).toEqual([2]);
    expect((await reopened.list(scope)).map(item => item.chatId)).toEqual(['room_1']);
  });

  it('folds a room\'s new events on each write, one catch-up at a time', async () => {
    const all = [event(1, {}), event(2, {}), event(3, { actorId: 'alice', actorType: 'principal' })];
    let written = 1;
    const page = vi.fn(async (_roomId: string, _scope: unknown, limit: number, after = 0) => ({ items: all.slice(0, written).filter(item => item.sequence > after).slice(0, limit) }));
    const service = new ChatSummaryService(new InMemoryChatSummaryStore(), { page }, { getRoom: async () => room() });
    await service.roomWritten('room_1', scope);
    written = 3;
    await Promise.all([service.roomWritten('room_1', scope), service.roomWritten('room_1', scope)]);
    expect((await service.list(scope, 'alice'))[0]).toMatchObject({ chatId: 'room_1', newCount: 2, unread: 2, preview: '第 2 句' });
    expect(page.mock.calls.map(call => call[3])).toEqual([0, 1, 3]);
    const side = new ChatSummaryService(new InMemoryChatSummaryStore(), { page }, { getRoom: async () => room({ description: '侧线程' }) });
    await side.roomWritten('room_1', scope);
    expect(await side.list(scope, 'alice')).toEqual([]);
  });

  it('fills existing chats once at launch as already read', async () => {
    const store = new InMemoryChatSummaryStore();
    const page = vi.fn(async () => ({ items: [event(1, {}), event(2, {})] }));
    const service = new ChatSummaryService(store, { page }, { getRoom: async () => room() });
    const filled = await service.seed({ scanPage: async () => ({ items: [conversation([message('回答', { speaker: { role: 'agent', id: 'bot_research1' } })])] }) },
      { boardRoomsPage: async () => ({ items: [{ ...scope, roomId: 'room_1' }] }) });
    expect(filled).toBe(2);
    expect((await service.list(scope, 'alice')).map(item => [item.chatId, item.unread])).toEqual([['conversation_1', 0], ['room_1', 0]]);
    expect(await service.seed({}, {})).toBe(0);
  });
});

describe('room writes reach the summary', () => {
  it('updates a group chat\'s summary when a room event is stored, and skips side threads', async () => {
    const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
    const repository = new InMemorySessionEventRepository();
    const events = new SessionEventService(repository, domain);
    const service = new ChatSummaryService(new InMemoryChatSummaryStore(), repository, domain);
    events.onWritten = event => service.roomWritten(event.roomId, { owner: event.owner, tenantId: event.tenantId });
    const post = async (title: string, description?: string) => {
      const created = await domain.createRoom({ title, ...(description ? { description } : {}) }, undefined, scope.owner, scope.tenantId);
      const goal = await domain.createGoal({ title, roomId: created.id }, undefined, scope.owner, scope.tenantId);
      const manifest = await domain.createContextManifest(goal.id, { purpose: '测试', audienceMode: 'room' }, undefined, scope.owner, scope.tenantId);
      await events.create(created.id, { goalId: goal.id, type: 'message', content: '大家好', contextManifestId: manifest.id, idempotencyKey: randomUUID() }, scope.owner, scope.tenantId);
      return created;
    };
    const group = await post('产品群');
    await post('两位 Bot', '侧线程');
    expect(await service.list(scope, 'alice')).toEqual([expect.objectContaining({ chatId: group.id, kind: 'group', title: '产品群', unread: 0 })]);
  });
});

describe('chat list API', () => {
  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-chat-api-'));
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const summaries = new InMemoryChatSummaryStore();
    const service = new ChatSummaryService(summaries, { page: async () => ({ items: [] }) }, { getRoom: async () => room() });
    const store = new SummarizingConversationStore(new FileConversationStore(join(directory, 'conversations')), service); await store.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' }, complete: vi.fn(async () => ({ value: { summary: 'Work', nodes: [] }, usage: { inputTokens: 1, outputTokens: 1 } })) };
    const app = buildApp({ repository, engine: new AgentEngine(repository, model), conversationStore: store, chatSummaries: service, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, agent: { id: 'alice', tenantId: 'team-a', roles: ['agent'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } } });
    cleanup.push(async () => { await app.close(); await store.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    return { app, store, summaries, as };
  }

  it('lists each chat once with its unread count and marks it read up to what was seen', async () => {
    const f = await fixture();
    const created = (await f.app.inject({ method: 'POST', url: '/api/conversations', headers: f.as('alice'), payload: {} })).json();
    const list = async (token = 'alice') => (await f.app.inject({ method: 'GET', url: '/api/chats', headers: f.as(token) })).json().items;
    expect(await list()).toEqual([expect.objectContaining({ chatId: created.id, backing: 'conversation', unread: 0 })]);
    // A reply and a notice arrive while the chat is closed.
    await f.store.mutate(created.id, scope, current => { current.messages.push(message('Bot 的回答', { speaker: { role: 'agent', id: 'aeeis' } }), message('做完了：整理', { role: 'notification', notificationRunId: `run_${randomUUID()}` })); });
    expect((await list())[0]).toMatchObject({ unread: 2, preview: '做完了：整理' });
    const read = (count: number, token = 'alice') => f.app.inject({ method: 'POST', url: `/api/chats/${created.id}/read`, headers: f.as(token), payload: { count } });
    expect((await read(1)).json()).toEqual({ unread: 1 });
    // A stale tab cannot move the marker back, and nobody can read past what exists.
    expect((await read(0)).json()).toEqual({ unread: 1 });
    expect((await read(50)).json()).toEqual({ unread: 0 });
    await f.store.mutate(created.id, scope, current => { current.messages.push(message('又一句', { speaker: { role: 'agent', id: 'aeeis' } })); });
    expect((await list())[0]).toMatchObject({ unread: 1, preview: '又一句' });
    // Your own line moves the chat but adds nothing unread.
    await f.store.mutate(created.id, scope, current => { current.messages.push(message('收到')); });
    expect((await list())[0]).toMatchObject({ unread: 1 });
    // A write that changes nothing (opening the chat) does not rewrite the summary.
    const put = vi.spyOn(f.summaries, 'put');
    await f.store.mutate(created.id, scope, () => undefined);
    expect(put).not.toHaveBeenCalled();
    expect(await list('bob')).toEqual([]);
    expect((await f.app.inject({ method: 'GET', url: '/api/chats', headers: f.as('agent') })).statusCode).toBe(403);
    expect((await read(1, 'agent')).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: `/api/chats/${created.id}/read`, headers: f.as('alice'), payload: { count: -1 } })).statusCode).toBe(400);
  });
});
