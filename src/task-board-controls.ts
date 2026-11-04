import { z } from 'zod';
import type pg from 'pg';
import { boardColumn, boardColumnSchema, eventTaskAction, type BoardCard, type BoardEvent, type ChannelBoard } from './channel-task-action.js';
import type { AgentRun } from './runtime/contracts.js';
import type { SessionEvent } from './session-events.js';
import { AeeisConflict } from './application/aeeis-service.js';

export const boardControlInputSchema = z.object({
  kind: z.enum(['move', 'clear_override']), conversationId: z.string().regex(/^conv_[a-zA-Z0-9_.-]+$/), taskId: z.string().regex(/^task_[a-zA-Z0-9_.-]+$/),
  toColumn: boardColumnSchema.nullable(), expectedVersion: z.number().int().nonnegative(),
  expectedRunId: z.string().nullable(), expectedRunRevision: z.number().int().nonnegative().nullable(),
  reason: z.string().trim().min(1).max(4000), idempotencyKey: z.string().min(1).max(500),
  source: z.enum(['home', 'team']), goalId: z.string().optional(), contextManifestId: z.string().optional(),
}).strict();
export type BoardControlInput = z.infer<typeof boardControlInputSchema>;
export const authorityBoundary = (status: string) => !['discussion', 'preparing', 'queued', 'planning', 'running', 'reviewing'].includes(status);
/** Durable Run events catch a boundary crossed between two polling cycles too.
 * The watermark is a Run event sequence, never a timestamp or a writable status. */
export function runBoardBoundary(run: AgentRun): number {
  return run.events.reduce((last, event) => /^(?:plan\.(?:approval_requested|approved)|action\.(?:approval_requested|approved|denied)|input\.(?:requested|received)|run\.(?:paused|resumed|taken_over|handed_back|failed|cancelled|succeeded|partial|retry_requested|reconciled)|(?:tool|agent)\.(?:unknown|reconciled|requested)|model\.unknown)$/.test(event.type) ? Math.max(last, event.seq) : last, 0);
}
export function controlAction(events: readonly BoardEvent[], conversationId: string, taskId: string) {
  return events.map(event => ({ event, action: eventTaskAction(event) })).filter(item => item.action?.schemaVersion === 'channel-task-action/2' && item.action.conversationId === conversationId && item.action.taskId === taskId).at(-1);
}
export function boardControlVersion(events: readonly BoardEvent[], conversationId: string, taskId: string): number {
  let version = 0;
  for (const event of events) {
    const action = eventTaskAction(event);
    if (!action || action.conversationId !== conversationId || action.taskId !== taskId) continue;
    version = action.schemaVersion === 'channel-task-action/2' ? action.version : action.boardVersion ?? version + 1;
  }
  return version;
}
export function applyBoardControls(board: ChannelBoard, events: readonly BoardEvent[], canMove: boolean): ChannelBoard {
  for (const card of board.cards) {
    const latest = controlAction(events, card.conversationId, card.taskId);
    const action = latest?.action;
    card.autoColumn = boardColumn(card.status, card.decision, card.runId);
    card.version = boardControlVersion(events,card.conversationId,card.taskId);
    card.canMove = canMove && card.status !== 'unreadable' && !card.decision.cancelled;
    if (action?.schemaVersion !== 'channel-task-action/2') continue;
    const sameRun = action.expectedRunId === (card.runId ?? null);
    const sameBoundary = action.runBoundary === (card.runBoundary ?? 0);
    const laterLegacy = events.some(event => (event.sequence ?? 0) > (latest?.event.sequence ?? 0) && event.taskAction?.schemaVersion === 'channel-task-action/1' && event.taskAction.conversationId === card.conversationId && event.taskAction.taskId === card.taskId && ['accept', 'request_changes', 'cancel', 'restore'].includes(event.taskAction.kind));
    if (!sameRun || !sameBoundary || laterLegacy) continue;
    // An explicit review also revokes a prior v1 acceptance for this Run.
    if (card.status === 'succeeded' && action.kind === 'move' && ['review', 'done'].includes(action.toColumn ?? '')) {
      card.column = action.toColumn as 'review' | 'done';
      card.decision.accepted = action.toColumn === 'done';
      if (card.decision.accepted && card.runId) card.decision.acceptedRunId = card.runId;
    } else if (!authorityBoundary(card.status) && action.kind === 'move' && action.toColumn) {
      card.column = action.toColumn; card.override = true;
    }
  }
  const loads = new Map<string, number>();
  for (const card of board.cards) if ((card.column === 'doing' || ['planning','running','reviewing'].includes(card.status)) && card.ownerId) loads.set(card.ownerId, (loads.get(card.ownerId) ?? 0) + 1);
  board.wip = [...loads].map(([agentId, count]) => ({ agentId, count }));
  board.version = JSON.stringify(board.cards.map(card => [card.conversationId, card.taskId, card.version, card.runId ?? null, card.runRevision ?? null, card.column]));
  return board;
}
export function assertBoardMove(card: BoardCard, input: BoardControlInput, board: ChannelBoard): void {
  if (!card.canMove) throw new AeeisConflict('这件事不可移动，请刷新或确认权限');
  if (card.version !== input.expectedVersion || (card.runId ?? null) !== input.expectedRunId || (card.runRevision ?? null) !== input.expectedRunRevision) throw new AeeisConflict('任务或 Run 已变化，请刷新任务板后重试');
  if (input.kind === 'clear_override') { if (input.toColumn !== null) throw new AeeisConflict('恢复自动列不接受目标列'); return; }
  const to = input.toColumn;
  if (!to || to === 'failed') throw new AeeisConflict('不能手动制造失败结果');
  if (card.status === 'succeeded') {
    if (!['review', 'done'].includes(to)) throw new AeeisConflict('成功的 Run 只能验收或撤销验收');
    return;
  }
  if (authorityBoundary(card.status)) throw new AeeisConflict('请先处理批准、问题、暂停或失败，不能用移动隐藏执行状态');
  if (['review', 'done'].includes(to)) throw new AeeisConflict('只有当前 Run 成功后才可验收');
  if (card.runId && ['capture', 'ready'].includes(to) && card.status !== 'queued') throw new AeeisConflict('Run 正在执行；请先明确暂停，移动不会停止执行');
  if (to === 'doing' && card.column !== 'doing' && !['planning','running','reviewing'].includes(card.status) && card.ownerId && (board.wip.find(item => item.agentId === card.ownerId)?.count ?? 0) >= 3) throw new AeeisConflict('进行中已有 3 件，先完成或转交');
}
/** Called by the SessionEvent repository INSIDE its Room transaction, after
 * the immutable audit insert. Failure rolls both back. Lock order: Room → control. */
export async function persistBoardAction(client: pg.PoolClient, event: SessionEvent): Promise<void> {
  const action = event.taskAction;
  if (!action) return;
  if (action.schemaVersion === 'channel-task-action/1') {
    if (action.boardVersion === undefined || !(await client.query("SELECT to_regclass('aeeis_task_board_controls') AS name")).rows[0]?.name) return;
    await client.query(`INSERT INTO aeeis_task_board_controls(tenant_id,owner,room_id,conversation_id,task_id,version,observed_run_id,observed_run_revision,accepted_run_id,last_action_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(tenant_id,owner,room_id,conversation_id,task_id) DO UPDATE SET version=EXCLUDED.version,
        observed_run_id=EXCLUDED.observed_run_id,observed_run_revision=EXCLUDED.observed_run_revision,
        accepted_run_id=CASE WHEN $11 IN ('accept','request_changes','cancel','restore') THEN EXCLUDED.accepted_run_id ELSE aeeis_task_board_controls.accepted_run_id END,
        override_column=CASE WHEN $11 IN ('accept','request_changes','cancel','restore') THEN NULL ELSE aeeis_task_board_controls.override_column END,
        last_action_event_id=EXCLUDED.last_action_event_id,updated_at=now() WHERE aeeis_task_board_controls.version < EXCLUDED.version`,
      [event.tenantId,event.owner,event.roomId,action.conversationId,action.taskId,action.boardVersion,action.observedRunId ?? null,action.observedRunRevision ?? (action.observedRunId ? 0 : null),action.acceptedRunId ?? null,event.id,action.kind]);
    return;
  }
  const accepted = action.kind === 'move' && action.toColumn === 'done' ? action.expectedRunId : null;
  const override = action.kind === 'move' && !['done', 'review'].includes(action.toColumn ?? '') ? action.toColumn : null;
  await client.query(`INSERT INTO aeeis_task_board_controls
    (tenant_id,owner,room_id,conversation_id,task_id,version,observed_run_id,observed_run_revision,override_column,accepted_run_id,last_action_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT(tenant_id,owner,room_id,conversation_id,task_id) DO UPDATE SET version=EXCLUDED.version,
      observed_run_id=EXCLUDED.observed_run_id,observed_run_revision=EXCLUDED.observed_run_revision,
      override_column=EXCLUDED.override_column,accepted_run_id=EXCLUDED.accepted_run_id,last_action_event_id=EXCLUDED.last_action_event_id,updated_at=now()
      WHERE aeeis_task_board_controls.version < EXCLUDED.version`,
  [event.tenantId, event.owner, event.roomId, action.conversationId, action.taskId, action.version, action.expectedRunId, action.expectedRunRevision, override, accepted, event.id]);
}
