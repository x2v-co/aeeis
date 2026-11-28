import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryTaskBoardStore } from '../src/adapters/task-board-store.js';
import { InMemoryBotDialogueStore } from '../src/bot-dialogues.js';
import { InMemoryConversationStore } from '../src/adapters/conversation-store.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, SessionEventService } from '../src/session-events.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryOwnedBotStore, decideOwnedBotOpen, OwnedBotNotFound, type OwnedBot } from '../src/owned-bots.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { buildApp } from '../src/runtime/http.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { InMemoryRoutineStore } from '../src/routines.js';
import { InMemoryTenantMemberStore, TenantMembers } from '../src/tenant-members.js';
import { ConversationService } from '../src/application/conversation-service.js';
import { ThreadService } from '../src/application/thread-service.js';
import { InMemoryOpenBotUsageStore, OpenBots, openAccess, openToolChoices, readOnlyTool, requesterRunOptions } from '../src/open-bots.js';
import type { ToolGateway } from '../src/integrations.js';

const OWNER_BACKGROUND = '主人私下写的背景：只给 alice 看 OWNER-BG';
const STANDING = '常驻嘱咐：口令是 PINEAPPLE';
const OWNER_CHAT = 'alice 私下说：OWNER-CHAT-SECRET';
const PUBLIC_BACKGROUND = '给同事看的介绍：会查公开资料。';
const alice = { owner: 'alice', tenantId: 'team-a' };
const bob = { owner: 'bob', tenantId: 'team-a' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

const tools: ToolGateway = {
  listTools: async () => [
    { id: 'web-search', version: '1', capabilities: ['read', 'network'], inputSchema: {}, outputSchema: {} },
    { id: 'web-fetch', version: '1', capabilities: ['read', 'network'], inputSchema: {}, outputSchema: {} },
    { id: 'mail-send', version: '1', capabilities: ['write', 'network'], inputSchema: {}, outputSchema: {} },
    // A remote tool that declared nothing is listed as `execute`: never read-only.
    { id: 'lookup-x', version: '1', capabilities: ['execute'], inputSchema: {}, outputSchema: {} },
    // A local tool on the Bot computer.
    { id: 'shell', version: '3', capabilities: ['execute', 'read', 'write'], inputSchema: {}, outputSchema: {} },
  ],
  invoke: async () => { throw new Error('not in this test'); },
};

async function fixture() {
  const bots = new InMemoryOwnedBotStore();
  const memberships = new InMemoryRoomMembershipRepository();
  const domain = new AeeisService(new InMemoryStore(), [], memberships, undefined, bots);
  const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
  const aggregates = new InMemoryConversationStore(); await aggregates.init();
  const runs = new InMemoryRunRepository();
  const usage = new InMemoryOpenBotUsageStore();
  const calls: Array<{ system: string; input: any }> = [];
  const engine = new AgentEngine(runs, { tools, model: { pin: { model: 'open-bot-test', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, complete: async request => {
    calls.push({ system: request.system, input: request.input });
    if (request.system.includes('只讨论，不执行')) return { value: { reply: '可以先查公开资料。' }, usage: { inputTokens: 30, outputTokens: 12 } };
    return { value: { summary: '执行计划', nodes: [{ id: 'work', title: '核对', instruction: '核对公开资料', dependsOn: [] }] } };
  } } });
  const tenantMembers = new TenantMembers(new InMemoryTenantMemberStore(), [
    { email: 'alice@a.test', principalId: 'alice', tenantId: 'team-a' }, { email: 'bob@a.test', principalId: 'bob', tenantId: 'team-a' },
    { email: 'carol@a.test', principalId: 'carol', tenantId: 'team-a' }, { email: 'dan@b.test', principalId: 'dan', tenantId: 'team-b' },
  ]);
  const app = buildApp({ repository: runs, conversationStore: aggregates, botDialogues: new InMemoryBotDialogueStore(), taskBoardControls: new InMemoryTaskBoardStore(), domain, sessionEvents: events, ownedBots: bots, engine, tools,
    machineTools: ['shell'], openBotUsage: usage, tenantMembers, routines: new InMemoryRoutineStore(),
    dispatcher: { notify: async () => undefined, close: async () => undefined }, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] }, carol: { id: 'carol', tenantId: 'team-a', roles: ['owner'] },
      dan: { id: 'dan', tenantId: 'team-b', roles: ['owner'] }, bobElsewhere: { id: 'bob', tenantId: 'team-b', roles: ['owner'] },
    } });
  cleanup.push(async () => { await app.aeeisBots?.drain(); await app.close(); });
  const call = async (who: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: object, key?: string) =>
    app.inject({ method, url: `/api${url}`, headers: { authorization: `Bearer ${who}`, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
  // Alice's Bot, with things only she should ever see: her background, her standing instruction, her chat.
  const bot = (await call('alice', 'POST', '/bots', { name: '阿研', role: '研究', mark: 'letter', color: '#176b45', background: OWNER_BACKGROUND, autonomy: 'yolo' })).json() as OwnedBot;
  const own = (await call('alice', 'POST', `/bots/${bot.id}/dialogue`, {})).json() as { conversationId: string; roomId: string };
  let view = (await call('alice', 'GET', `/conversations/${own.conversationId}`)).json();
  view = (await call('alice', 'POST', `/conversations/${own.conversationId}/standing`, { expectedRevision: view.revision, text: STANDING })).json();
  expect((await call('alice', 'POST', `/rooms/${own.roomId}/dialogue/messages`, { text: OWNER_CHAT, expectedRevision: view.revision, unassigned: true, intent: 'discuss' }, 'alice-1')).statusCode).toBe(200);
  await app.aeeisBots?.drain();
  calls.length = 0;
  const open = (who: string, body: object) => call(who, 'PUT', `/bots/${bot.id}/open`, body);
  /** Someone opens their chat with the Bot and says something; returns the chat as they see it. */
  const chat = async (who: string) => {
    const response = await call(who, 'POST', `/bots/${bot.id}/dialogue`, {});
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { conversationId: string; roomId: string };
  };
  let n = 0;
  const say = async (who: string, binding: { conversationId: string; roomId: string }, body: object) => {
    const current = (await call(who, 'GET', `/conversations/${binding.conversationId}`)).json();
    const response = await call(who, 'POST', `/rooms/${binding.roomId}/dialogue/messages`, { expectedRevision: current.revision, ...body }, `${who}-say-${++n}`);
    await app.aeeisBots?.drain();
    return response;
  };
  return { app, bots, aggregates, runs, usage, calls, engine, bot, own, call, open, chat, say };
}
const secrets = (value: unknown) => {
  const text = JSON.stringify(value);
  return [OWNER_BACKGROUND, STANDING, 'PINEAPPLE', OWNER_CHAT, 'OWNER-CHAT-SECRET', 'OWNER-BG'].filter(secret => text.includes(secret));
};

describe('open settings (others-talk-to-your-bot §3, stage 3c)', () => {
  it('is closed by default: nobody else sees, picks or reaches the Bot', async () => {
    const f = await fixture();
    expect((await f.call('bob', 'GET', '/open-bots')).json()).toEqual({ items: [] });
    expect((await f.call('bob', 'POST', `/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(404);
    expect((await f.call('bob', 'POST', `/bots/${f.bot.id}/dialogue`, {})).json().error).toBe('Unknown Bot');
    // Nor through a plain conversation, which would otherwise reach routines and channels.
    expect((await f.call('bob', 'POST', '/conversations', { title: '阿研', agentId: f.bot.id })).statusCode).toBe(404);
    expect((await f.call('alice', 'GET', '/bots')).json()[0]).not.toHaveProperty('open');
  });

  it('opens read-only tools by default, asks again for writing ones and never opens a Bot computer', async () => {
    const f = await fixture();
    const choices = (await f.call('alice', 'GET', `/bots/${f.bot.id}/open`)).json();
    expect(choices).not.toHaveProperty('open');
    expect(choices.defaultRunLimit).toBe(50);
    expect(choices.toolChoices.map((tool: any) => [tool.id, tool.readOnly, tool.write])).toEqual([['web-search', true, false], ['web-fetch', true, false], ['mail-send', false, true], ['lookup-x', false, false]]);
    expect((await f.open('alice', { tools: ['mail-send'] })).statusCode).toBe(409);
    expect((await f.open('alice', { tools: ['shell'] })).json().error).toContain('Bot 电脑');
    expect((await f.open('alice', { tools: ['web-search', 'mail-send'], confirmWrite: true })).statusCode).toBe(200);
    const saved = await f.open('alice', { tools: ['web-search@1', 'web-search'] });
    expect(saved.json().open).toMatchObject({ audience: { kind: 'tenant' }, tools: ['web-search'], monthlyRunLimit: 50 });
    // Editing the Bot keeps its open settings.
    const patched = await f.call('alice', 'PATCH', `/bots/${f.bot.id}`, { name: '阿研', role: '研究', mark: 'letter', color: '#176b45', background: OWNER_BACKGROUND, autonomy: 'yolo' });
    expect(patched.json().open.tools).toEqual(['web-search']);
  });

  it('is the owner\'s alone to change, and the audience is people of the same tenant', async () => {
    const f = await fixture();
    expect((await f.open('bob', { tools: [] })).statusCode).toBe(404);
    expect((await f.call('bob', 'DELETE', `/bots/${f.bot.id}/open`)).statusCode).toBe(404);
    expect((await f.call('bob', 'GET', `/bots/${f.bot.id}/open/usage`)).statusCode).toBe(404);
    expect((await f.open('alice', { audience: { kind: 'people', people: ['dan'] }, tools: [] })).json().error).toContain('dan');
    expect(() => decideOwnedBotOpen([f.bot], f.bot.id, { audience: { kind: 'tenant' }, tools: [], monthlyRunLimit: 5 }, { owner: 'alice', tenantId: 'team-b' }, new Date().toISOString())).toThrow(OwnedBotNotFound);
    expect((await f.open('alice', { audience: { kind: 'people', people: ['carol'] }, tools: [] })).statusCode).toBe(200);
    expect((await f.call('bob', 'GET', '/open-bots')).json().items).toEqual([]);
    expect((await f.call('carol', 'GET', '/open-bots')).json().items.map((item: any) => item.id)).toEqual([f.bot.id]);
    expect((await f.call('bob', 'POST', `/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(404);
  });

  it('never crosses tenants, even for the same person id', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'] });
    expect((await f.call('dan', 'GET', '/open-bots')).json().items).toEqual([]);
    expect((await f.call('bobElsewhere', 'GET', '/open-bots')).json().items).toEqual([]);
    expect((await f.call('bobElsewhere', 'POST', `/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(404);
    expect(openAccess(f.bot && { ...(await f.bots.get(f.bot.id))! }, { owner: 'bob', tenantId: 'team-b' })).toBeUndefined();
    expect(openAccess(await f.bots.get(f.bot.id), { owner: 'alice', tenantId: 'team-a' })).toBeUndefined();
  });

  it('shows others the public profile only', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'], publicBackground: PUBLIC_BACKGROUND, monthlyRunLimit: 7 });
    const items = (await f.call('bob', 'GET', '/open-bots')).json().items;
    expect(items).toEqual([{ id: f.bot.id, name: '阿研', mark: 'letter', color: '#176b45', role: '研究', background: PUBLIC_BACKGROUND, owner: 'alice', ownerName: 'alice', tools: ['web-search'], monthlyRunLimit: 7 }]);
    expect(secrets(items)).toEqual([]);
  });
});

describe('someone else\'s chat with an opened Bot (§4, §5)', () => {
  it('lives in the requester\'s scope: the owner cannot read it', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'], publicBackground: PUBLIC_BACKGROUND });
    const binding = await f.chat('bob');
    expect((await f.say('bob', binding, { text: 'bob 的私事：BOB-PRIVATE', unassigned: true, intent: 'discuss' })).statusCode).toBe(200);
    const stored = await f.aggregates.get(binding.conversationId, bob);
    expect(stored).toMatchObject({ owner: 'bob', tenantId: 'team-a', agentId: f.bot.id, botOwner: 'alice' });
    expect(stored).not.toHaveProperty('standingInstruction');
    // Nothing of it in the owner's scope, and the owner's API refuses it.
    expect((await f.aggregates.list(alice)).map(item => item.id)).not.toContain(binding.conversationId);
    expect(JSON.stringify(await f.aggregates.list(alice))).not.toContain('BOB-PRIVATE');
    expect((await f.call('alice', 'GET', `/conversations/${binding.conversationId}`)).statusCode).toBe(404);
    expect((await f.call('alice', 'GET', `/rooms/${binding.roomId}/dialogue`)).statusCode).toBe(404);
    const view = (await f.call('bob', 'GET', `/conversations/${binding.conversationId}`)).json();
    expect(view.borrowed).toEqual({ owner: 'alice', ownerName: 'alice', state: 'open' });
    expect((await f.call('bob', 'GET', '/conversations')).json().find((item: any) => item.id === binding.conversationId)).toMatchObject({ botOwner: 'alice' });
    // The requester gets no standing instruction of their own for someone else's Bot either.
    expect((await f.call('bob', 'POST', `/conversations/${binding.conversationId}/standing`, { expectedRevision: view.revision, text: '试试' })).statusCode).toBe(409);
  });

  it('never puts the owner\'s background, standing instruction or chat in the model input', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'], publicBackground: PUBLIC_BACKGROUND });
    const binding = await f.chat('bob');
    await f.say('bob', binding, { text: '你能帮我查什么？', unassigned: true, intent: 'discuss' });
    const reply = f.calls.find(call => call.system.includes('只讨论，不执行'))!;
    expect(reply.input.bot).toEqual({ name: '阿研', role: '研究', background: PUBLIC_BACKGROUND });
    expect(reply.input).not.toHaveProperty('team');
    expect(reply.input).not.toHaveProperty('standingInstruction');
    expect(secrets(reply.input)).toEqual([]);
    // A Run's materials and goal carry the same public profile and nothing of the owner's.
    expect((await f.say('bob', binding, { text: '查一下公开资料', newTask: { title: '查公开资料' }, intent: 'execute', runOptions: { allowedTools: ['web-search@1'] } })).statusCode).toBe(202);
    const stored = await f.aggregates.get(binding.conversationId, bob);
    const request = stored.messages.find(message => message.execution)!.execution!.request;
    expect(secrets(request)).toEqual([]);
    expect(request.materials.find(item => item.source === `owned-bot:${f.bot.id}/profile`)!.content).toBe(JSON.stringify({ name: '阿研', role: '研究', background: PUBLIC_BACKGROUND }));
    expect(request.materials.some(item => item.source.endsWith('/standing'))).toBe(false);
    expect(request).not.toHaveProperty('brainScope');
    expect(secrets(f.calls.map(call => call.input))).toEqual([]);
    // Without a separate public background, others see the original one: that is the owner's choice (§11.1).
    await f.open('alice', { tools: ['web-search'] });
    await f.say('bob', binding, { text: '再说一次', unassigned: true, intent: 'discuss' });
    expect(f.calls.filter(call => call.system.includes('只讨论，不执行')).at(-1)!.input.bot.background).toBe(OWNER_BACKGROUND);
  });

  it('runs on the requester\'s scope with tools = chosen ∩ opened, and review capped at reply', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search', 'mail-send'], confirmWrite: true });
    const binding = await f.chat('bob');
    const sent = await f.say('bob', binding, { text: '查一下', newTask: { title: '查资料' }, intent: 'execute', runOptions: { allowedTools: ['web-search@1', 'web-fetch@1', 'shell@3', 'lookup-x@1'], executionReview: 'yolo', brainScope: 'owner-brain', memoryQuery: 'alice', allowedAgents: ['agent_x'] } });
    expect(sent.statusCode, sent.body).toBe(202);
    const runId = sent.json().runId as string;
    const run = await f.runs.get(runId, bob);
    expect(run.allowedTools).toEqual(['web-search@1']);
    expect(run.executionReview).toBe('required');
    expect(run.allowedAgents).toEqual([]);
    expect(run).not.toHaveProperty('brainScope');
    await expect(f.runs.get(runId, alice)).rejects.toThrow();
    // The owner's yolo does not carry over even when the requester leaves review out.
    const again = await f.say('bob', binding, { text: '再查一件', newTask: { title: '查第二件' }, intent: 'execute', runOptions: { allowedTools: ['mail-send@1'] } });
    const second = await f.runs.get(again.json().runId, bob);
    expect(second.allowedTools).toEqual(['mail-send@1']);
    expect(second.executionReview).toBe('required');
    expect(sent.json().response).toContain('计划会先等你批准');
  });

  it('cannot hand tasks to other Bots, nor be reached from routines', async () => {
    const f = await fixture();
    await f.open('alice', { tools: [] });
    const binding = await f.chat('bob');
    await f.say('bob', binding, { text: '整理一下', newTask: { title: '整理' }, intent: 'discuss' });
    const view = (await f.call('bob', 'GET', `/conversations/${binding.conversationId}`)).json();
    const handoff = await f.call('bob', 'POST', `/conversations/${binding.conversationId}/tasks/${view.tasks[0].id}/hand-off`, { expectedRevision: view.revision, to: 'aeeis' });
    expect(handoff.statusCode).toBe(409);
    for (const trigger of [{ kind: 'manual' }, { kind: 'webhook' }]) {
      const routine = await f.call('bob', 'POST', '/routines', { agentId: f.bot.id, name: '借来的例程', prompt: '每天查一下', trigger });
      expect(routine.statusCode).toBe(404);
    }
    expect((await f.call('bob', 'GET', '/routines')).json().routines).toEqual([]);
    expect((await f.runs.list(bob))).toEqual([]);
    // Behind the routes too: a routine, webhook, channel or Bot proposal reaches a chat only through its life thread, which refuses.
    const service = new ConversationService(f.aggregates, f.runs, new ThreadService(f.runs, f.engine), undefined, undefined, undefined, f.bots);
    service.openBots = new OpenBots(f.bots, f.usage);
    const refusal = '别人开放给你的 Bot 只能在和它的单独对话里用';
    await expect(service.startRoutine({ agentId: f.bot.id, text: '查', taskTitle: '查', runOptions: {}, key: 'routine-key-1', source: { kind: 'routine', routineId: 'routine_x', deliveryId: 'd1', trigger: 'webhook' } }, bob, true)).rejects.toThrow(refusal);
    await expect(service.proposeTask({ agentId: f.bot.id, proposerId: f.bot.id, title: '提议', key: 'propose-key-1' }, bob)).rejects.toThrow(refusal);
    await expect(service.receive({ owner: 'bob', tenantId: 'team-a', agentId: f.bot.id, channel: 'feishu', chatId: 'c', externalEventId: 'e1', text: '你好', receivedAt: new Date().toISOString() } as never)).rejects.toThrow(refusal);
    // And someone the Bot was never opened to cannot even make one.
    await expect(service.startRoutine({ agentId: f.bot.id, text: '查', taskTitle: '查', runOptions: {}, key: 'routine-key-2', source: { kind: 'routine', routineId: 'routine_y', deliveryId: 'd2', trigger: 'schedule' } }, { owner: 'carol', tenantId: 'team-a' }, true)).rejects.toThrow('Unknown Bot');
  });

  it('counts Runs per person per month, stops new Runs at the limit and keeps talking', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'], monthlyRunLimit: 1 });
    const binding = await f.chat('bob');
    expect((await f.say('bob', binding, { text: '第一件', newTask: { title: '第一件' }, intent: 'execute', runOptions: { allowedTools: ['web-search@1'] } })).statusCode).toBe(202);
    const refused = await f.say('bob', binding, { text: '第二件', newTask: { title: '第二件' }, intent: 'execute', runOptions: { allowedTools: ['web-search@1'] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('1 个 Run');
    expect(await f.runs.list(bob)).toHaveLength(1);
    expect((await f.say('bob', binding, { text: '那先聊聊', unassigned: true, intent: 'discuss' })).statusCode).toBe(200);
    // Carol has her own month.
    const carol = await f.chat('carol');
    expect((await f.say('carol', carol, { text: '我的第一件', newTask: { title: '我的' }, intent: 'execute', runOptions: {} })).statusCode).toBe(202);
    // The owner sees counts and tokens per person, no content and nothing to open.
    const usage = (await f.call('alice', 'GET', `/bots/${f.bot.id}/open/usage`)).json();
    expect(usage.items).toEqual(expect.arrayContaining([
      { requester: 'bob', name: 'bob@a.test', lastAt: expect.any(String), runs: 1, tokens: 42 },
      { requester: 'carol', name: 'carol@a.test', lastAt: expect.any(String), runs: 1, tokens: 0 },
    ]));
    expect(JSON.stringify(usage)).not.toMatch(/第一件|那先聊聊|可以先查/);
    // Raising the limit lets the next Run through.
    await f.open('alice', { tools: ['web-search'], monthlyRunLimit: 2 });
    expect((await f.say('bob', binding, { text: '第二件', newTask: { title: '第二件' }, intent: 'execute', runOptions: {} })).statusCode).toBe(202);
  });

  it('becomes read-only when the owner closes it again, keeps the history, and reopens', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'] });
    const binding = await f.chat('bob');
    const started = await f.say('bob', binding, { text: '查一下', newTask: { title: '查资料' }, intent: 'execute', runOptions: {} });
    expect(started.statusCode).toBe(202);
    const calls = f.calls.length;
    expect((await f.call('alice', 'DELETE', `/bots/${f.bot.id}/open`)).json()).not.toHaveProperty('open');
    expect((await f.call('bob', 'GET', '/open-bots')).json().items).toEqual([]);
    const refused = await f.say('bob', binding, { text: '还在吗', unassigned: true, intent: 'discuss' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('只能阅读');
    expect(f.calls.length).toBe(calls);
    const view = (await f.call('bob', 'GET', `/conversations/${binding.conversationId}`)).json();
    expect(view.borrowed.state).toBe('closed');
    expect(view.messages.some((message: any) => message.text === '查一下')).toBe(true);
    // The Run already going is left alone.
    expect((await f.runs.get(started.json().runId, bob)).status).not.toBe('cancelled');
    // It still opens, to read.
    const reopened = await f.call('bob', 'POST', `/bots/${f.bot.id}/dialogue`, {});
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().conversationId).toBe(binding.conversationId);
    // Someone who never had a chat with it gets nothing.
    expect((await f.call('carol', 'POST', `/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(404);
    await f.open('alice', { tools: ['web-search'] });
    expect((await f.say('bob', binding, { text: '又开了', unassigned: true, intent: 'discuss' })).statusCode).toBe(200);
    // Retiring the Bot also leaves the chat readable.
    expect((await f.call('alice', 'DELETE', `/bots/${f.bot.id}`)).statusCode).toBe(200);
    expect((await f.call('bob', 'GET', `/conversations/${binding.conversationId}`)).json().borrowed.state).toBe('retired');
    expect((await f.say('bob', binding, { text: '撤下了吗', unassigned: true, intent: 'discuss' })).statusCode).toBe(409);
  });

  it('leaves the owner\'s own chat exactly as before', async () => {
    const f = await fixture();
    await f.open('alice', { tools: ['web-search'], publicBackground: PUBLIC_BACKGROUND });
    const sent = await f.say('alice', f.own, { text: '我自己的任务', newTask: { title: '自己的' }, intent: 'execute', runOptions: { allowedTools: ['web-fetch@1'], executionReview: 'yolo' } });
    expect(sent.statusCode, sent.body).toBe(202);
    const run = await f.runs.get(sent.json().runId, alice);
    expect(run.allowedTools).toEqual(['web-fetch@1']);
    expect(run.executionReview).toBe('yolo');
    const request = (await f.aggregates.get(f.own.conversationId, alice)).messages.find(message => message.execution)!.execution!.request;
    expect(request.materials.find(item => item.source.endsWith('/standing'))?.content).toBe(STANDING);
    expect(request.materials.find(item => item.source.endsWith('/profile'))?.content).toContain(OWNER_BACKGROUND);
    expect((await f.call('alice', 'GET', `/bots/${f.bot.id}/open/usage`)).json().items).toEqual([]);
  });
});

describe('the rules, one by one', () => {
  it('calls a tool read-only only when its manifest says only read (and network)', () => {
    expect(readOnlyTool(['read'])).toBe(true);
    expect(readOnlyTool(['read', 'network'])).toBe(true);
    expect(readOnlyTool(['network'])).toBe(false);
    expect(readOnlyTool([])).toBe(false);
    expect(readOnlyTool(['execute'])).toBe(false);
    expect(readOnlyTool(['read', 'write'])).toBe(false);
    expect(openToolChoices([{ id: 'read', version: '3', capabilities: ['read'] }, { id: 'web-fetch', version: '1', capabilities: ['read', 'network'] }], new Set(['read'])).map(tool => tool.id)).toEqual(['web-fetch']);
  });

  it('keeps only what a borrowed Run may use', () => {
    const open = { audience: { kind: 'tenant' as const }, tools: ['web-search', 'shell'], monthlyRunLimit: 50, updatedAt: new Date().toISOString() };
    const options = requesterRunOptions({ allowedTools: ['web-search@1', 'web-search@2', 'shell@3', 'mail-send@1'], executionReview: 'auto', workGrantId: 'wg_x', brainScope: 'b', brainQuery: 'q', memoryQuery: 'm', knowledgeQuery: 'k', projectSourceQuery: 'p', allowedAgents: ['a'], builtinSkill: 'website-builder/1', publish: { repo: 'sandbox' }, resources: {}, actionPolicy: {}, origin: 'agent', skillRuntime: 's', maxModelCalls: 9, privacy: 'private', acceptance: ['有表格'] }, open, new Set(['shell']));
    expect(options).toEqual({ allowedTools: ['web-search@1', 'web-search@2'], executionReview: 'required', maxModelCalls: 9, privacy: 'private', acceptance: ['有表格'] });
    expect(requesterRunOptions(undefined, open, new Set())).toEqual({ allowedTools: [], executionReview: 'required' });
  });
});
