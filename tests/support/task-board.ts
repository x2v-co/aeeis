import { AeeisService } from '../../src/application/aeeis-service.js';
import { InMemoryStore } from '../../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../../src/room-membership.js';
import { SessionEventService, type SessionEventRepository } from '../../src/session-events.js';
import { ChannelBoardService } from '../../src/channel-board.js';
import type { TaskBoardStore } from '../../src/adapters/task-board-store.js';
import type { BoardConversationView } from '../../src/channel-task-action.js';
import { randomUUID } from 'node:crypto';
export const scope = { owner: 'alice', tenantId: 'team-a' };
export async function taskBoardFixture(repository: SessionEventRepository, controls: TaskBoardStore) {
  await repository.init?.(); await controls.init();
  const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
  const room = await domain.createRoom({ title: '真实任务板' },undefined,scope.owner,scope.tenantId);
  const goal = await domain.createGoal({ title: '真实任务',roomId: room.id },undefined,scope.owner,scope.tenantId);
  const manifest = await domain.createContextManifest(goal.id,{ purpose: '测试任务板',audienceMode: 'room' },undefined,scope.owner,scope.tenantId);
  const events = new SessionEventService(repository,domain);
  const conversation: BoardConversationView = { id: 'conv_test',agentId: 'aeeis',tasks: [{ id: 'task_test',title: '整理报告',status: 'running',runId: `run_${randomUUID()}`,runRevision: 1,runBoundary: 0 }] };
  const read = async (id: string, actor: string, tenant: string) => id === conversation.id && actor === scope.owner && tenant === scope.tenantId ? structuredClone(conversation) : undefined;
  const board = new ChannelBoardService(events,domain,read,undefined,controls);
  await events.create(room.id,{ goalId: goal.id,type: 'system',content: '真实任务引用',evidenceRefs: [conversation.id,'task_test','aeeis'],contextManifestId: manifest.id,idempotencyKey: 'cite' },scope.owner,scope.tenantId);
  const get = () => board.board(room.id,scope.owner,scope.tenantId);
  const input = async (toColumn: string | null, extra: Record<string,unknown> = {}) => {
    const card = (await get()).cards[0]!;
    return { kind: toColumn === null ? 'clear_override' : 'move',conversationId: conversation.id,taskId: 'task_test',toColumn,
      expectedVersion: card.version,expectedRunId: card.runId ?? null,expectedRunRevision: card.runRevision ?? null,
      reason: '主人调整安排',idempotencyKey: randomUUID(),source: 'team',goalId: goal.id,contextManifestId: manifest.id,...extra };
  };
  const move = async (toColumn: string | null) => board.move(room.id,await input(toColumn),scope.owner,scope.tenantId);
  return { repository,controls,domain,room,goal,manifest,events,conversation,read,board,get,input,move,
    task: conversation.tasks[0]!,close: async () => { await repository.close(); await controls.close(); } };
}
