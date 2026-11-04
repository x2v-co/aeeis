import { InMemoryTaskBoardStore, type TaskBoardStore } from './adapters/task-board-store.js';
import { applyBoardControls, assertBoardMove, authorityBoundary, boardControlInputSchema, controlAction } from './task-board-controls.js';
import { z } from 'zod';
import { AeeisConflict, AeeisNotFound, type AeeisService } from './application/aeeis-service.js';
import type { SessionEvent, SessionEventService } from './session-events.js';
import {
  WIP_LIMIT, actionNeedsAgent, channelTaskActionKindSchema, actionNeedsReason, emptyDecision, applyTaskAction, eventTaskAction, projectChannelBoard, taskActionLine, writableTaskActionKinds,
  type BoardConversationView, type BoardDecision, type BoardEvent, type ChannelBoard, type ChannelTaskAction, eventCitation,
} from './channel-task-action.js';

const id = z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
export const channelTaskActionInputSchema = z.object({
  kind: z.enum(writableTaskActionKinds),
  conversationId: id,
  taskId: id,
  agentId: id.optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
  goalId: z.string().trim().min(1).max(200).optional(),
  contextManifestId: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(1).max(500),
}).strict();
export type ChannelTaskActionInput = z.infer<typeof channelTaskActionInputSchema>;
const serverTaskActionInputSchema = channelTaskActionInputSchema.extend({ kind: channelTaskActionKindSchema.exclude(['hand_up']) });
type ServerTaskActionInput = z.infer<typeof serverTaskActionInputSchema>;

/** Reads one conversation as the given principal. Returns undefined when the
 * reader cannot open it; the board then shows its tasks as unreadable. */
export type BoardConversationReader = (conversationId: string, actorId: string, tenantId: string) => Promise<BoardConversationView | undefined>;
export type BoardNameReader = (agentId: string, tenantId: string) => Promise<string | undefined>;
export interface BoardHolding {
  roomId: string; roomTitle: string; conversationId: string; taskId: string; holderId: string; fromId: string; title?: string; status: string;
  /** The channel's block note: the task waits for a person even though no Run asks. */
  blocked?: string; blockedAt?: string;
}

/** Channel task board on the server. The room's session events are the fact
 * source; every rule is checked here, and the browser only sends intent. */
export class ChannelBoardService {
  constructor(
    private readonly events: SessionEventService,
    private readonly domain: AeeisService,
    private readonly readConversation: BoardConversationReader,
    private readonly nameOf: BoardNameReader = async () => undefined,
    readonly controls: TaskBoardStore = new InMemoryTaskBoardStore(),
    private readonly directConversation: (roomId: string, actorId: string, tenantId: string) => Promise<BoardConversationView | undefined> = async () => undefined,
  ) {}

  /** Display name of a participant; the id itself when there is none. */
  async nameFor(agentId: string, tenantId: string): Promise<string> {
    if (agentId === 'aeeis') return 'AEEIS';
    return await this.nameOf(agentId, tenantId).catch(() => undefined) ?? agentId;
  }

  async board(roomId: string, actorId: string, tenantId: string): Promise<ChannelBoard> {
    const room = await this.domain.getRoomForPrincipal(roomId, actorId, tenantId);
    const history = await this.events.history(roomId, actorId, tenantId);
    const direct = await this.directConversation(roomId, actorId, tenantId);
    const owner = room.owner ?? 'owner';
    // Rebuild missing relations from canonical direct tasks and legacy receipts.
    // These writes carry ids only; neither path creates messages or Runs.
    if (direct) for (const task of direct.tasks) await this.controls.link({ roomId, owner, tenantId, conversationId: direct.id, taskId: task.id, sourceId: task.sourceId ?? task.id });
    for (const event of history) {
      const ref = eventCitation(event) ?? eventTaskAction(event);
      if (ref) await this.controls.link({ roomId, owner, tenantId, conversationId: ref.conversationId, taskId: ref.taskId, sourceId: event.id });
    }
    let board = await this.snapshot(roomId, actorId, tenantId, history);
    // GET is authoritative even before the notification/recovery pump runs.
    for (const card of board.cards) {
      const latest = controlAction(history, card.conversationId, card.taskId);
      const action = latest?.action;
      if (action?.schemaVersion !== 'channel-task-action/2' || action.kind !== 'move' || !latest || !('schemaVersion' in latest.event)) continue;
      if (action.expectedRunId === (card.runId ?? null) && action.runBoundary === (card.runBoundary ?? 0) && (!authorityBoundary(card.status) || card.status === 'succeeded' && ['review', 'done'].includes(action.toColumn ?? ''))) continue;
      const clear: ChannelTaskAction = { ...action, kind: 'clear_override', toColumn: null, fromColumn: card.column,
        autoColumn: card.autoColumn!, expectedVersion: card.version!, version: card.version! + 1,
        expectedRunId: card.runId ?? null, expectedRunRevision: card.runRevision ?? null, runBoundary: card.runBoundary ?? 0,
        source: 'system', reason: 'Run 已换轮次或跨越等待/结果边界，旧整理与验收失效' };
      await this.events.invalidateBoardControl(latest.event as SessionEvent, clear).catch(error => {
        if (!(error instanceof AeeisConflict || error instanceof Error && /stale|变化/.test(error.message))) throw error;
      });
    }
    const fresh = await this.events.history(roomId, actorId, tenantId);
    if (fresh.length !== history.length) board = await this.snapshot(roomId, actorId, tenantId, fresh);
    const latestAudits = new Map(fresh.filter(event => event.taskAction?.schemaVersion === 'channel-task-action/2' || event.taskAction?.schemaVersion === 'channel-task-action/1' && event.taskAction.boardVersion !== undefined).map(event => [JSON.stringify([event.taskAction!.conversationId,event.taskAction!.taskId]),event]));
    await this.controls.repair?.([...latestAudits.values()]);
    return board;
  }

  private async snapshot(roomId: string, actorId: string, tenantId: string, history: readonly SessionEvent[]): Promise<ChannelBoard> {
    const room = await this.domain.getRoomForPrincipal(roomId, actorId, tenantId);
    const owner = room.owner ?? 'owner';
    const relations = await this.controls.list(roomId, owner, tenantId);
    const synthetic: BoardEvent[] = relations.filter(row => !history.some(event => { const cite = eventCitation(event); return cite?.conversationId === row.conversationId && cite.taskId === row.taskId; })).map(row => ({ id: row.sourceId, type: 'system', actorId: owner, actorType: 'principal', owner, content: '', evidenceRefs: [row.conversationId,row.taskId] }));
    const all = [...synthetic, ...history];
    const conversations = await this.conversations(all, actorId, tenantId);
    const names = await this.names(history, tenantId);
    return applyBoardControls(projectChannelBoard(roomId, all, conversations, id => names.get(id) ?? id), history, actorId === owner && room.status === 'active');
  }

  async move(roomId: string, raw: unknown, actorId: string, tenantId: string): Promise<{ event: SessionEvent; board: ChannelBoard }> {
    const input = boardControlInputSchema.parse(raw);
    const room = await this.domain.assertRoomEventWriter(roomId, actorId, tenantId);
    if ((room.owner ?? 'owner') !== actorId) throw new AeeisConflict('只有房间主人可以改任务板');
    const history = await this.events.history(roomId, actorId, tenantId);
    const replay = history.find(event => event.idempotencyKey === input.idempotencyKey);
    if (replay) {
      const a = replay.taskAction;
      if (a?.schemaVersion !== 'channel-task-action/2' || a.kind !== input.kind || a.conversationId !== input.conversationId || a.taskId !== input.taskId || a.expectedVersion !== input.expectedVersion || a.expectedRunId !== input.expectedRunId || a.expectedRunRevision !== input.expectedRunRevision || a.toColumn !== input.toColumn || a.reason !== input.reason || a.source !== input.source) throw new AeeisConflict('幂等键已用于其他动作');
      return { event: replay, board: await this.board(roomId, actorId, tenantId) };
    }
    const before = await this.board(roomId, actorId, tenantId);
    const card = before.cards.find(card => card.conversationId === input.conversationId && card.taskId === input.taskId);
    if (!card) throw new AeeisNotFound('这件事不在这个频道的任务板上');
    try { assertBoardMove(card, input, before); }
    catch (error) {
      if ((await this.events.history(roomId,actorId,tenantId)).some(event => event.idempotencyKey === input.idempotencyKey)) return this.move(roomId,raw,actorId,tenantId);
      throw error;
    }
    const action: ChannelTaskAction = {
      schemaVersion: 'channel-task-action/2', kind: input.kind, conversationId: input.conversationId, taskId: input.taskId,
      toColumn: input.toColumn, fromColumn: card.column, autoColumn: card.autoColumn!, expectedVersion: input.expectedVersion, version: input.expectedVersion + 1,
      expectedRunId: input.expectedRunId, expectedRunRevision: input.expectedRunRevision, runBoundary: card.runBoundary ?? 0,
      reason: input.reason, source: input.source,
    };
    let manifestId = input.contextManifestId, goalId = input.goalId;
    if (!manifestId) {
      const goals = await this.domain.listGoalsInRoomForPrincipal(roomId, actorId, tenantId);
      const goal = goals.find(item => item.status === 'active') ?? goals[0] ?? await this.domain.createGoal({ title: '任务板整理', roomId }, undefined, actorId, tenantId);
      goalId = goal.id;
      manifestId = (await this.domain.createContextManifest(goal.id, { purpose: '任务板整理', audienceMode: 'room' }, undefined, actorId, tenantId)).id;
    }
    const event = await this.events.createTaskAction(roomId, { taskAction: action, content: taskActionLine(action), contextManifestId: manifestId, ...(goalId ? { goalId } : {}),
      evidenceRefs: [input.conversationId,input.taskId], idempotencyKey: input.idempotencyKey }, actorId, tenantId, async written => {
      await this.domain.assertRoomEventWriter(roomId, actorId, tenantId);
      const live = await this.snapshot(roomId, actorId, tenantId, written);
      const current = live.cards.find(card => card.conversationId === input.conversationId && card.taskId === input.taskId);
      if (!current) throw new AeeisNotFound('任务已变化，请刷新');
      assertBoardMove(current, input, live);
      if (current.runBoundary !== card.runBoundary) throw new AeeisConflict('Run 已变化，请刷新');
    });
    return { event, board: await this.board(roomId, actorId, tenantId) };
  }

  private discoveryAfter: string | undefined;
  private scanAfter: string | undefined;
  private pumping: Promise<void> | undefined;
  /** API-process recovery: bounded relation inventory; changefeed is a wake hint.
   * All Run snapshots are loaded outside Run locks, including delayed events. */
  pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const work = async () => {
      const discovery = await this.events.boardRoomsPage(this.discoveryAfter);
      const page = await this.controls.page(this.scanAfter, 25);
      const rooms = new Map([...discovery.items, ...page.items].map(row => [JSON.stringify([row.tenantId,row.owner,row.roomId]),row]));
      for (const row of rooms.values()) {
        try { await this.board(row.roomId,row.owner,row.tenantId); }
        catch (error) { if (!(error instanceof AeeisNotFound)) throw error; }
      }
      this.scanAfter = page.next; this.discoveryAfter = discovery.next;
    };
    this.pumping = work().finally(() => { this.pumping = undefined; }); return this.pumping;
  }

  /** Tasks in the owner's group chats that the roster and inbox must place
   * apart from their thread: handed to someone else, or blocked in the channel. */
  async holdings(actorId: string, tenantId: string): Promise<BoardHolding[]> {
    const rooms = (await this.domain.listRoomsForPrincipal(actorId, tenantId))
      .filter(room => room.status === 'active' && room.chat === 'group' && (room.owner ?? 'owner') === actorId);
    const held: BoardHolding[] = [];
    for (const room of rooms) {
      const board = await this.board(room.id, actorId, tenantId);
      for (const card of board.cards) {
        if (card.column === 'done' || card.decision.cancelled) continue;
        const blocked = card.column === 'blocked' ? card.decision.blockedNote : undefined;
        if (!blocked && !(card.movedFrom && card.ownerId)) continue;
        const blockedAt = blocked ? board.actions.filter(mark => mark.kind === 'block' && mark.conversationId === card.conversationId && mark.taskId === card.taskId).at(-1)?.at : undefined;
        held.push({
          roomId: room.id, roomTitle: room.title, conversationId: card.conversationId, taskId: card.taskId, holderId: card.ownerId, fromId: card.movedFrom ?? card.ownerId,
          ...(card.title ? { title: card.title } : {}), status: card.status, ...(blocked ? { blocked } : {}), ...(blockedAt ? { blockedAt } : {}),
        });
      }
    }
    return held;
  }

  async act(roomId: string, raw: unknown, actorId: string, tenantId: string): Promise<{ event: SessionEvent; board: ChannelBoard }> {
    return this.write(roomId, channelTaskActionInputSchema.parse(raw), actorId, tenantId);
  }
  /** The server's own writes on the room owner's behalf: a Bot's proposal, and handoff offers and outcomes. Same rules, same lock. */
  async record(roomId: string, raw: unknown, ownerId: string, tenantId: string): Promise<{ event: SessionEvent; board: ChannelBoard }> {
    return this.write(roomId, serverTaskActionInputSchema.parse(raw), ownerId, tenantId);
  }
  private async write(roomId: string, input: ServerTaskActionInput, actorId: string, tenantId: string): Promise<{ event: SessionEvent; board: ChannelBoard }> {
    if (actionNeedsAgent.has(input.kind) && !input.agentId) throw new AeeisConflict('先选一位');
    if (actionNeedsReason.has(input.kind) && !input.reason) throw new AeeisConflict('请先写下原因');
    const room = await this.domain.getRoomForPrincipal(roomId, actorId, tenantId);
    if ((room.owner ?? 'owner') !== actorId) throw new AeeisConflict('只有房间主人可以改任务板');
    await this.domain.assertRoomEventWriter(roomId,actorId,tenantId);
    const previous = (await this.events.history(roomId,actorId,tenantId)).find(event => event.idempotencyKey === input.idempotencyKey);
    if (previous) {
      const action = previous.taskAction;
      if (action?.schemaVersion !== 'channel-task-action/1' || action.kind !== input.kind || action.conversationId !== input.conversationId || action.taskId !== input.taskId || action.agentId !== input.agentId || action.reason !== input.reason || previous.contextManifestId !== input.contextManifestId || previous.goalId !== input.goalId) throw new AeeisConflict('幂等键已用于其他动作');
      return { event: previous,board: await this.board(roomId,actorId,tenantId) };
    }
    const members = (await this.domain.listRoomMembers(roomId, actorId, tenantId)).filter(member => member.role === 'agent' && member.status === 'active');
    if (input.agentId && input.agentId !== 'aeeis' && !members.some(member => member.principalId === input.agentId)) throw new AeeisConflict('这位不在这个频道里');
    const before = await this.board(roomId, actorId, tenantId);
    const card = before.cards.find(item => item.conversationId === input.conversationId && item.taskId === input.taskId);
    if (!card) throw new AeeisNotFound('这件事不在这个频道的任务板上');
    if (input.kind === 'accept' && card.status !== 'succeeded') throw new AeeisConflict('只有已成功的事可以验收');
    if (input.agentId && (input.kind === 'assign' || input.kind === 'transfer' || input.kind === 'request_changes')) {
      const load = before.wip.find(item => item.agentId === input.agentId)?.count ?? 0;
      if (load >= WIP_LIMIT) throw new AeeisConflict(`${await this.nameOf(input.agentId, tenantId) ?? input.agentId}进行中已有 ${load} 件。先完成或转交。`);
    }
    const action: ChannelTaskAction = {
      schemaVersion: 'channel-task-action/1',
      boardVersion: (card.version ?? 0) + 1,
      ...(card.runId ? { observedRunId: card.runId,observedRunRevision: card.runRevision ?? 0 } : {}),
      kind: input.kind,
      conversationId: input.conversationId,
      taskId: input.taskId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.kind === 'accept' && card.runId ? { acceptedRunId: card.runId, acceptedRunBoundary: card.runBoundary ?? 0 } : {}),
    };
    const agentName = input.agentId ? await this.nameOf(input.agentId, tenantId) : undefined;
    // Names are read before the lock so the refusal can say who holds the task.
    const names = new Map<string, string>([['aeeis', 'AEEIS']]);
    await Promise.all(members.map(async member => names.set(member.principalId, await this.nameOf(member.principalId, tenantId).catch(() => undefined) ?? member.principalId)));
    const event = await this.events.createTaskAction(roomId, {
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      content: taskActionLine(action, agentName),
      contextManifestId: input.contextManifestId,
      evidenceRefs: [input.conversationId, input.taskId, ...(input.agentId ? [input.agentId] : [])],
      idempotencyKey: input.idempotencyKey,
      taskAction: action,
    }, actorId, tenantId, async written => {
      await this.domain.assertRoomEventWriter(roomId, actorId, tenantId);
      const decision = decisionFrom(written, action);
      if (input.kind === 'accept') {
        const latest = await this.readConversation(input.conversationId, actorId, tenantId);
        const task = latest?.tasks.find(task => task.id === input.taskId);
        if (task?.status !== 'succeeded' || (task.latestRunId ?? task.runId) !== card.runId) throw new AeeisConflict('Run 已变化，请刷新后验收');
        decision.accepted = decision.acceptedRunId === card.runId;
      }
      checkAction(action, decision, holder => names.get(holder) ?? holder);
      const currentBoard = await this.snapshot(roomId,actorId,tenantId,written);
      const current = currentBoard.cards.find(item => item.conversationId === input.conversationId && item.taskId === input.taskId);
      if (current?.version !== card.version) throw new AeeisConflict('任务已变化，请刷新');
      if (input.agentId && ['assign','transfer'].includes(input.kind) && (currentBoard.wip.find(item => item.agentId === input.agentId)?.count ?? 0) >= WIP_LIMIT) throw new AeeisConflict('进行中已有 3 件，先完成或转交');
    });
    return { event, board: await this.board(roomId, actorId, tenantId) };
  }

  private async conversations(history: readonly BoardEvent[], actorId: string, tenantId: string): Promise<Map<string, BoardConversationView | undefined>> {
    const ids = new Set<string>();
    for (const event of history) {
      const refs = event.evidenceRefs ?? [];
      const conversationId = refs.find(item => item.startsWith('conv_'));
      if (conversationId && refs.some(item => item.startsWith('task_'))) ids.add(conversationId);
    }
    const loaded = new Map<string, BoardConversationView | undefined>();
    await Promise.all([...ids].map(async conversationId => {
      try { loaded.set(conversationId, await this.readConversation(conversationId, actorId, tenantId)); }
      catch (error) {
        if (!(error instanceof AeeisNotFound || error instanceof AeeisConflict || (error instanceof Error && /unknown|not found/i.test(error.message)))) throw error;
        loaded.set(conversationId, undefined);
      }
    }));
    return loaded;
  }

  private async names(history: readonly SessionEvent[], tenantId: string): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const event of history) for (const ref of event.evidenceRefs) if (!ref.startsWith('conv_') && !ref.startsWith('task_')) ids.add(ref);
    const names = new Map<string, string>();
    await Promise.all([...ids].map(async agentId => { const name = await this.nameOf(agentId, tenantId).catch(() => undefined); if (name) names.set(agentId, name); }));
    return names;
  }
}

/** The task's decision from the events the repository handed the guard. */
function decisionFrom(events: readonly SessionEvent[], action: ChannelTaskAction): BoardDecision {
  const decision = emptyDecision();
  for (const event of events) {
    const existing = eventTaskAction(event);
    if (existing && existing.conversationId === action.conversationId && existing.taskId === action.taskId) applyTaskAction(decision, existing, event.content.trim());
  }
  return decision;
}

/** Rules that must hold at the moment of writing. */
function checkAction(action: ChannelTaskAction, decision: BoardDecision, holderName: (agentId: string) => string): void {
  if (decision.handedUp) throw new AeeisConflict('这件已经交给 AEEIS');
  switch (action.kind) {
    case 'claim':
      if (decision.assigneeId === action.agentId) throw new AeeisConflict('已经领取这件事');
      if (decision.assigneeId) throw new AeeisConflict(`${holderName(decision.assigneeId)}已领取`);
      return;
    case 'accept':
      if (decision.accepted) throw new AeeisConflict('这件已经验收');
      return;
    case 'unblock':
      if (decision.blockedNote === undefined) throw new AeeisConflict('这件没有阻塞说明');
      return;
    case 'restore':
      if (!decision.cancelled) throw new AeeisConflict('这件没有在频道里取消');
      return;
    case 'cancel':
      if (decision.cancelled) throw new AeeisConflict('这件已经在频道里取消');
      return;
    case 'propose':
      if (decision.proposedBy) throw new AeeisConflict('这件已经是提议');
      return;
    case 'adopt':
      if (!decision.proposedBy) throw new AeeisConflict('这件不是提议');
      if (decision.adopted) throw new AeeisConflict('这件已经采纳');
      if (decision.cancelled) throw new AeeisConflict('这件提议已经不要了');
      return;
    case 'offer':
      if (decision.cancelled) throw new AeeisConflict('这件已经在频道里取消');
      if (decision.offer) throw new AeeisConflict(`正在交给${holderName(decision.offer.to)}，先等结果`);
      if (decision.assigneeId && decision.assigneeId === action.agentId) throw new AeeisConflict(`已经在${holderName(action.agentId)}手上`);
      return;
    case 'decline':
      if (!decision.offer) throw new AeeisConflict('这件没有在交接');
      return;
    case 'transfer':
      if (decision.offer && decision.offer.to !== action.agentId) throw new AeeisConflict(`正在交给${holderName(decision.offer.to)}，先等结果`);
      return;
    default:
      return;
  }
}
