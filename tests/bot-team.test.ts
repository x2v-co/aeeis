import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryConversationStore } from '../src/adapters/conversation-store.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, SessionEventService } from '../src/session-events.js';
import { InMemoryOwnedBotStore } from '../src/owned-bots.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelRequest } from '../src/runtime/model.js';

const headers = { authorization: 'Bearer alice' };
const scope = { owner: 'alice', tenantId: 'team-a' };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); delete process.env.AEEIS_BOT_HANDOFF_MAX_TURNS; vi.restoreAllMocks(); });

type Script = {
  reply?: (input: any) => unknown;
  turn?: (input: any) => unknown;
  plan?: () => unknown;
};

async function team(script: Script, options: { quiet?: boolean; writerAutonomy?: string } = {}) {
  const bots = new InMemoryOwnedBotStore();
  const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository(), undefined, bots);
  const conversations = new InMemoryConversationStore();
  const sessionEvents = new SessionEventService(new InMemorySessionEventRepository(), domain);
  const repository = new InMemoryRunRepository();
  const calls: ModelRequest[] = [];
  const model = { pin: { model: 'team-fixture', endpoint: 'http://localhost', promptVersion: 'team/1' }, complete: vi.fn(async (request: ModelRequest) => {
    calls.push(request);
    if (request.system.includes('在团队群聊（或私聊）里回复一条消息')) return { value: script.reply?.(request.input) ?? { reply: '收到。' }, usage: { inputTokens: 10, outputTokens: 5 } };
    if (request.system.includes('在你们的侧线程里谈一件任务的交接')) return { value: script.turn?.(request.input) ?? { decision: 'accept', message: '我来。' }, usage: { inputTokens: 10, outputTokens: 5 } };
    if (request.system.includes('Plan a real deliverable')) {
      const plan = script.plan?.();
      if (plan instanceof Error) throw plan;
      return { value: plan ?? { summary: 'Work', nodes: [{ id: 'work', title: 'Work', instruction: 'Do it', dependsOn: [] }] } };
    }
    throw new Error(`unexpected model call: ${request.system.slice(0, 40)}`);
  }) };
  const engine = new AgentEngine(repository, model);
  const notify = vi.fn(async () => undefined);
  const app = buildApp({ repository, engine, dispatcher: { notify, close: async () => undefined }, domain, ownedBots: bots, conversationStore: conversations, sessionEvents, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
  cleanup.push(() => app.close());
  const bot = async (name: string, role: string, autonomy?: string) => (await app.inject({ method: 'POST', url: '/api/bots', headers, payload: { name, role, mark: 'letter', color: '#176b45', background: `${name}负责${role}。`, ...(autonomy ? { autonomy } : {}) } })).json() as { id: string; name: string };
  const researcher = await bot('阿研', '研究', options.quiet ? 'quiet' : undefined);
  const writer = await bot('阿写', '写作', options.writerAutonomy);
  const roomId = (await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { title: '发布协作', description: '群聊' } })).json().id as string;
  for (const member of [researcher, writer]) expect((await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/members`, headers, payload: { principalId: member.id, role: 'agent' } })).statusCode).toBe(200);
  const goalId = (await app.inject({ method: 'POST', url: '/api/goals', headers, payload: { title: '发布协作', roomId } })).json().id as string;
  const manifestId = async () => (await app.inject({ method: 'POST', url: `/api/goals/${goalId}/context-manifests`, headers, payload: { purpose: '群聊消息', audienceMode: 'room' } })).json().id as string;
  let n = 0;
  const say = async (content: string, actor?: { type: 'agent'; id: string }) => {
    const response = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/session-events`, headers, payload: { goalId, type: 'message', content, contextManifestId: await manifestId(), idempotencyKey: `say-${++n}`, ...(actor ? { actor } : {}) } });
    expect(response.statusCode, response.body).toBe(200);
    await app.aeeisBots!.drain();
    return response.json() as { id: string };
  };
  const events = async () => (await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/session-events?limit=200`, headers })).json().items as Array<{ id: string; type: string; actorId: string; actorType: string; content: string; evidenceRefs: string[]; idempotencyKey: string; taskAction?: { kind: string } }>;
  const board = async () => (await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/board`, headers })).json() as { cards: Array<{ conversationId: string; taskId: string; title?: string; status: string; ownerId: string; decision: { assigneeId?: string; proposedBy?: string; offer?: { to: string }; blockedNote?: string } }> };
  const room = () => domain.getRoomForPrincipal(roomId, 'alice', 'team-a');
  return { app, domain, conversations, repository, engine, notify, calls, researcher, writer, roomId, goalId, manifestId, say, events, board, room };
}

describe('Bots that act on their own', () => {
  it('answers with one voice: AEEIS for an undirected line, the named member otherwise, never a Bot', async () => {
    const f = await team({ reply: input => ({ reply: `${input.you.name}收到：${input.message.text}` }) });
    const first = await f.say('今天先把发布说明理一下');
    let items = await f.events();
    const replies = items.filter(item => item.type === 'message' && item.actorType === 'agent');
    expect(replies).toEqual([expect.objectContaining({ actorId: 'aeeis', content: 'AEEIS收到：今天先把发布说明理一下', evidenceRefs: [first.id], idempotencyKey: `bot-reply:${first.id}:aeeis` })]);
    const named = await f.say(`@阿研 风险点有哪些？`);
    items = await f.events();
    const forNamed = items.filter(item => item.actorType === 'agent' && item.evidenceRefs.includes(named.id));
    expect(forNamed.map(item => item.actorId)).toEqual([f.researcher.id]);
    // A Bot's line (written by the owner for the Bot) starts no reply chain.
    const before = (await f.events()).length;
    await f.say('我补一句：数据在表里', { type: 'agent', id: f.writer.id });
    expect((await f.events()).length).toBe(before + 1);
    // Replays and the restart sweep do not answer twice or call the model again.
    const callsBefore = f.calls.length;
    await f.app.aeeisBots!.sweep(await f.room(), scope);
    await f.app.aeeisBots!.drain();
    expect((await f.events()).length).toBe(before + 1);
    expect(f.calls.length).toBe(callsBefore);
    // The transcript reaches the model as untrusted data, with the speakers' names.
    const last = f.calls.filter(call => call.system.includes('回复一条消息')).at(-1)!.input as any;
    expect(last.transcript_untrusted.at(-1)).toEqual({ speaker: '主人', text: '@阿研 风险点有哪些？' });
    expect(last.you).toMatchObject({ name: '阿研', role: '研究', frontDoor: false });
  });

  it('keeps a quiet Bot silent and writes a failure note instead of retrying a bad reply', async () => {
    const f = await team({ reply: input => input.you.name === 'AEEIS' ? { nope: true } : { reply: 'x' } }, { quiet: true });
    const named = await f.say('@阿研 在吗');
    expect((await f.events()).filter(item => item.evidenceRefs.includes(named.id) && item.actorType === 'agent')).toEqual([]);
    const plain = await f.say('大家好');
    const notes = (await f.events()).filter(item => item.evidenceRefs.includes(plain.id));
    expect(notes).toEqual([expect.objectContaining({ type: 'system', content: 'AEEIS这次没有回复：回复格式不对', idempotencyKey: `bot-fail:${plain.id}:aeeis` })]);
    await f.app.aeeisBots!.sweep(await f.room(), scope);
    await f.app.aeeisBots!.drain();
    expect((await f.events()).filter(item => item.evidenceRefs.includes(plain.id))).toHaveLength(1);
  });

  it('puts a proposal on the board, and an automatic Bot starts it as an agent-origin Run', async () => {
    const f = await team({ reply: input => input.you.name === 'AEEIS' ? { reply: '我请阿写起草。', proposeTask: { title: '起草发布说明', reason: '下周发布', for: '阿写' } } : { reply: '好' } }, { writerAutonomy: 'auto' });
    await f.say('下周发布，需要一份发布说明');
    const card = (await f.board()).cards.find(item => item.title === '起草发布说明');
    expect(card).toMatchObject({ ownerId: f.writer.id, decision: { proposedBy: 'aeeis' } });
    const life = (await f.conversations.list(scope)).find(item => item.agentId === f.writer.id)!;
    expect(life.tasks.map(task => task.title)).toEqual(['起草发布说明']);
    const runs = await f.repository.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ origin: 'agent', executionReview: 'auto' });
    expect(f.notify).toHaveBeenCalledWith(runs[0]!.id);
    expect((await f.events()).some(item => item.taskAction?.kind === 'propose')).toBe(true);
  });

  it('hands work over in the side thread: the card moves only when the other Bot accepts', async () => {
    const turns = [{ decision: 'discuss', message: '需要多久交？' }, { decision: 'discuss', message: '今天下班前。' }, { decision: 'accept', message: '好，我来。' }];
    let turn = 0;
    const f = await team({
      reply: input => input.you.name === '阿研' ? { reply: '这件阿写更合适。', proposeTask: { title: '写风险摘要', reason: '发布前要' }, handoff: { to: '阿写', note: '你写得快' } } : { reply: '好' },
      turn: () => turns[turn++],
    });
    await f.say('@阿研 发布前要一份风险摘要');
    const card = (await f.board()).cards.find(item => item.title === '写风险摘要')!;
    expect(card.decision).toMatchObject({ assigneeId: f.writer.id });
    expect(card.decision.offer).toBeUndefined();
    // The holder is the one who accepted; the task still lives on the proposer's thread.
    expect(card).toMatchObject({ ownerId: f.writer.id, movedFrom: f.researcher.id });
    const holdings = await f.app.inject({ method: 'GET', url: '/api/board-holdings', headers });
    expect(holdings.json().items).toEqual([expect.objectContaining({ taskId: card.taskId, holderId: f.writer.id, fromId: f.researcher.id, title: '写风险摘要' })]);
    const sides = (await f.domain.listRooms('alice', 'team-a')).filter(room => room.description === '侧线程');
    expect(sides).toHaveLength(1);
    const side = await f.app.inject({ method: 'GET', url: `/api/rooms/${sides[0]!.id}/session-events?limit=50`, headers });
    expect((side.json().items as Array<{ actorId: string; content: string }>).map(item => [item.actorId, item.content])).toEqual([
      [f.writer.id, '需要多久交？'], [f.researcher.id, '今天下班前。'], [f.writer.id, '好，我来。'],
    ]);
    const items = await f.events();
    expect(items.map(item => item.taskAction?.kind).filter(Boolean)).toEqual(['propose', 'offer', 'transfer']);
    expect(items.some(item => item.content === '阿写接下了「写风险摘要」（来自阿研）。')).toBe(true);
    // The side thread is not a chat on the group: it never triggers replies of its own.
    expect(f.calls.filter(call => call.system.includes('回复一条消息'))).toHaveLength(1);
  });

  it('leaves the card in place when the other Bot declines, and asks a person when they cannot agree', async () => {
    process.env.AEEIS_BOT_HANDOFF_MAX_TURNS = '4';
    let mode: 'decline' | 'stall' = 'decline';
    const f = await team({
      reply: () => ({ reply: '交给阿写。', proposeTask: { title: `整理数据 ${mode}` }, handoff: { to: '阿写' } }),
      turn: input => mode === 'decline' && input.you.side === 'receiver' ? { decision: 'decline', message: '我手上满了。' } : { decision: 'discuss', message: '再想想。' },
    });
    await f.say('@阿研 整理一下数据');
    let card = (await f.board()).cards.find(item => item.title === '整理数据 decline')!;
    expect(card.decision.assigneeId).toBeUndefined();
    expect(card.ownerId).toBe(f.researcher.id);
    expect(card.decision.offer).toBeUndefined();
    expect((await f.events()).some(item => item.content.includes('没有交给阿写。阿写没有接：我手上满了。'))).toBe(true);
    mode = 'stall';
    await f.say('@阿研 再整理一次');
    card = (await f.board()).cards.find(item => item.title === '整理数据 stall')!;
    expect(card.decision.offer).toBeUndefined();
    expect(card.decision.blockedNote).toContain('交接谈不拢：谈了 4 轮还没有结论');
    expect(card.decision.blockedNote).toContain('需要你决定');
    // The block waits for a person outside the channel too: the roster and inbox read it here.
    const holdings = (await f.app.inject({ method: 'GET', url: '/api/board-holdings', headers })).json().items as Array<Record<string, string>>;
    expect(holdings).toEqual([expect.objectContaining({ taskId: card.taskId, holderId: f.researcher.id, fromId: f.researcher.id, roomId: f.roomId, blocked: card.decision.blockedNote })]);
    expect(holdings[0]!.blockedAt).toEqual(expect.any(String));
  });

  it('starts the talk when a person hands a card over, and refuses a second offer meanwhile', async () => {
    const f = await team({ reply: () => ({ reply: '我先做。', proposeTask: { title: '查竞品' } }), turn: () => ({ decision: 'accept', message: '可以。' }) });
    await f.say('@阿研 查一下竞品');
    const card = (await f.board()).cards.find(item => item.title === '查竞品')!;
    const offer = await f.app.inject({ method: 'POST', url: `/api/rooms/${f.roomId}/task-actions`, headers, payload: { kind: 'offer', conversationId: card.conversationId, taskId: card.taskId, agentId: f.writer.id, goalId: f.goalId, contextManifestId: await f.manifestId(), idempotencyKey: 'offer-1' } });
    expect(offer.statusCode, offer.body).toBe(200);
    const again = await f.app.inject({ method: 'POST', url: `/api/rooms/${f.roomId}/task-actions`, headers, payload: { kind: 'offer', conversationId: card.conversationId, taskId: card.taskId, agentId: f.writer.id, goalId: f.goalId, contextManifestId: await f.manifestId(), idempotencyKey: 'offer-2' } });
    expect(again.statusCode).toBe(409);
    await f.app.aeeisBots!.drain();
    expect((await f.board()).cards.find(item => item.title === '查竞品')!.decision.assigneeId).toBe(f.writer.id);
  });

  it('hands a task that failed twice to the least busy member, once', async () => {
    const f = await team({
      reply: () => ({ reply: '我来。', proposeTask: { title: '跑数据' } }),
      turn: () => ({ decision: 'accept', message: '交给我。' }),
      plan: () => new Error('planner down'),
    }, { writerAutonomy: 'auto' });
    await f.say('@阿研 跑一下数据');
    const card = (await f.board()).cards.find(item => item.title === '跑数据')!;
    // Two Runs on the task, both failing.
    for (const key of ['fail-1', 'fail-2']) {
      const started = await f.app.inject({ method: 'POST', url: `/api/conversations/${card.conversationId}/messages`, headers: { ...headers, 'idempotency-key': key }, payload: { text: '跑', taskIds: [card.taskId], intent: 'execute', expectedRevision: 0 } });
      expect(started.statusCode, started.body).toBe(202);
      const runId = started.json().runId as string;
      for (let i = 0; i < 6; i++) { const status = await f.engine.advance(runId).catch(() => 'failed'); if (status === 'failed') break; }
      expect((await f.repository.get(runId)).status).toBe('failed');
    }
    expect((await f.board()).cards.find(item => item.title === '跑数据')!.status).toBe('failed');
    expect(await f.app.aeeisBots!.reassignFailures(await f.room(), scope)).toBe(1);
    await f.app.aeeisBots!.drain();
    const items = await f.events();
    expect(items.some(item => item.actorId === 'aeeis' && item.content.startsWith('「跑数据」连续失败两次') && item.content.endsWith('我请阿写接手。'))).toBe(true);
    expect((await f.board()).cards.find(item => item.title === '跑数据')!.decision.assigneeId).toBe(f.writer.id);
    expect(await f.app.aeeisBots!.reassignFailures(await f.room(), scope)).toBe(0);
  });
});
