import { AeeisConflict, AeeisNotFound, type AeeisService } from './application/aeeis-service.js';
import type { ConversationStore, ConversationTask } from './conversations.js';
import { OwnedBotConflict } from './owned-bots.js';
import { RoomMembershipConflict } from './room-membership.js';
import { isTerminalRun } from './runtime/run-reconcile.js';
import type { RunRepository } from './runtime/repository.js';
import type { Ownership } from './security/principal.js';
import type { SessionEventService } from './session-events.js';

const citationId = /^[a-z][a-z0-9_.-]{1,127}$/;

export interface ReleasedBotTask { id: string; title: string }

/** Open discussion on this Bot goes back to 待领取. A Run that is still
 * going stays where it is, and removal waits until that work is stopped or handed on. */
export async function releaseHeldBotTasks(input: {
  botId: string;
  scope: Ownership;
  conversations?: ConversationStore;
  domain?: AeeisService;
  sessionEvents?: SessionEventService;
  runs?: RunRepository;
}): Promise<ReleasedBotTask[]> {
  if (!input.conversations) return [];
  const life = (await input.conversations.list(input.scope)).find(item => item.agentId === input.botId);
  if (!life) return [];
  const running: string[] = [];
  const open: ConversationTask[] = [];
  for (const task of life.tasks) {
    if (!task.latestRunId) { open.push(task); continue; }
    let terminal = false;
    if (input.runs) {
      try { terminal = isTerminalRun(await input.runs.get(task.latestRunId, input.scope)); }
      catch { terminal = false; }
    }
    if (!terminal) running.push(task.title);
  }
  if (running.length) throw new OwnedBotConflict(`先停下或转交正在做的事：${running.join('、')}。`);
  if (open.length && input.domain && input.sessionEvents) {
    const roomIds = await input.domain.activeRoomIdsFor(input.botId, input.scope.tenantId);
    for (const roomId of roomIds) {
      try {
        await returnTasksInRoom(roomId, input.botId, life.id, open, input.scope, input.sessionEvents);
      } catch (error) {
        if (!(error instanceof AeeisNotFound || error instanceof AeeisConflict || error instanceof RoomMembershipConflict)) throw error;
      }
    }
  }
  return open.map(task => ({ id: task.id, title: task.title }));
}

async function returnTasksInRoom(roomId: string, botId: string, lifeId: string, tasks: readonly ConversationTask[], scope: Ownership, sessionEvents: SessionEventService): Promise<void> {
  const returned = new Set<string>();
  let after = 0;
  for (let page = 0; page < 50; page += 1) {
    const result = await sessionEvents.page(roomId, scope.owner, scope.tenantId, 200, after);
    for (const event of result.items) {
      if (event.operation === 'retract') continue;
      const refs = event.evidenceRefs;
      const taskId = refs.find(id => id.startsWith('task_') && citationId.test(id));
      if (!taskId || returned.has(taskId)) continue;
      if (event.type === 'task_update' && event.content.startsWith('退回待领取')) { returned.add(taskId); continue; }
      if (!refs.includes(botId)) continue;
      const conversationId = refs.find(id => id.startsWith('conv_') && citationId.test(id));
      const task = tasks.find(item => item.id === taskId);
      if (!task || conversationId !== lifeId) continue;
      returned.add(taskId);
      await sessionEvents.create(roomId, {
        ...(event.goalId === undefined ? {} : { goalId: event.goalId }),
        type: 'task_update',
        content: `退回待领取：${task.title}`,
        contextManifestId: event.contextManifestId,
        evidenceRefs: [lifeId, taskId],
        idempotencyKey: `bot-return.${botId}.${taskId}.${roomId}`.slice(0, 500),
      }, scope.owner, scope.tenantId);
    }
    if (!result.nextCursor) return;
    const next = Number(result.nextCursor);
    if (!Number.isInteger(next) || next <= after) return;
    after = next;
  }
}
