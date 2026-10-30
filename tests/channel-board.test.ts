import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AeeisConflict, AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, JsonSessionEventRepository, SessionEventService, type SessionEventRepository } from '../src/session-events.js';
import { ChannelBoardService } from '../src/channel-board.js';
import { legacyTaskAction, projectChannelBoard, type BoardConversationView } from '../src/channel-task-action.js';

const conversationId = 'conv_release';

async function channel(repository: SessionEventRepository, domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository()), existing?: { roomId: string; goalId: string; manifestId: string }) {
  const tasks: BoardConversationView = { id: conversationId, agentId: 'demo.release', tasks: [
    { id: 'task_open', title: '发布说明', status: 'discussion' },
    { id: 'task_done', title: '周报', status: 'succeeded', runId: 'run_done' },
  ] };
  let ids = existing;
  if (!ids) {
    const room = await domain.createRoom({ title: '发布协作' }, undefined, 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'demo.release', 'agent', 'alice', 'team-a');
    await domain.addRoomMember(room.id, 'demo.notes', 'agent', 'alice', 'team-a');
    const goal = await domain.createGoal({ title: '发布', roomId: room.id }, undefined, 'alice', 'team-a');
    const manifest = await domain.createContextManifest(goal.id, { purpose: '群聊消息', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    ids = { roomId: room.id, goalId: goal.id, manifestId: manifest.id };
  }
  const events = new SessionEventService(repository, domain);
  const names: Record<string, string> = { 'demo.release': '发布', 'demo.notes': '纪要' };
  const board = new ChannelBoardService(events, domain, async id => id === conversationId ? tasks : undefined, async id => names[id]);
  const cite = (taskId: string, key: string) => events.create(ids!.roomId, { goalId: ids!.goalId, type: 'system', content: `已交给发布，记为讨论「${taskId}」。`, contextManifestId: ids!.manifestId, evidenceRefs: [conversationId, taskId, 'demo.release'], idempotencyKey: key }, 'alice', 'team-a');
  const act = (kind: string, taskId: string, key: string, extra: Record<string, string> = {}) => board.act(ids!.roomId, { kind, conversationId, taskId, goalId: ids!.goalId, contextManifestId: ids!.manifestId, idempotencyKey: key, ...extra }, 'alice', 'team-a');
  return { domain, events, board, tasks, ids, cite, act };
}

function card(view: Awaited<ReturnType<ChannelBoardService['board']>>, taskId: string) {
  const found = view.cards.find(item => item.taskId === taskId);
  if (!found) throw new Error(`no card for ${taskId}`);
  return found;
}

describe('channel board on the server', () => {
  it('lets only the first of two concurrent claims hold, and replays an idempotent claim', async () => {
    const f = await channel(new InMemorySessionEventRepository());
    await f.cite('task_open', 'cite-open');
    const results = await Promise.allSettled([
      f.act('claim', 'task_open', 'claim-release', { agentId: 'demo.release' }),
      f.act('claim', 'task_open', 'claim-notes', { agentId: 'demo.notes' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(AeeisConflict);
    expect(String(refused.reason.message)).toMatch(/^(发布|纪要)已领取$/);
    const board = await f.board.board(f.ids.roomId, 'alice', 'team-a');
    expect(card(board, 'task_open').decision.assigneeId).toMatch(/^demo\./);
    expect(card(board, 'task_open').decision.conflicts).toEqual([]);
    const winner = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ event: { idempotencyKey: string; taskAction?: unknown } }>).value.event;
    expect(winner.taskAction).toMatchObject({ schemaVersion: 'channel-task-action/1', kind: 'claim', conversationId, taskId: 'task_open' });
    const replay = await f.act('claim', 'task_open', winner.idempotencyKey, { agentId: card(board, 'task_open').decision.assigneeId! });
    expect(replay.event).toEqual(winner);
  });

  it('serializes concurrent claims in the JSON store and keeps the board after restart', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'aeeis-board-json-')), 'events.json');
    const first = new JsonSessionEventRepository(file); await first.init();
    const f = await channel(first);
    await f.cite('task_open', 'cite-open');
    await f.cite('task_done', 'cite-done');
    const results = await Promise.allSettled([
      f.act('claim', 'task_open', 'claim-a', { agentId: 'demo.release' }),
      f.act('claim', 'task_open', 'claim-b', { agentId: 'demo.notes' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await f.act('block', 'task_open', 'block-1', { reason: '等权限' });
    await f.act('accept', 'task_done', 'accept-1');
    const before = await f.board.board(f.ids.roomId, 'alice', 'team-a');
    await first.close();
    const second = new JsonSessionEventRepository(file); await second.init();
    try {
      const again = await channel(second, f.domain, f.ids);
      const after = await again.board.board(f.ids.roomId, 'alice', 'team-a');
      expect(after.cards).toEqual(before.cards);
      expect(card(after, 'task_open').column).toBe('blocked');
      expect(card(after, 'task_done').column).toBe('done');
    } finally { await second.close(); }
  });

  it('enforces accept, unblock, restore and work-in-progress rules on the server', async () => {
    const f = await channel(new InMemorySessionEventRepository());
    await f.cite('task_open', 'cite-open');
    await f.cite('task_done', 'cite-done');
    await expect(f.act('accept', 'task_open', 'accept-open')).rejects.toThrow('只有已成功的事可以验收');
    await f.act('accept', 'task_done', 'accept-done');
    await expect(f.act('accept', 'task_done', 'accept-again')).rejects.toThrow('已经验收');
    await expect(f.act('unblock', 'task_open', 'unblock-none', { reason: '好了' })).rejects.toThrow('没有阻塞说明');
    await expect(f.act('restore', 'task_open', 'restore-none', { reason: '要做' })).rejects.toThrow('没有在频道里取消');
    await expect(f.act('block', 'task_open', 'block-no-reason')).rejects.toThrow('原因');
    await expect(f.act('claim', 'task_open', 'claim-stranger', { agentId: 'demo.stranger' })).rejects.toThrow('不在这个频道里');
    await expect(f.act('claim', 'task_missing', 'claim-missing', { agentId: 'demo.release' })).rejects.toThrow('不在这个频道的任务板上');
    await f.act('cancel', 'task_open', 'cancel-1', { reason: '不做了' });
    expect(card(await f.board.board(f.ids.roomId, 'alice', 'team-a'), 'task_open').column).toBe('failed');
    await f.act('restore', 'task_open', 'restore-1', { reason: '还是要做' });
    expect(card(await f.board.board(f.ids.roomId, 'alice', 'team-a'), 'task_open').column).toBe('capture');
    f.tasks.tasks.push(...[1, 2, 3].map(index => ({ id: `task_busy_${index}`, title: `忙 ${index}`, status: 'running', runId: `run_busy_${index}` })));
    for (const index of [1, 2, 3]) await f.cite(`task_busy_${index}`, `cite-busy-${index}`);
    const board = await f.board.board(f.ids.roomId, 'alice', 'team-a');
    expect(board.wip).toEqual([{ agentId: 'demo.release', count: 3 }]);
    await expect(f.act('assign', 'task_open', 'assign-busy', { agentId: 'demo.release' })).rejects.toThrow('进行中已有 3 件');
    await expect(f.act('assign', 'task_open', 'assign-notes', { agentId: 'demo.notes' })).resolves.toBeDefined();
  });

  it('refuses task actions from a member who is not the room owner', async () => {
    const f = await channel(new InMemorySessionEventRepository());
    await f.domain.addRoomMember(f.ids.roomId, 'bob', 'editor', 'alice', 'team-a');
    await f.cite('task_open', 'cite-open');
    await expect(f.board.act(f.ids.roomId, { kind: 'claim', conversationId, taskId: 'task_open', agentId: 'demo.release', goalId: f.ids.goalId, contextManifestId: f.ids.manifestId, idempotencyKey: 'bob-claim' }, 'bob', 'team-a')).rejects.toThrow('只有房间主人');
  });

  it('pages from the newest event backwards so a long channel opens on its latest messages', async () => {
    const f = await channel(new InMemorySessionEventRepository());
    for (let index = 1; index <= 1_030; index += 1) await f.events.create(f.ids.roomId, { goalId: f.ids.goalId, type: 'message', content: `消息 ${index}`, contextManifestId: f.ids.manifestId, idempotencyKey: `m-${index}` }, 'alice', 'team-a');
    const latest = await f.events.pageBefore(f.ids.roomId, 'alice', 'team-a', 50);
    expect(latest.items.map(item => item.content)).toEqual(Array.from({ length: 50 }, (_, index) => `消息 ${981 + index}`));
    expect(latest.previousCursor).toBe('981');
    const older = await f.events.pageBefore(f.ids.roomId, 'alice', 'team-a', 50, Number(latest.previousCursor));
    expect(older.items.at(-1)?.content).toBe('消息 980');
    expect(older.items).toHaveLength(50);
    const delta = await f.events.page(f.ids.roomId, 'alice', 'team-a', 50, 1_030);
    expect(delta.items).toEqual([]);
    await f.events.create(f.ids.roomId, { goalId: f.ids.goalId, type: 'message', content: '新消息', contextManifestId: f.ids.manifestId, idempotencyKey: 'm-new' }, 'alice', 'team-a');
    expect((await f.events.page(f.ids.roomId, 'alice', 'team-a', 50, 1_030)).items.map(item => item.content)).toEqual(['新消息']);
  });

  it('keeps a task\'s handoff chain in event order, without echoing the holder', () => {
    const owner = { owner: 'alice', actorId: 'alice', actorType: 'principal' };
    const action = (kind: string, agentId: string) => ({ schemaVersion: 'channel-task-action/1' as const, kind: kind as 'propose', conversationId, taskId: 'task_risk', agentId });
    const events = [
      { id: 'e1', sequence: 1, type: 'system', content: '研究提议：风险摘要', evidenceRefs: [conversationId, 'task_risk', 'demo.research'], ...owner },
      { id: 'e2', sequence: 2, type: 'task_update', content: '研究提议这件事', evidenceRefs: [conversationId, 'task_risk', 'demo.research'], taskAction: action('propose', 'demo.research'), ...owner },
      { id: 'e3', sequence: 3, type: 'task_update', content: '交接中：交给 发布', evidenceRefs: [conversationId, 'task_risk', 'demo.release'], taskAction: action('offer', 'demo.release'), ...owner },
      { id: 'e4', sequence: 4, type: 'task_update', content: '转交给 发布', evidenceRefs: [conversationId, 'task_risk', 'demo.release'], taskAction: action('transfer', 'demo.release'), ...owner },
      { id: 'e5', sequence: 5, type: 'system', content: '发布接下了「风险摘要」（来自研究）。', evidenceRefs: [conversationId, 'task_risk', 'demo.release'], ...owner },
    ];
    const names: Record<string, string> = { 'demo.research': '研究', 'demo.release': '发布' };
    const board = projectChannelBoard('room', events, new Map([[conversationId, { id: conversationId, agentId: 'demo.research', tasks: [{ id: 'task_risk', title: '风险摘要', status: 'discussion' }] }]]), id => names[id] ?? id);
    expect(card(board, 'task_risk').chain).toEqual(['交给研究', '研究提议这件事', '交接中：交给 发布', '转交给 发布']);
  });

  it('reads channels written before structured actions', () => {
    const owner = { owner: 'alice', actorId: 'alice', actorType: 'principal' };
    const events = [
      { id: 'e1', sequence: 1, type: 'system', content: '已交给发布，记为讨论。', evidenceRefs: [conversationId, 'task_open', 'demo.release'], ...owner },
      { id: 'e2', sequence: 2, type: 'task_update', content: '领取：发布', evidenceRefs: [conversationId, 'task_open', 'demo.release'], ...owner },
      { id: 'e3', sequence: 3, type: 'task_update', content: '阻塞：等权限', evidenceRefs: [conversationId, 'task_open'], ...owner },
      { id: 'e4', sequence: 4, type: 'system', content: '已交给发布，记为讨论。', evidenceRefs: [conversationId, 'task_done', 'demo.release'], ...owner },
      { id: 'e5', sequence: 5, type: 'task_update', content: '验收通过', evidenceRefs: [conversationId, 'task_done'], ...owner },
      { id: 'e6', sequence: 6, type: 'task_update', content: '领取：别人', evidenceRefs: [conversationId, 'task_open', 'demo.notes'], actorId: 'mallory', actorType: 'principal', owner: 'alice' },
    ];
    expect(legacyTaskAction(events[1]!)).toEqual({ schemaVersion: 'channel-task-action/1', kind: 'claim', conversationId, taskId: 'task_open', agentId: 'demo.release' });
    const board = projectChannelBoard('room', events, new Map([[conversationId, { id: conversationId, tasks: [{ id: 'task_open', title: '发布说明', status: 'discussion' }, { id: 'task_done', title: '周报', status: 'succeeded' }] }]]));
    expect(card(board, 'task_open')).toMatchObject({ column: 'blocked', decision: { assigneeId: 'demo.release', blockedNote: '等权限', conflicts: [] } });
    expect(card(board, 'task_done').column).toBe('done');
    expect(board.cursor).toBe(6);
  });

  it('shows a cited conversation the reader cannot open as unreadable instead of failing', async () => {
    const f = await channel(new InMemorySessionEventRepository());
    await f.events.create(f.ids.roomId, { goalId: f.ids.goalId, type: 'system', content: '已交给别人', contextManifestId: f.ids.manifestId, evidenceRefs: ['conv_other', 'task_other', 'demo.notes'], idempotencyKey: 'cite-other' }, 'alice', 'team-a');
    const board = await f.board.board(f.ids.roomId, 'alice', 'team-a');
    expect(card(board, 'task_other')).toMatchObject({ status: 'unreadable', column: 'failed' });
  });
});

