import { AeeisConflict, AeeisNotFound, type AeeisService } from './application/aeeis-service.js';
import { ConversationService } from './application/conversation-service.js';
import type { ConversationStore, ConversationTask } from './conversations.js';
import { OwnedBotConflict } from './owned-bots.js';
import { RoomMembershipConflict } from './room-membership.js';
import { isTerminalRun } from './runtime/run-reconcile.js';
import { NotFound, type RunRepository } from './runtime/repository.js';
import type { Ownership } from './security/principal.js';
import type { SessionEventService } from './session-events.js';

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
  const entry = await input.conversation.create({ title: 'AEEIS', agentId: ENTRY_AGENT }, input.scope);
  const released: ReleasedBotTask[] = [];
  for (const task of held) {
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
        await handTasksUpInRoom(roomId, input.botId, life.id, released, input.scope, input.sessionEvents);
      } catch (error) {
        if (!(error instanceof AeeisNotFound || error instanceof AeeisConflict || error instanceof RoomMembershipConflict)) throw error;
      }
    }
  }
  return released;
}

async function handTasksUpInRoom(roomId: string, botId: string, lifeId: string, tasks: readonly ReleasedBotTask[], scope: Ownership, sessionEvents: SessionEventService): Promise<void> {
  const handed = new Set<string>();
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const result = await sessionEvents.page(roomId, scope.owner, scope.tenantId, 200, after);
    for (const event of result.items) {
      if (event.operation === 'retract') continue;
      const refs = event.evidenceRefs;
      const taskId = refs.find(id => id.startsWith('task_') && citationId.test(id));
      if (!taskId || handed.has(taskId)) continue;
      if (event.content.startsWith('已交给AEEIS') && tasks.some(task => refs.includes(task.id))) {
        for (const task of tasks) if (refs.includes(task.id)) handed.add(task.id);
        continue;
      }
      if (!refs.includes(botId)) continue;
      const conversationId = refs.find(id => id.startsWith('conv_') && citationId.test(id));
      const task = tasks.find(item => item.id === taskId);
      if (!task || conversationId !== lifeId) continue;
      handed.add(task.id);
      await sessionEvents.create(roomId, {
        ...(event.goalId === undefined ? {} : { goalId: event.goalId }),
        type: 'system',
        content: `已交给AEEIS，记为讨论「${task.title}」。原来的事还在。`,
        contextManifestId: event.contextManifestId,
        evidenceRefs: [task.entryConversationId, task.entryTaskId, ENTRY_AGENT, lifeId, task.id],
        idempotencyKey: `bot-up.${botId}.${task.id}.${roomId}`.slice(0, 500),
      }, scope.owner, scope.tenantId);
    }
    if (!result.nextCursor) return;
    const next = Number(result.nextCursor);
    if (!Number.isInteger(next) || next <= after) return;
    after = next;
  }
}
