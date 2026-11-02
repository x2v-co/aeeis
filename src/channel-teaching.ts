import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AeeisConflict, AeeisNotFound, type AeeisService } from './application/aeeis-service.js';
import type { SessionEvent, SessionEventService } from './session-events.js';
import type { ChannelBoardService } from './channel-board.js';
import { automaticKey, eventTaskAction, taskActionLine, type ChannelTaskActionKind } from './channel-task-action.js';
import type { AgentRun } from './runtime/contracts.js';
import type { Ownership } from './security/principal.js';

/**
 * Interaction-design §8.7, "watch me do it once". A teaching is a window of the group's own events, opened and closed
 * by two markers the server writes. The draft is read back from what happened inside it: the owner's messages and
 * task actions, and the plan steps, tools and decisions of the Runs those tasks started. Adopting the draft makes a
 * routine for that one Bot that starts only when asked; revoking deletes it. Nothing is copied out of the room, so the
 * record stays as replayable and as private as the room.
 */
export interface TeachingStep { at: string; text: string; source: 'message' | 'action' | 'run'; decision: boolean }
export interface TeachingDraft { steps: TeachingStep[]; decisions: string[]; tools: string[]; prompt: string; executionReview: 'required' | 'auto' }
export interface Teaching {
  id: string;
  agentId: string;
  agentName: string;
  startedAt: string;
  state: 'recording' | 'recorded' | 'adopted' | 'revoked';
  stoppedAt?: string;
  routineId?: string;
  draft?: TeachingDraft;
}
export interface TeachingRoutines {
  create(input: unknown, scope: Ownership): Promise<{ routine: { id: string } }>;
  remove(id: string, scope: Ownership): Promise<void>;
}
export interface ChannelTeachingOptions {
  events: SessionEventService;
  domain: AeeisService;
  board: ChannelBoardService;
  readRun: (runId: string, scope: Ownership) => Promise<AgentRun | undefined>;
  nameOf: (agentId: string, tenantId: string) => Promise<string | undefined>;
  routines?: TeachingRoutines;
}

const MAX_STEPS = 30;
const teachingId = z.string().regex(/^teach_[a-f0-9-]{36}$/);
export const adoptTeachingSchema = z.object({
  name: z.string().trim().min(1, '先给例程起个名字').max(80),
  prompt: z.string().trim().min(1).max(4000).optional(),
  executionReview: z.enum(['required', 'auto', 'yolo']).optional(),
}).strict();
/** Task actions that are a person's judgement, not just moving work along. */
const DECIDING: ReadonlySet<ChannelTaskActionKind> = new Set(['accept', 'request_changes', 'block', 'unblock', 'cancel', 'refuse']);
/** Run events that record a person's decision. */
const HUMAN_DECISIONS = new Set(['plan.approved', 'plan.revision_requested', 'action.approved', 'action.denied', 'input.received', 'run.taken_over']);
const marker = (kind: 'start' | 'stop' | 'adopt' | 'revoke', id: string) => `teach-${kind}:${id}`;
const clip = (text: string, length: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > length ? `${flat.slice(0, length)}…` : flat; };

export class ChannelTeachingService {
  constructor(private readonly options: ChannelTeachingOptions) {}

  async list(roomId: string, scope: Ownership): Promise<Teaching[]> {
    const room = await this.ownedRoom(roomId, scope);
    const history = await this.options.events.history(room.id, scope.owner, scope.tenantId);
    const teachings: Teaching[] = [];
    for (const start of history.filter(event => event.idempotencyKey.startsWith('teach-start:'))) {
      const id = start.idempotencyKey.slice('teach-start:'.length);
      const find = (kind: 'stop' | 'adopt' | 'revoke') => history.find(event => event.idempotencyKey === marker(kind, id));
      const stop = find('stop'), adopt = find('adopt'), revoke = find('revoke');
      const agentId = start.evidenceRefs[0] ?? '';
      const teaching: Teaching = {
        id, agentId, agentName: await this.name(agentId, scope), startedAt: start.createdAt,
        state: revoke ? 'revoked' : adopt ? 'adopted' : stop ? 'recorded' : 'recording',
        ...(stop ? { stoppedAt: stop.createdAt } : {}),
        ...(adopt?.evidenceRefs[1] ? { routineId: adopt.evidenceRefs[1] } : {}),
      };
      if (stop && !revoke) teaching.draft = await this.draft(room.title, teaching.agentName, history.filter(event => event.sequence > start.sequence && event.sequence < stop.sequence && event.operation === 'publish'), { from: start.createdAt, to: stop.createdAt }, room.id, scope);
      teachings.push(teaching);
    }
    return teachings.reverse();
  }

  async start(roomId: string, raw: unknown, scope: Ownership): Promise<Teaching> {
    const { agentId } = z.object({ agentId: z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,127}$/) }).strict().parse(raw);
    const room = await this.ownedRoom(roomId, scope);
    const members = await this.options.domain.listRoomMembers(room.id, scope.owner, scope.tenantId);
    if (agentId !== 'aeeis' && !members.some(member => member.principalId === agentId && member.role === 'agent' && member.status === 'active')) throw new AeeisConflict('只能教给这个群里的 Bot');
    if ((await this.list(roomId, scope)).some(item => item.state === 'recording')) throw new AeeisConflict('这个群里已经在录一段示范，先结束它');
    const id = `teach_${randomUUID()}`;
    const name = await this.name(agentId, scope);
    await this.write(room.id, scope, `开始示范：教给${name}。接下来你在这个群里做的事会记下来，结束后生成例程草案。`, marker('start', id), [agentId]);
    return (await this.list(roomId, scope)).find(item => item.id === id)!;
  }

  async stop(roomId: string, id: string, scope: Ownership): Promise<Teaching> {
    const teaching = await this.get(roomId, id, scope);
    if (teaching.state !== 'recording') throw new AeeisConflict('这段示范已经结束');
    await this.write(roomId, scope, `示范结束：教给${teaching.agentName}。草案在「带教」里，看过再收成例程。`, marker('stop', id), [teaching.agentId]);
    return this.get(roomId, id, scope);
  }

  async adopt(roomId: string, id: string, raw: unknown, scope: Ownership): Promise<Teaching> {
    const input = adoptTeachingSchema.parse(raw);
    if (!this.options.routines) throw new AeeisConflict('例程没有配置，草案先留在带教里');
    const teaching = await this.get(roomId, id, scope);
    if (teaching.state !== 'recorded' || !teaching.draft) throw new AeeisConflict(teaching.state === 'recording' ? '先结束示范' : '这段示范已经收过或撤销了');
    if (!teaching.draft.steps.length) throw new AeeisConflict('这段示范里没有记下步骤');
    const { routine } = await this.options.routines.create({
      agentId: teaching.agentId, name: input.name, prompt: input.prompt ?? teaching.draft.prompt, trigger: { kind: 'manual' }, executionReview: input.executionReview ?? teaching.draft.executionReview,
    }, scope);
    await this.write(roomId, scope, `带教收成例程「${input.name}」，交给${teaching.agentName}。叫它时才做，只影响这一位。`, marker('adopt', id), [teaching.agentId, routine.id]);
    return this.get(roomId, id, scope);
  }

  async revoke(roomId: string, id: string, raw: unknown, scope: Ownership): Promise<Teaching> {
    const { reason } = z.object({ reason: z.string().trim().min(1, '写下撤销的原因').max(500) }).strict().parse(raw);
    const teaching = await this.get(roomId, id, scope);
    if (teaching.state === 'revoked') return teaching;
    if (teaching.state === 'recording') throw new AeeisConflict('先结束示范');
    if (teaching.routineId && this.options.routines) {
      await this.options.routines.remove(teaching.routineId, scope).catch(error => { if (!(error instanceof Error && /Unknown routine/.test(error.message))) throw error; });
    }
    await this.write(roomId, scope, `撤销带教：${reason}${teaching.routineId ? '。收成的例程已删除。' : ''}`, marker('revoke', id), [teaching.agentId]);
    return this.get(roomId, id, scope);
  }

  private async get(roomId: string, id: string, scope: Ownership): Promise<Teaching> {
    teachingId.parse(id);
    const teaching = (await this.list(roomId, scope)).find(item => item.id === id);
    if (!teaching) throw new AeeisNotFound('Unknown teaching');
    return teaching;
  }

  /** Only the room owner teaches: the routine it makes is the owner's. */
  private async ownedRoom(roomId: string, scope: Ownership) {
    const room = await this.options.domain.getRoomForPrincipal(roomId, scope.owner, scope.tenantId);
    if (room.chat !== 'group') throw new AeeisConflict('带教只在群聊里');
    if ((room.owner ?? 'owner') !== scope.owner) throw new AeeisConflict('只有群主能带教');
    return room;
  }

  private async name(agentId: string, scope: Ownership): Promise<string> {
    if (agentId === 'aeeis') return 'AEEIS';
    return await this.options.nameOf(agentId, scope.tenantId).catch(() => undefined) ?? agentId;
  }

  private async write(roomId: string, scope: Ownership, content: string, key: string, refs: string[]): Promise<SessionEvent> {
    const room = await this.options.domain.getRoomForPrincipal(roomId, scope.owner, scope.tenantId);
    const goals = await this.options.domain.listGoalsInRoomForPrincipal(room.id, scope.owner, scope.tenantId);
    const now = new Date().toISOString();
    const goal = (goals.find(item => item.status === 'active') ?? goals[0])?.id ?? (await this.options.domain.createGoal({ title: room.title, roomId: room.id }, now, scope.owner, scope.tenantId)).id;
    const manifest = (await this.options.domain.createContextManifest(goal, { purpose: '群聊消息', audienceMode: 'room' }, now, scope.owner, scope.tenantId)).id;
    return this.options.events.create(room.id, { goalId: goal, type: 'system', content, contextManifestId: manifest, evidenceRefs: refs, idempotencyKey: key }, scope.owner, scope.tenantId);
  }

  private async draft(roomTitle: string, agentName: string, window: readonly SessionEvent[], span: { from: string; to: string }, roomId: string, scope: Ownership): Promise<TeachingDraft> {
    const steps: TeachingStep[] = [];
    const tools = new Set<string>();
    const cited = new Set<string>();
    for (const event of window) {
      const refs = event.evidenceRefs;
      const conversationId = refs.find(ref => ref.startsWith('conv_')), taskId = refs.find(ref => ref.startsWith('task_'));
      if (conversationId && taskId) cited.add(`${conversationId}:${taskId}`);
      if (automaticKey(event.idempotencyKey) || event.actorType !== 'principal') continue;
      if (event.type === 'message') { steps.push({ at: event.createdAt, text: clip(event.content, 300), source: 'message', decision: false }); continue; }
      const action = eventTaskAction(event);
      if (action && !['propose', 'offer', 'decline', 'hand_up'].includes(action.kind)) {
        const name = action.agentId ? await this.name(action.agentId, scope) : undefined;
        steps.push({ at: event.createdAt, text: clip(taskActionLine(action, name), 300), source: 'action', decision: DECIDING.has(action.kind) });
      }
    }
    // The group's Runs: a task cited in the window shows how the work was done; a decision made during the window is where
    // a person stepped in, even on a task cited earlier (an approval is written on the Run, not in the room).
    const during = (at: string) => at >= span.from && at <= span.to;
    const board = await this.options.board.board(roomId, scope.owner, scope.tenantId);
    for (const card of board.cards) {
      if (!card.runId) continue;
      const run = await this.options.readRun(card.runId, scope).catch(() => undefined);
      if (!run) continue;
      const decided = run.events.some(event => during(event.at) && HUMAN_DECISIONS.has(event.type));
      if (!cited.has(`${card.conversationId}:${card.taskId}`) && !decided) continue;
      const plan = run.plans.at(-1);
      for (const event of run.events) {
        if (!during(event.at)) continue;
        const text = event.type === 'plan.approved' ? `批准「${card.title ?? '这件事'}」的计划`
          : event.type === 'plan.revision_requested' ? `打回「${card.title ?? '这件事'}」的计划：${String(event.data.reason ?? '')}`
          : event.type === 'action.approved' || event.type === 'action.denied' ? `${event.type === 'action.approved' ? '允许' : '拒绝'}动作 ${String(event.data.ref ?? '')}`
          : event.type === 'run.taken_over' ? `接手「${card.title ?? '这件事'}」做了一段` : undefined;
        if (text) steps.push({ at: event.at, text: clip(text, 300), source: 'run', decision: true });
      }
      // Each answer was recorded with one `input.received`, in the same order.
      run.events.filter(event => event.type === 'input.received').forEach((event, index) => {
        const answer = run.answers[index];
        if (answer && during(event.at)) steps.push({ at: event.at, text: clip(`回答「${answer.question}」：${answer.answer}`, 300), source: 'run', decision: true });
      });
      // The plan is the work itself, so it comes after the approval that let it start.
      const begun = (run.events.find(event => event.type === 'model.started' && event.data.phase === 'executor') ?? run.events.find(event => event.type === 'plan.approved'))?.at ?? run.createdAt;
      for (const node of plan?.nodes ?? []) steps.push({ at: begun, text: clip(`${card.title ?? '这件事'}：${node.title}`, 300), source: 'run', decision: false });
      for (const receipt of run.toolReceipts ?? []) tools.add(receipt.authorization?.toolId ?? receipt.operation);
    }
    const ordered = steps.sort((left, right) => left.at.localeCompare(right.at)).slice(0, MAX_STEPS);
    const decisions = ordered.filter(step => step.decision).map(step => step.text);
    const lines = [`按「${roomTitle}」里的一次示范来做。示范的人是群主，教给${agentName}。`, '', '步骤：', ...ordered.map((step, index) => `${index + 1}. ${step.text}`)];
    if (decisions.length) lines.push('', '到这些地方先停下，等人确认：', ...decisions.map(text => `- ${text}`));
    if (tools.size) lines.push('', `示范时用到的工具：${[...tools].join('、')}`);
    return { steps: ordered, decisions, tools: [...tools], prompt: lines.join('\n').slice(0, 4000), executionReview: decisions.length ? 'required' : 'auto' };
  }
}
