import { z } from 'zod';
import { AeeisConflict, AeeisNotFound, type AeeisService } from './application/aeeis-service.js';
import type { SessionEvent, SessionEventService } from './session-events.js';
import {
  WIP_LIMIT, actionNeedsAgent, channelTaskActionKindSchema, actionNeedsReason, emptyDecision, applyTaskAction, eventTaskAction, projectChannelBoard, taskActionLine, writableTaskActionKinds,
  type BoardConversationView, type BoardDecision, type ChannelBoard, type ChannelTaskAction,
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

/** Channel task board on the server. The room's session events are the fact
 * source; every rule is checked here, and the browser only sends intent. */
export class ChannelBoardService {
  constructor(
    private readonly events: SessionEventService,
    private readonly domain: AeeisService,
    private readonly readConversation: BoardConversationReader,
    private readonly nameOf: BoardNameReader = async () => undefined,
  ) {}

  async board(roomId: string, actorId: string, tenantId: string): Promise<ChannelBoard> {
    const history = await this.events.history(roomId, actorId, tenantId);
    const conversations = await this.conversations(history, actorId, tenantId);
    const names = await this.names(history, tenantId);
    return projectChannelBoard(roomId, history, conversations, agentId => names.get(agentId) ?? agentId);
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
      kind: input.kind,
      conversationId: input.conversationId,
      taskId: input.taskId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
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
    }, actorId, tenantId, written => checkAction(action, decisionFrom(written, action), holder => names.get(holder) ?? holder));
    return { event, board: await this.board(roomId, actorId, tenantId) };
  }

  private async conversations(history: readonly SessionEvent[], actorId: string, tenantId: string): Promise<Map<string, BoardConversationView | undefined>> {
    const ids = new Set<string>();
    for (const event of history) {
      const refs = event.evidenceRefs;
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
