import { InMemoryTaskBoardStore, FileTaskBoardStore, PostgresTaskBoardStore } from '../../src/adapters/task-board-store.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InMemoryBotDialogueStore, FileBotDialogueStore, PostgresBotDialogueStore, type BotDialogueStore } from '../../src/bot-dialogues.js';
import { InMemoryConversationStore, FileConversationStore, PostgresConversationStore } from '../../src/adapters/conversation-store.js';
import { JsonFileStore } from '../../src/adapters/json-store.js';
import { FileRunRepository } from '../../src/runtime/repository.js';
import { InMemoryStore } from '../../src/adapters/in-memory-store.js';
import { PostgresAeeisStore } from '../../src/adapters/postgres-store.js';
import { InMemoryRoomMembershipRepository, JsonRoomMembershipRepository, PostgresRoomMembershipRepository } from '../../src/room-membership.js';
import { InMemorySessionEventRepository, JsonSessionEventRepository, PostgresSessionEventRepository, SessionEventService } from '../../src/session-events.js';
import { InMemoryRunRepository } from '../../src/adapters/in-memory-run-repository.js';
import { InMemoryOwnedBotStore, JsonOwnedBotStore } from '../../src/owned-bots.js';
import { AeeisService } from '../../src/application/aeeis-service.js';
import { buildApp } from '../../src/runtime/http.js';
import { AgentEngine } from '../../src/runtime/engine.js';
import { ConversationService } from '../../src/application/conversation-service.js';
import { ThreadService } from '../../src/application/thread-service.js';
import { BotDialogueService } from '../../src/application/bot-dialogue-service.js';

export const dialogueScope = { owner: 'alice', tenantId: 'team-a' };
export const dialogueHeaders = { authorization: 'Bearer alice' };
export async function dialogueFixture(options: { file?: string; url?: string; storage?: BotDialogueStore; replies?: boolean; reply?: () => Promise<unknown>; model?: (request: { system: string; input: any }) => unknown } = {}) {
  const boardControls = options.url ? new PostgresTaskBoardStore(options.url) : options.file ? new FileTaskBoardStore(join(options.file,'board-relations.json')) : new InMemoryTaskBoardStore(); await boardControls.init();
  const storage = options.storage ?? (options.url ? new PostgresBotDialogueStore(options.url) : options.file ? new FileBotDialogueStore(join(options.file, 'dialogues.json')) : new InMemoryBotDialogueStore());
  const aggregates = options.url ? new PostgresConversationStore(options.url) : options.file ? new FileConversationStore(join(options.file, 'conversations')) : new InMemoryConversationStore();
  const domainStore = options.url ? new PostgresAeeisStore(options.url) : options.file ? new JsonFileStore(join(options.file, 'domain.json')) : new InMemoryStore();
  const memberships = options.url ? new PostgresRoomMembershipRepository(options.url) : options.file ? new JsonRoomMembershipRepository(join(options.file, 'members.json')) : new InMemoryRoomMembershipRepository();
  const eventStore = options.url ? new PostgresSessionEventRepository(options.url) : options.file ? new JsonSessionEventRepository(join(options.file, 'events.json')) : new InMemorySessionEventRepository();
  await Promise.all([storage.init(), aggregates.init(), domainStore instanceof PostgresAeeisStore || domainStore instanceof JsonFileStore ? domainStore.init() : undefined, memberships instanceof PostgresRoomMembershipRepository || memberships instanceof JsonRoomMembershipRepository ? memberships.init() : undefined, eventStore instanceof PostgresSessionEventRepository || eventStore instanceof JsonSessionEventRepository ? eventStore.init() : undefined]);
  const bots = options.file ? new JsonOwnedBotStore(join(options.file, 'bots.json')) : new InMemoryOwnedBotStore(); await bots.init();
  const bot = (await bots.list(dialogueScope))[0] ?? await bots.create({ name: '阿研', mark: 'letter', color: '#176b45', background: '研究公开资料', autonomy: options.replies ? 'reply' : 'quiet' }, dialogueScope);
  const domain = new AeeisService(domainStore, [], memberships, undefined, bots);
  const events = new SessionEventService(eventStore, domain);
  const runs = options.file ? new FileRunRepository(join(options.file, 'runs')) : new InMemoryRunRepository();
  if (runs instanceof FileRunRepository) await runs.init();
  const calls: unknown[] = [], notified: string[] = [];
  const engine = new AgentEngine(runs, { pin: { model: 'dialogue-test', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, complete: async request => {
    calls.push(request);
    const scripted = options.model?.(request);
    if (scripted !== undefined) return { value: scripted };
    if (request.system.includes('只讨论，不执行')) return { value: options.reply ? await options.reply() : { reply: '这是服务端的真实回复。' } };
    return { value: { summary: '执行计划', nodes: [{ id: 'work', title: '核对', instruction: '核对公开资料', dependsOn: [] }] } };
  } });
  const app = buildApp({ repository: runs, conversationStore: aggregates, botDialogues: storage, taskBoardControls: boardControls, domain, sessionEvents: events, ownedBots: bots, engine,
    dispatcher: { notify: async id => { notified.push(id); }, close: async () => undefined }, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] }, elsewhere: { id: 'alice', tenantId: 'team-b', roles: ['owner'] }, viewer: { id: 'alice', tenantId: 'team-a', roles: ['agent'] },
    } });
  const conversations = new ConversationService(aggregates, runs, new ThreadService(runs, engine), undefined, undefined, undefined, bots);
  const service = new BotDialogueService(storage, conversations, aggregates, domain, events, bots);
  conversations.writeGate = (id, scope, work) => service.conversationWrite(id, scope, work);
  const request = async (url: string, body?: object, key?: string, identity = 'alice') => app.inject({ method: body === undefined ? 'GET' : 'POST', url: `/api${url}`, headers: { authorization: `Bearer ${identity}`, ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { payload: body } : {}) });
  const ensure = async () => { const result = await request(`/bots/${bot.id}/dialogue`, {}); if (result.statusCode !== 200) throw new Error(result.body); return result.json() as { roomId: string; conversationId: string; revision: number; bindingVersion: number }; };
  const legacy = async (title = '旧私聊', at?: string) => {
    const room = await domain.createRoom({ title, description: '私聊' }, at, dialogueScope.owner, dialogueScope.tenantId);
    await domain.addRoomMember(room.id, bot.id, 'agent', dialogueScope.owner, dialogueScope.tenantId);
    const goal = await domain.createGoal({ title, roomId: room.id }, undefined, dialogueScope.owner, dialogueScope.tenantId);
    const manifest = await domain.createContextManifest(goal.id, { purpose: '历史', audienceMode: 'room' }, undefined, dialogueScope.owner, dialogueScope.tenantId);
    const say = (content: string, type: 'message' | 'canonical_response' = 'message', actor?: { type: 'agent'; id: string }, refs?: string[]) => events.create(room.id, { goalId: goal.id, type, content, contextManifestId: manifest.id, idempotencyKey: randomUUID(), ...(actor ? { actor } : {}), ...(refs ? { evidenceRefs: refs } : {}) }, dialogueScope.owner, dialogueScope.tenantId);
    return { room, goal, manifest, say };
  };
  return { storage, boardControls, aggregates, domainStore, memberships, eventStore, bots, bot, domain, events, runs, engine, calls, notified, app, service, conversations, request, ensure, legacy,
    async close() { await app.aeeisBots?.drain(); await app.close(); await Promise.all([storage.close(), boardControls.close(), aggregates.close(), domainStore.close(), memberships.close(), eventStore.close(), bots.close(), runs.close()]); } };
}
