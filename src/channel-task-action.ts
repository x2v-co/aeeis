import { z } from 'zod';

const citationId = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);

/** What a person did to a channel task. The session event that carries it is
 * the fact; the board is only a projection of these actions. Older events
 * wrote the same meaning as a text prefix; `legacyTaskAction` reads those so
 * existing channels keep their state, but new writes always carry this. */
export const channelTaskActionKindSchema = z.enum(['claim', 'assign', 'transfer', 'refuse', 'release', 'accept', 'request_changes', 'block', 'unblock', 'cancel', 'restore', 'hand_up', 'propose', 'adopt', 'offer', 'decline']);
export type ChannelTaskActionKind = z.infer<typeof channelTaskActionKindSchema>;
export const channelTaskActionSchema = z.object({
  schemaVersion: z.literal('channel-task-action/1'),
  kind: channelTaskActionKindSchema,
  conversationId: citationId,
  taskId: citationId,
  agentId: citationId.optional(),
  reason: z.string().trim().min(1).max(4000).optional(),
}).strict();
export type ChannelTaskAction = z.infer<typeof channelTaskActionSchema>;

/** Kinds a person can write through the task-actions endpoint. `hand_up`,
 * `propose` and `decline` are written only by the server: Bot removal, a Bot's
 * own proposal, and the end of a handoff that was not taken. */
export const writableTaskActionKinds = ['claim', 'assign', 'transfer', 'refuse', 'release', 'accept', 'request_changes', 'block', 'unblock', 'cancel', 'restore', 'adopt', 'offer'] as const satisfies readonly ChannelTaskActionKind[];
export const actionNeedsAgent: ReadonlySet<ChannelTaskActionKind> = new Set(['claim', 'assign', 'transfer', 'offer', 'propose']);
export const actionNeedsReason: ReadonlySet<ChannelTaskActionKind> = new Set(['refuse', 'release', 'request_changes', 'block', 'unblock', 'cancel', 'restore', 'decline']);

/** The line people read in the channel. It keeps the wording the channel has
 * always shown; nothing reads meaning back out of it. */
export function taskActionLine(action: ChannelTaskAction, agentName?: string): string {
  const name = agentName ?? action.agentId ?? '';
  const reason = action.reason ?? '';
  switch (action.kind) {
    case 'claim': return `领取：${name}`;
    case 'assign': return `分派给 ${name}`;
    case 'transfer': return `转交给 ${name}`;
    case 'refuse': return `拒绝领取：${reason}`;
    case 'release': return `退回待领取：${reason}`;
    case 'accept': return '验收通过';
    case 'request_changes': return `要求修改：${reason}`;
    case 'block': return `阻塞：${reason}`;
    case 'unblock': return `解除阻塞：${reason}`;
    case 'cancel': return `取消：${reason}`;
    case 'restore': return `撤回取消：${reason}`;
    case 'hand_up': return `已交给AEEIS${reason ? `，记为讨论「${reason}」` : ''}。原来的事还在。`;
    case 'propose': return `${name}提议这件事${reason ? `：${reason}` : ''}`;
    case 'adopt': return '采纳提议';
    case 'offer': return `交接中：交给 ${name}${reason ? `。${reason}` : ''}`;
    case 'decline': return `没有交接：${reason}`;
  }
}

/** The fields of a session event the board reads. Both the server store and
 * the browser's copy of an event fit this shape. */
export interface BoardEvent {
  id: string;
  sequence?: number | undefined;
  type: string;
  operation?: string | undefined;
  owner?: string | undefined;
  actorId: string;
  actorType: string;
  recordedBy?: { id: string; type: string } | undefined;
  content: string;
  evidenceRefs?: string[] | undefined;
  taskAction?: ChannelTaskAction | undefined;
  idempotencyKey?: string | undefined;
  createdAt?: string | undefined;
}

export interface BoardTaskView { id: string; title: string; status: string; runId?: string; latestRunId?: string; createdAt?: string }
export interface BoardConversationView { id: string; agentId?: string; tasks: BoardTaskView[] }

export type BoardColumn = 'capture' | 'ready' | 'doing' | 'blocked' | 'review' | 'done' | 'failed';
export interface BoardDecision {
  assigneeId?: string; conflicts: string[]; accepted: boolean; revision?: string; blockedNote?: string; cancelReason?: string; cancelled: boolean; released: boolean; handedUp: boolean; lines: string[];
  /** A Bot proposed this task; it waits for a person until adopted or cancelled. */
  proposedBy?: string; proposalReason?: string; adopted?: boolean;
  /** Handed to someone who has not taken it yet. The task stays with its holder. */
  offer?: { to: string; note?: string };
}
/** `automatic`: the server wrote this receipt for a Bot (a proposal or a handoff line), not the person. */
export interface BoardCitation { eventId: string; sequence?: number; conversationId: string; taskId: string; agentId?: string; actorId: string; actorType: string; at?: string; content: string; automatic?: boolean }
export interface BoardActionMark { eventId: string; sequence?: number; kind: ChannelTaskActionKind; conversationId: string; taskId: string; agentId?: string; at?: string }
/** Records the server writes for the Bots: replies, proposals, handoffs and reassignment. */
export function automaticKey(key: string | undefined): boolean {
  return /^(bot-|handoff-)/.test(key ?? '');
}
export interface BoardCard {
  conversationId: string;
  taskId: string;
  agentId?: string;
  /** Who holds the task now: the last claim, assignment or transfer, else the person it went to. */
  ownerId: string;
  /** Set when the holder is not the person whose thread the task lives on. */
  movedFrom?: string;
  title?: string;
  status: string;
  runId?: string;
  column: BoardColumn;
  decision: BoardDecision;
  chain: string[];
}
export interface ChannelBoard {
  schemaVersion: 'channel-board/1';
  roomId: string;
  /** Sequence of the last event this projection read. */
  cursor: number;
  cards: BoardCard[];
  citations: BoardCitation[];
  actions: BoardActionMark[];
  wip: Array<{ agentId: string; count: number }>;
}

export const WIP_LIMIT = 3;
const CITATION = /^[a-z][a-z0-9_.-]{1,127}$/;
const STARTED = new Set(['planning', 'running', 'reviewing']);

export function roomOwnerWrote(event: BoardEvent): boolean {
  const writer = event.recordedBy ?? { id: event.actorId, type: event.actorType };
  return writer.type === 'principal' && Boolean(event.owner) && writer.id === event.owner;
}

/** A receipt the room owner wrote that cites a conversation task: the first
 * `conv_` and `task_` refs name the task, and the next plain id names the
 * person it went to. */
export function eventCitation(event: BoardEvent): Omit<BoardCitation, 'eventId' | 'actorId' | 'actorType' | 'at' | 'content'> | undefined {
  if (event.type === 'task_update' || event.operation === 'retract' || !roomOwnerWrote(event)) return;
  const refs = event.evidenceRefs ?? [];
  const conversationId = refs.find(id => id.startsWith('conv_') && CITATION.test(id));
  const taskId = refs.find(id => id.startsWith('task_') && CITATION.test(id));
  if (!conversationId || !taskId) return;
  const agentId = refs.find(id => id !== conversationId && id !== taskId && !id.startsWith('conv_') && !id.startsWith('task_') && CITATION.test(id));
  return agentId ? { conversationId, taskId, agentId } : { conversationId, taskId };
}

/** Reads the meaning of an event written before structured actions existed.
 * Only the server and the Bot-removal path call this. */
export function legacyTaskAction(event: BoardEvent): ChannelTaskAction | undefined {
  const refs = event.evidenceRefs ?? [];
  const content = event.content.trim();
  if (event.type === 'system' && content.startsWith('已交给AEEIS')) {
    const conversations = refs.filter(id => id.startsWith('conv_') && CITATION.test(id));
    const tasks = refs.filter(id => id.startsWith('task_') && CITATION.test(id));
    const conversationId = conversations[1];
    const taskId = tasks[1];
    return conversationId && taskId ? { schemaVersion: 'channel-task-action/1', kind: 'hand_up', conversationId, taskId, agentId: 'aeeis' } : undefined;
  }
  if (event.type !== 'task_update') return;
  const conversationId = refs.find(id => id.startsWith('conv_') && CITATION.test(id));
  const taskId = refs.find(id => id.startsWith('task_') && CITATION.test(id));
  if (!conversationId || !taskId) return;
  const agentId = refs.find(id => id !== conversationId && id !== taskId && CITATION.test(id));
  const base = { schemaVersion: 'channel-task-action/1' as const, conversationId, taskId };
  const after = (prefix: string) => content.slice(prefix.length).trim() || undefined;
  const withReason = (kind: ChannelTaskActionKind, prefix: string): ChannelTaskAction => {
    const reason = after(prefix);
    return { ...base, kind, ...(reason ? { reason } : {}) };
  };
  if (content.startsWith('领取：')) return agentId ? { ...base, kind: 'claim', agentId } : undefined;
  if (content.startsWith('分派给 ')) return agentId ? { ...base, kind: 'assign', agentId } : undefined;
  if (content.startsWith('转交给 ')) return agentId ? { ...base, kind: 'transfer', agentId } : undefined;
  if (content.startsWith('拒绝领取：')) return withReason('refuse', '拒绝领取：');
  if (content.startsWith('退回待领取')) return withReason('release', content.startsWith('退回待领取：') ? '退回待领取：' : '退回待领取');
  if (content === '验收通过') return { ...base, kind: 'accept' };
  if (content.startsWith('要求修改：')) return withReason('request_changes', '要求修改：');
  if (content.startsWith('阻塞：')) return withReason('block', '阻塞：');
  if (content.startsWith('解除阻塞')) return withReason('unblock', content.startsWith('解除阻塞：') ? '解除阻塞：' : '解除阻塞');
  if (content.startsWith('取消：')) return withReason('cancel', '取消：');
  if (content.startsWith('撤回取消：')) return withReason('restore', '撤回取消：');
  return undefined;
}

/** The action an event carries, if the room owner wrote it. */
export function eventTaskAction(event: BoardEvent): ChannelTaskAction | undefined {
  if (event.operation === 'retract' || !roomOwnerWrote(event)) return;
  return event.taskAction ?? legacyTaskAction(event);
}

export function emptyDecision(): BoardDecision {
  return { conflicts: [], accepted: false, cancelled: false, released: false, handedUp: false, lines: [] };
}

/** Folds one action into a task's decision. Order matters: the first claim
 * holds until someone refuses, releases, assigns or transfers it. */
export function applyTaskAction(decision: BoardDecision, action: ChannelTaskAction, line: string): void {
  switch (action.kind) {
    case 'claim':
      if (!action.agentId) return;
      if (decision.assigneeId && decision.assigneeId !== action.agentId) decision.conflicts.push(action.agentId);
      else decision.assigneeId = action.agentId;
      decision.released = false;
      break;
    case 'assign':
    case 'transfer':
      if (!action.agentId) return;
      decision.assigneeId = action.agentId;
      decision.cancelled = false;
      decision.released = false;
      delete decision.offer;
      break;
    case 'propose':
      if (!action.agentId) return;
      decision.proposedBy = action.agentId;
      if (action.reason) decision.proposalReason = action.reason;
      decision.adopted = false;
      break;
    case 'adopt':
      decision.adopted = true;
      break;
    case 'offer':
      if (!action.agentId) return;
      decision.offer = { to: action.agentId, ...(action.reason ? { note: action.reason } : {}) };
      break;
    case 'decline':
      delete decision.offer;
      break;
    case 'refuse':
      delete decision.assigneeId;
      break;
    case 'release':
      delete decision.assigneeId;
      decision.released = true;
      break;
    case 'accept':
      decision.accepted = true;
      break;
    case 'request_changes':
      decision.revision = action.reason ?? '';
      decision.accepted = false;
      break;
    case 'block':
      decision.blockedNote = action.reason ?? '';
      break;
    case 'unblock':
      delete decision.blockedNote;
      break;
    case 'cancel':
      decision.cancelled = true;
      if (action.reason) decision.cancelReason = action.reason;
      delete decision.offer;
      break;
    case 'restore':
      decision.cancelled = false;
      delete decision.cancelReason;
      break;
    case 'hand_up':
      decision.handedUp = true;
      break;
  }
  decision.lines.push(line);
}

export function taskKey(conversationId: string, taskId: string): string { return `${conversationId}\u0000${taskId}`; }

/** Decisions for every task the events act on, in event order. */
export function projectDecisions(events: readonly BoardEvent[]): Map<string, BoardDecision> {
  const decisions = new Map<string, BoardDecision>();
  for (const event of events) {
    const action = eventTaskAction(event);
    if (!action) continue;
    const key = taskKey(action.conversationId, action.taskId);
    const decision = decisions.get(key) ?? emptyDecision();
    applyTaskAction(decision, action, event.content.trim());
    decisions.set(key, decision);
  }
  return decisions;
}

export function taskRunId(task: BoardTaskView): string | undefined { return task.runId ?? task.latestRunId; }

export function blockNoteCurrent(status: string, decision: BoardDecision): string | undefined {
  if (!decision.blockedNote) return;
  if (['planning', 'running', 'reviewing', 'preparing', 'queued', 'succeeded', 'failed', 'cancelled', 'unreadable'].includes(status)) return;
  return decision.blockedNote;
}

export function boardColumn(status: string, decision?: BoardDecision, runId?: string): BoardColumn {
  if (decision?.cancelled && !runId && (status === 'discussion' || status === 'preparing' || status === 'queued')) return 'failed';
  if (status === 'failed' || status === 'cancelled' || status === 'unreadable') return 'failed';
  if (decision && blockNoteCurrent(status, decision)) return 'blocked';
  if (decision?.released && !decision.assigneeId && !runId && (status === 'discussion' || status === 'preparing' || status === 'queued')) return 'ready';
  if (status === 'discussion') return 'capture';
  if (status === 'preparing' || status === 'queued') return 'ready';
  if (STARTED.has(status)) return 'doing';
  if (status === 'needs_approval' || status === 'needs_input' || status === 'waiting_external' || status === 'paused' || status === 'unknown') return 'blocked';
  if (status === 'succeeded') return decision?.accepted ? 'done' : 'review';
  return 'capture';
}

/** The whole board from the room's events and the conversations they cite.
 * A conversation the reader cannot open shows its tasks as unreadable. */
export function projectChannelBoard(roomId: string, events: readonly BoardEvent[], conversations: ReadonlyMap<string, BoardConversationView | undefined>, nameOf: (id: string) => string = id => id): ChannelBoard {
  const live = events.filter(event => event.operation !== 'retract');
  const decisions = projectDecisions(live);
  const citations: BoardCitation[] = [];
  const actions: BoardActionMark[] = [];
  const firstCite = new Map<string, BoardCitation>();
  // The chain is every receipt and action for a task in event order. A receipt that only
  // names the task's current holder repeats an action already in the chain and is left out.
  const chains = new Map<string, string[]>();
  const holders = new Map<string, string>();
  for (const event of live) {
    const cite = eventCitation(event);
    if (cite) {
      const mark: BoardCitation = { eventId: event.id, ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), ...cite, actorId: event.actorId, actorType: event.actorType, ...(event.createdAt ? { at: event.createdAt } : {}), content: event.content, ...(automaticKey(event.idempotencyKey) ? { automatic: true } : {}) };
      citations.push(mark);
      const key = taskKey(cite.conversationId, cite.taskId);
      if (!firstCite.has(key)) firstCite.set(key, mark);
      const chain = chains.get(key) ?? [];
      if (!cite.agentId || holders.get(key) !== cite.agentId) chain.push(`交给${cite.agentId ? nameOf(cite.agentId) : '这个人'}`);
      if (cite.agentId && !holders.has(key)) holders.set(key, cite.agentId);
      chains.set(key, chain);
    }
    const action = eventTaskAction(event);
    if (action) {
      const key = taskKey(action.conversationId, action.taskId);
      const line = event.content.trim();
      if (line) chains.set(key, [...(chains.get(key) ?? []), line]);
      if ((action.kind === 'claim' || action.kind === 'assign' || action.kind === 'transfer') && action.agentId) holders.set(key, action.agentId);
    }
    if (action) actions.push({ eventId: event.id, ...(event.sequence !== undefined ? { sequence: event.sequence } : {}), kind: action.kind, conversationId: action.conversationId, taskId: action.taskId, ...(action.agentId ? { agentId: action.agentId } : {}), ...(event.createdAt ? { at: event.createdAt } : {}) });
  }
  const cards: BoardCard[] = [];
  for (const [key, cite] of firstCite) {
    const decision = decisions.get(key) ?? emptyDecision();
    if (decision.handedUp) continue;
    const view = conversations.get(cite.conversationId);
    const task = view?.tasks.find(item => item.id === cite.taskId);
    const status = task?.status ?? 'unreadable';
    const runId = task ? taskRunId(task) : undefined;
    const home = view?.agentId ?? cite.agentId ?? '';
    const ownerId = decision.released ? '' : (decision.assigneeId ?? cite.agentId ?? view?.agentId ?? '');
    cards.push({
      conversationId: cite.conversationId,
      taskId: cite.taskId,
      ...(cite.agentId ? { agentId: cite.agentId } : {}),
      ownerId,
      ...(ownerId && home && ownerId !== home ? { movedFrom: home } : {}),
      ...(task ? { title: task.title } : {}),
      status,
      ...(runId ? { runId } : {}),
      column: boardColumn(status, decision, runId),
      decision,
      chain: chains.get(key) ?? [],
    });
  }
  const loads = new Map<string, number>();
  for (const card of cards) if (card.column === 'doing' && card.ownerId) loads.set(card.ownerId, (loads.get(card.ownerId) ?? 0) + 1);
  const cursor = live.reduce((max, event) => Math.max(max, event.sequence ?? 0), 0);
  return { schemaVersion: 'channel-board/1', roomId, cursor, cards, citations, actions, wip: [...loads].map(([agentId, count]) => ({ agentId, count })) };
}
