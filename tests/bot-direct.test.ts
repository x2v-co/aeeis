import { describe, expect, it, vi } from 'vitest';
import { dialogueFixture, dialogueScope as scope } from './support/bot-dialogues.js';

const ASK = '另一位 Bot 在你们俩的侧线程里问你一个问题';
const TURN = '在你们的侧线程里谈一件任务的交接';
const REPLY = '只讨论，不执行';

type Script = { reply?: (input: any) => unknown; answer?: (input: any) => unknown; turn?: (input: any, turn: number) => unknown };
async function direct(script: Script, autonomy: 'reply' | 'auto' = 'reply') {
  let turns = 0;
  const f = await dialogueFixture({ replies: true, model: request => {
    if (request.system.includes(ASK)) return script.answer?.(request.input) ?? { answer: '先列型号和数量。' };
    if (request.system.includes(TURN)) return script.turn?.(request.input, turns++) ?? { decision: 'accept', message: '我来。' };
    if (request.system.includes(REPLY)) return script.reply?.(request.input) ?? { reply: '收到。' };
    return undefined;
  } });
  if (autonomy !== 'reply') await f.bots.update(f.bot.id, { name: f.bot.name, mark: f.bot.mark, color: f.bot.color, background: f.bot.background, autonomy }, scope);
  const writer = await f.bots.create({ name: '阿写', mark: 'letter', color: '#176b45', background: '写报价和文案', autonomy: 'reply' }, scope);
  const binding = await f.ensure();
  const say = async (body: Record<string, unknown>, key: string) => {
    const view = (await f.request(`/conversations/${binding.conversationId}`)).json();
    const sent = await f.request(`/rooms/${binding.roomId}/dialogue/messages`, { expectedRevision: view.revision, intent: 'discuss', ...body }, key);
    if (sent.statusCode >= 300) throw new Error(sent.body);
    await f.app.aeeisBots?.drain();
    return (await f.request(`/conversations/${binding.conversationId}`)).json();
  };
  const sideEvents = async () => {
    const rooms = (await f.domain.listRooms(scope.owner, scope.tenantId)).filter(room => room.description === '侧线程');
    return rooms.length ? f.events.history(rooms[0]!.id, scope.owner, scope.tenantId) : [];
  };
  return { f, writer, binding, say, sideEvents };
}

describe('Bots working together from a private chat', () => {
  it('knows the team, asks another Bot in their side thread, and brings the answer back in that Bot\'s name', async () => {
    let seen: any;
    const { f, writer, say, sideEvents } = await direct({
      reply: input => { seen = input; return { reply: '我问问阿写。', ask: { to: '阿写', question: '给客户的报价要写什么？' } }; },
    });
    try {
      const view = await say({ text: '报价单该怎么写？', unassigned: true }, 'ask-1');
      expect(seen.team).toEqual(expect.arrayContaining([expect.objectContaining({ name: '阿写' }), expect.objectContaining({ name: 'AEEIS' })]));
      expect(seen.team.some((item: { name: string }) => item.name === f.bot.name)).toBe(false);
      expect(view.messages).toHaveLength(3);
      const [, reply, answer] = view.messages;
      expect(reply).toMatchObject({ speaker: { role: 'agent', id: f.bot.id }, text: '我问问阿写。' });
      expect(answer).toMatchObject({ speaker: { role: 'agent', id: writer.id }, text: '阿写：先列型号和数量。', replyTo: reply.id, intent: 'discuss' });
      // Bot lines never wait for the owner to pick a task.
      expect(view.messages.filter((m: any) => m.speaker?.role === 'agent').every((m: any) => m.route.status !== 'clarify')).toBe(true);
      const side = await sideEvents();
      expect(side.map(event => [event.actorId, event.content])).toEqual([[f.bot.id, '给客户的报价要写什么？'], [writer.id, '先列型号和数量。']]);
      // Nothing ran, and a sweep of the same message does not ask twice.
      expect(await f.runs.list(scope)).toHaveLength(0);
      const calls = f.calls.length;
      await f.app.aeeisBots?.sweep(await f.domain.getRoomForPrincipal((await f.ensure()).roomId, scope.owner, scope.tenantId), scope);
      await f.app.aeeisBots?.drain();
      expect(f.calls).toHaveLength(calls);
    } finally { await f.close(); }
  });

  it('suggests a handoff, waits for the owner, then hands the task over when the other Bot accepts', async () => {
    const { f, writer, binding, say, sideEvents } = await direct({
      reply: () => ({ reply: '这件更适合阿写。', handoff: { to: '阿写', task: '客户报价单', note: '阿写熟悉报价格式' } }),
    });
    try {
      let view = await say({ text: '帮我出一份客户报价单', newTask: { title: '客户报价单' } }, 'handoff-1');
      const task = view.tasks.find((item: any) => item.title === '客户报价单');
      expect(task.handoff).toMatchObject({ state: 'suggested', to: writer.id, toName: '阿写', note: '阿写熟悉报价格式', from: f.bot.id });
      // Default autonomy: nothing is talked over until the owner says so.
      expect(f.calls.some((call: any) => call.system.includes(TURN))).toBe(false);
      expect(await sideEvents()).toEqual([]);
      const stale = await f.request(`/conversations/${binding.conversationId}/tasks/${task.id}/hand-off`, { expectedRevision: view.revision - 1 });
      expect(stale.statusCode).toBe(409);
      const started = await f.request(`/conversations/${binding.conversationId}/tasks/${task.id}/hand-off`, { expectedRevision: view.revision });
      expect(started.statusCode, started.body).toBe(200);
      expect(started.json().tasks.find((item: any) => item.id === task.id).handoff.state).toBe('negotiating');
      await f.app.aeeisBots?.drain();
      view = (await f.request(`/conversations/${binding.conversationId}`)).json();
      const done = view.tasks.find((item: any) => item.id === task.id).handoff;
      expect(done).toMatchObject({ state: 'accepted', to: writer.id, receiver: { conversationId: expect.any(String), taskId: expect.any(String) } });
      expect(view.messages.at(-1)).toMatchObject({ speaker: { role: 'agent', id: f.bot.id }, text: '阿写接下了「客户报价单」，接着在阿写那边做。' });
      // The task now lives in the other Bot's chat, linked from here.
      const receiver = (await f.request(`/conversations/${done.receiver.conversationId}`)).json();
      expect(receiver.agentId).toBe(writer.id);
      expect(receiver.tasks.find((item: any) => item.id === done.receiver.taskId).title).toBe('客户报价单');
      expect((await sideEvents()).map(event => [event.actorId, event.content])).toEqual([[writer.id, '我来。']]);
      // A finished handoff cannot start again, and nothing ran (the receiver waits for its owner too).
      expect((await f.request(`/conversations/${binding.conversationId}/tasks/${task.id}/hand-off`, { expectedRevision: view.revision })).statusCode).toBe(409);
      expect(await f.runs.list(scope)).toHaveLength(0);
    } finally { await f.close(); }
  });

  it('keeps the task when the other Bot declines, and puts a stalemate in front of the owner who may try again', async () => {
    let mode: 'decline' | 'broken' | 'accept' = 'decline';
    const { f, binding, say } = await direct({
      reply: () => ({ reply: '交给阿写吧。', handoff: { to: '阿写', task: '周报' } }),
      turn: () => mode === 'decline' ? { decision: 'decline', message: '我手上满了。' } : mode === 'broken' ? { nonsense: true } : { decision: 'accept', message: '好。' },
    });
    try {
      let view = await say({ text: '写周报', newTask: { title: '周报' } }, 'decline-1');
      const taskId = view.tasks.find((item: any) => item.title === '周报').id;
      const handOff = async () => {
        const current = (await f.request(`/conversations/${binding.conversationId}`)).json();
        const sent = await f.request(`/conversations/${binding.conversationId}/tasks/${taskId}/hand-off`, { expectedRevision: current.revision });
        expect(sent.statusCode, sent.body).toBe(200);
        await f.app.aeeisBots?.drain();
        return (await f.request(`/conversations/${binding.conversationId}`)).json();
      };
      view = await handOff();
      expect(view.tasks.find((item: any) => item.id === taskId).handoff).toMatchObject({ state: 'declined', reason: '阿写没有接：我手上满了。' });
      mode = 'broken';
      view = await handOff();
      expect(view.tasks.find((item: any) => item.id === taskId).handoff).toMatchObject({ state: 'blocked', reason: expect.stringContaining('交接谈不拢') });
      expect(view.messages.at(-1).text).toContain('需要你决定');
      mode = 'accept';
      view = await handOff();
      expect(view.tasks.find((item: any) => item.id === taskId).handoff.state).toBe('accepted');
    } finally { await f.close(); }
  });

  it('lets a Bot set to act on its own start the handoff without waiting', async () => {
    const { f, binding, say } = await direct({ reply: () => ({ reply: '我交给阿写。', handoff: { to: '阿写', task: '整理资料' } }) }, 'auto');
    try {
      await say({ text: '整理一下资料', newTask: { title: '整理资料' } }, 'auto-1');
      const view = (await f.request(`/conversations/${binding.conversationId}`)).json();
      expect(view.tasks.find((item: any) => item.title === '整理资料').handoff.state).toBe('accepted');
    } finally { await f.close(); }
  });

  it('finishes a handoff left open by a restart', async () => {
    const { f, writer, binding, say } = await direct({ reply: () => ({ reply: '好。' }) });
    try {
      const view = await say({ text: '写方案', newTask: { title: '方案' } }, 'restart-1');
      const taskId = view.tasks.find((item: any) => item.title === '方案').id;
      // The click landed but the process stopped before the Bots talked.
      await f.conversations.beginHandoff(binding.conversationId, taskId, { expectedRevision: view.revision, to: writer.id }, scope);
      expect((await f.request(`/conversations/${binding.conversationId}`)).json().tasks.find((item: any) => item.id === taskId).handoff.state).toBe('negotiating');
      await f.app.aeeisBots?.sweepDirect(scope);
      const after = (await f.request(`/conversations/${binding.conversationId}`)).json();
      expect(after.tasks.find((item: any) => item.id === taskId).handoff).toMatchObject({ state: 'accepted', toName: '阿写' });
    } finally { await f.close(); }
  });

  it('hands over the task the Bot named, never the focus task, making it when it does not exist yet', async () => {
    const { f, binding, say } = await direct({ reply: () => ({ reply: '新的那件交给阿写。', handoff: { to: '阿写', task: '客户回访' } }) });
    try {
      let view = await say({ text: '先说周报', newTask: { title: '周报' }, focus: 'switch' }, 'focus-1');
      const report = view.tasks.find((item: any) => item.title === '周报');
      expect(view.focusTaskId).toBe(report.id);
      view = await say({ text: '还有客户回访', unassigned: true }, 'named-1');
      expect(view.tasks.find((item: any) => item.id === report.id).handoff).toBeUndefined();
      expect(view.tasks.find((item: any) => item.title === '客户回访').handoff).toMatchObject({ state: 'suggested', toName: '阿写' });
      expect(binding.conversationId).toBe(view.id);
    } finally { await f.close(); }
  });

  it('replays a decision already written in the side thread after a crash, instead of talking on', async () => {
    let decision = 'accept';
    const { f, binding, say } = await direct({ reply: () => ({ reply: '好。' }), turn: () => ({ decision, message: decision === 'accept' ? '我来。' : '不接。' }) });
    try {
      const view = await say({ text: '写方案', newTask: { title: '方案' } }, 'crash-1');
      const taskId = view.tasks.find((item: any) => item.title === '方案').id;
      const writer = (await f.bots.list(scope)).find(bot => bot.name === '阿写')!;
      // The process stops right after the receiver's answer is written, before the outcome is recorded.
      const create = f.events.create.bind(f.events);
      const spy = vi.spyOn(f.events, 'create').mockImplementationOnce(async (...args) => { await create(...args); throw new Error('crashed'); });
      await f.conversations.beginHandoff(binding.conversationId, taskId, { expectedRevision: view.revision, to: writer.id }, scope);
      await f.app.aeeisBots?.sweepDirect(scope);
      expect((await f.request(`/conversations/${binding.conversationId}`)).json().tasks.find((item: any) => item.id === taskId).handoff.state).toBe('negotiating');
      spy.mockRestore();
      // On restart the model would now say no; the accept already written wins and no new turn is asked for.
      decision = 'decline';
      const turns = f.calls.filter((call: any) => call.system.includes(TURN)).length;
      await f.app.aeeisBots?.sweepDirect(scope);
      expect((await f.request(`/conversations/${binding.conversationId}`)).json().tasks.find((item: any) => item.id === taskId).handoff.state).toBe('accepted');
      expect(f.calls.filter((call: any) => call.system.includes(TURN))).toHaveLength(turns);
    } finally { await f.close(); }
  });

  it('refuses to hand over a task that is running, and keeps a task that started while the Bots talked', async () => {
    const { f, writer, binding, say } = await direct({ reply: () => ({ reply: '好。' }) });
    try {
      let view = await say({ text: '写方案', newTask: { title: '方案' } }, 'busy-1');
      const taskId = view.tasks.find((item: any) => item.title === '方案').id;
      await f.conversations.beginHandoff(binding.conversationId, taskId, { expectedRevision: view.revision, to: writer.id }, scope);
      // The owner starts the work here before the Bots finish talking.
      const fresh = (await f.request(`/conversations/${binding.conversationId}`)).json();
      const started = await f.request(`/rooms/${binding.roomId}/dialogue/messages`, { text: '我先自己开始', expectedRevision: fresh.revision, taskIds: [taskId], intent: 'execute' }, 'busy-run');
      expect(started.statusCode, started.body).toBe(202);
      await f.app.aeeisBots?.sweepDirect(scope);
      view = (await f.request(`/conversations/${binding.conversationId}`)).json();
      expect(view.tasks.find((item: any) => item.id === taskId).handoff).toMatchObject({ state: 'declined', reason: '这边已经开始做了' });
      expect((await f.conversations.list(scope)).some((item: any) => item.agentId === writer.id && item.taskCount)).toBe(false);
      // And while it runs, it cannot be handed over at all.
      const refused = await f.request(`/conversations/${binding.conversationId}/tasks/${taskId}/hand-off`, { expectedRevision: view.revision });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain('这件任务还在做');
    } finally { await f.close(); }
  });

  it('ignores asks and handoffs to unknown, quiet or self names, and refuses a handoff outside a Bot chat', async () => {
    const { f, say } = await direct({ reply: () => ({ reply: '好的。', ask: { to: '不存在', question: '在吗？' }, handoff: { to: '阿研', task: '自己' } }) });
    try {
      const view = await say({ text: '随便聊聊', unassigned: true }, 'odd-1');
      expect(view.messages).toHaveLength(2);
      expect(view.tasks.every((task: any) => !task.handoff)).toBe(true);
      const plain = await f.conversations.create({ title: '普通对话' }, scope);
      const sent = await f.conversations.post(plain.id, { text: '一件事', expectedRevision: plain.revision, newTask: { title: '一件事' }, intent: 'discuss' }, scope, 'plain-1', false);
      const refused = await f.request(`/conversations/${plain.id}/tasks/${sent.message.route.taskIds[0]}/hand-off`, { expectedRevision: sent.conversation.revision, to: f.bot.id });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toContain('只有 Bot 的单独对话里的任务可以交给别的 Bot');
    } finally { await f.close(); }
  });
});
