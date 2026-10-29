import { AeeisConflict, AeeisNotFound, type AeeisService } from './application/aeeis-service.js';
import { ConversationService } from './application/conversation-service.js';
import type { ConversationStore, ConversationTask } from './conversations.js';
import { OwnedBotConflict } from './owned-bots.js';
import { RoomMembershipConflict } from './room-membership.js';
import { isTerminalRun } from './runtime/run-reconcile.js';
import { NotFound, type RunRepository } from './runtime/repository.js';
import type { Ownership } from './security/principal.js';
import type { SessionEventService } from './session-events.js';
import { eventTaskAction } from './channel-task-action.js';

const citationId = /^[a-z][a-z0-9_.-]{1,127}$/;
const ENTRY_AGENT = 'aeeis';

export interface ReleasedBotTask { id: string; title: string; entryConversationId: string; entryTaskId: string }

/** Work that still needs a person is written onto AEEIS. The original task stays
 * where it was. A Run that is still on record and still going blocks removal.
 * A later hierarchy hangs this upward; AEEIS is the parent for now. */
export async function releaseHeldBotTasks(input: {
  botId: string;
  botName: string;
  scope: Ownership;
  conversations?: ConversationStore;
  conversation?: ConversationService;
  domain?: AeeisService;
  sessionEvents?: SessionEventService;
  runs?: RunRepository;
}): Promise<ReleasedBotTask[]> {
  if (!input.conversations || !input.conversation) return [];
  const life = (await input.conversations.list(input.scope)).find(item => item.agentId === input.botId);
  if (!life) return [];
  const running: string[] = [];
  const held: ConversationTask[] = [];
  for (const task of life.tasks) {
    if (!task.latestRunId) { held.push(task); continue; }
    if (!input.runs) { running.push(task.title); continue; }
    try {
      if (!isTerminalRun(await input.runs.get(task.latestRunId, input.scope))) running.push(task.title);
    } catch (error) {
      if (error instanceof NotFound) held.push(task);
      else running.push(task.title);
    }
  }
  if (running.length) throw new OwnedBotConflict(`先停下或转交正在做的事：${running.join('、')}。`);
  if (!held.length) return [];
  const cancelledInRoom = new Map<string, Set<string>>();
  const pending = input.domain && input.sessionEvents
    ? await tasksStillNeedingAPerson(held, input.botId, life.id, input.scope, input.domain, input.sessionEvents, cancelledInRoom)
    : held;
  if (!pending.length) return [];
  const entry = await input.conversation.create({ title: 'AEEIS', agentId: ENTRY_AGENT }, input.scope);
  const released: ReleasedBotTask[] = [];
  for (const task of pending) {
    const title = task.title.trim().slice(0, 180);
    const entryTitle = title.length >= 2 ? title : '接手的事';
    const posted = await input.conversation.post(entry.id, {
      text: `「${input.botName}」已撤下。这件事交给入口：${task.title}`.slice(0, 7000),
      expectedRevision: 0,
      newTask: { title: entryTitle },
      focus: 'keep',
      intent: 'discuss',
    }, input.scope, `bot-hold.${input.botId}.${task.id}`.slice(0, 256), false);
    const entryTaskId = posted.message.route.taskIds[0];
    if (!entryTaskId) throw new OwnedBotConflict('入口没有记下这件事。');
    released.push({ id: task.id, title: task.title, entryConversationId: entry.id, entryTaskId });
  }
  if (input.domain && input.sessionEvents) {
    const roomIds = await input.domain.activeRoomIdsFor(input.botId, input.scope.tenantId);
    for (const roomId of roomIds) {
      try {
        await handTasksUpInRoom(roomId, input.botId, life.id, released, cancelledInRoom.get(roomId) ?? new Set(), input.scope, input.sessionEvents);
      } catch (error) {
        if (!(error instanceof AeeisNotFound || error instanceof AeeisConflict || error instanceof RoomMembershipConflict)) throw error;
      }
    }
  }
  return released;
}

/** A channel cancel lives on the room, not on the task. Skip a task only when
 * every room that cites it still has that cancel, and the room owner has not
 * taken it back. A missing Run still needs a person. */
async function tasksStillNeedingAPerson(held: readonly ConversationTask[], botId: string, lifeId: string, scope: Ownership, domain: AeeisService, sessionEvents: SessionEventService, cancelledInRoom: Map<string, Set<string>>): Promise<ConversationTask[]> {
  const roomIds = await domain.activeRoomIdsFor(botId, scope.tenantId);
  const citedRooms = new Map<string, Set<string>>();
  let unreadable = false;
  for (const roomId of roomIds) {
    try {
      const mark = await channelMark(roomId, lifeId, new Set(held.map(task => task.id)), scope, sessionEvents);
      cancelledInRoom.set(roomId, mark.cancelled);
      for (const taskId of mark.cited) {
        const rooms = citedRooms.get(taskId) ?? new Set<string>();
        rooms.add(roomId);
        citedRooms.set(taskId, rooms);
      }
    } catch (error) {
      if (!(error instanceof AeeisNotFound || error instanceof AeeisConflict || error instanceof RoomMembershipConflict)) throw error;
      unreadable = true;
    }
  }
  if (unreadable) return [...held];
  return held.filter(task => {
    if (task.latestRunId) return true;
    const rooms = citedRooms.get(task.id);
    const cancelled = rooms ? [...rooms].filter(roomId => cancelledInRoom.get(roomId)?.has(task.id)) : [];
    return !rooms || cancelled.length < rooms.size;
  });
}

async function channelMark(roomId: string, lifeId: string, taskIds: ReadonlySet<string>, scope: Ownership, sessionEvents: SessionEventService): Promise<{ cited: Set<string>; cancelled: Set<string> }> {
  const cited = new Set<string>();
  const cancelled = new Set<string>();
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const result = await sessionEvents.page(roomId, scope.owner, scope.tenantId, 200, after);
    for (const event of result.items) {
      if (event.operation === 'retract') continue;
      const taskId = event.evidenceRefs.find(id => taskIds.has(id));
      const conversationId = event.evidenceRefs.find(id => id.startsWith('conv_') && citationId.test(id));
      if (!taskId || conversationId !== lifeId) continue;
      cited.add(taskId);
      const action = eventTaskAction(event);
      if (!action || action.taskId !== taskId || action.conversationId !== lifeId) continue;
      if (action.kind === 'cancel') cancelled.add(taskId);
      else if (action.kind === 'restore' || action.kind === 'assign' || action.kind === 'transfer') cancelled.delete(taskId);
    }
    if (!result.nextCursor) return { cited, cancelled };
    const next = Number(result.nextCursor);
    if (!Number.isInteger(next) || next <= after) return { cited, cancelled };
    after = next;
  }
  return { cited, cancelled };
}

async function handTasksUpInRoom(roomId: string, botId: string, lifeId: string, tasks: readonly ReleasedBotTask[], holdBack: ReadonlySet<string>, scope: Ownership, sessionEvents: SessionEventService): Promise<void> {
  const handed = new Set<string>();
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const result = await sessionEvents.page(roomId, scope.owner, scope.tenantId, 200, after);
    for (const event of result.items) {
      if (event.operation === 'retract') continue;
      const refs = event.evidenceRefs;
      const taskId = refs.find(id => id.startsWith('task_') && citationId.test(id));
      if (!taskId || handed.has(taskId)) continue;
      const action = eventTaskAction(event);
      if (action?.kind === 'hand_up') {
        if (tasks.some(task => task.id === action.taskId)) handed.add(action.taskId);
        continue;
      }
      if (!refs.includes(botId)) continue;
      const conversationId = refs.find(id => id.startsWith('conv_') && citationId.test(id));
      const task = tasks.find(item => item.id === taskId);
      if (!task || conversationId !== lifeId || holdBack.has(task.id)) continue;
      handed.add(task.id);
      await sessionEvents.createTaskAction(roomId, {
        ...(event.goalId === undefined ? {} : { goalId: event.goalId }),
        type: 'system',
        content: `已交给AEEIS，记为讨论「${task.title}」。原来的事还在。`,
        contextManifestId: event.contextManifestId,
        evidenceRefs: [task.entryConversationId, task.entryTaskId, ENTRY_AGENT, lifeId, task.id],
        idempotencyKey: `bot-up.${botId}.${task.id}.${roomId}`.slice(0, 500),
        taskAction: { schemaVersion: 'channel-task-action/1', kind: 'hand_up', conversationId: lifeId, taskId: task.id, agentId: ENTRY_AGENT },
      }, scope.owner, scope.tenantId, () => undefined);
    }
    if (!result.nextCursor) return;
    const next = Number(result.nextCursor);
    if (!Number.isInteger(next) || next <= after) return;
    after = next;
  }
}
