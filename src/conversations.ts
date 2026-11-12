import type { Ownership } from './security/principal.js';
import type { TaskRequest } from './runtime/contracts.js';

export interface ConversationTask {
  id: string;
  threadId: string;
  title: string;
  createdAt: string;
  /** 1 is the highest manual rank. Missing values stay in creation order after ranked tasks. */
  priority?: number;
  latestRunId?: string;
  pendingMessageId?: string;
  /** The owner put this task down after this Run failed, when it had this many events. A retry of the Run after
   * that, or a new Run, brings the task back on its own. */
  putDownRun?: { id: string; eventSeq: number };
  /** Handing this task to another Bot from a private chat (no group needed). The two Bots talk it over in their side
   * thread; an accepted handoff puts a new task in the receiver's chat and links it here. */
  handoff?: TaskHandoff;
}
export interface TaskHandoff {
  /** Stable per attempt; side-thread turns and outcomes are keyed by it. A new attempt gets a new id. */
  offerId: string;
  from: string;
  to: string;
  /** The receiver's name when it was offered, for display. */
  toName: string;
  note?: string;
  state: 'suggested' | 'negotiating' | 'accepted' | 'declined' | 'blocked';
  at: string;
  reason?: string;
  receiver?: { conversationId: string; taskId: string };
}
/** Dashboard order: explicit priority ascending, then creation order. Does not change stored identity order. */
export function conversationTaskOrder<T extends { priority?: number }>(tasks: readonly T[]): T[] {
  return tasks.map((task, index) => ({ task, index })).sort((left, right) => {
    const leftRank = left.task.priority ?? Number.POSITIVE_INFINITY;
    const rightRank = right.task.priority ?? Number.POSITIVE_INFINITY;
    return leftRank - rightRank || left.index - right.index;
  }).map(item => item.task);
}
export interface ConversationRoute {
  status: 'routed' | 'clarify' | 'general';
  reason: 'new-task' | 'explicit' | 'reply' | 'name' | 'focus' | 'ambiguous' | 'unassigned';
  taskIds: string[];
  candidateTaskIds: string[];
  focusEffect: 'keep' | 'switch';
}
/** Who spoke. `user` is the owner. `agent` is a roster bot. The role names the
 * speaker; it does not grant tools, budget, or plan approval. */
export interface ConversationSpeaker {
  role: 'user' | 'agent';
  id: string;
}
export interface ConversationMessage {
  id: string;
  keyHash: string;
  requestHash: string;
  role: 'user' | 'notification';
  /** Persisted to keep background catch-up from answering an execute request. */
  intent?: 'discuss' | 'execute';
  /** Missing on messages written before speakers. Those are the owner, role user. */
  speaker?: ConversationSpeaker;
  text: string;
  createdAt: string;
  replyTo?: string;
  correctsMessageId?: string;
  route: ConversationRoute;
  /** The owner set an unrouted (clarify) message aside without choosing a task. It stays in the
   * conversation and can still be corrected; it just stops waiting for a choice. Set once. */
  dismissedAt?: string;
  execution?: {
    taskId: string;
    runId: string;
    parentRunId?: string;
    request: TaskRequest;
    state: 'pending' | 'completed' | 'cancelled';
  };
  notificationRunId?: string;
  /** Where the message came from when it was not typed in the workbench. Written by the server only. */
  source?: ConversationMessageSource;
}
export type ConversationMessageSource =
  | { kind: 'channel'; channel: string; externalEventId: string; receivedAt: string }
  | { kind: 'artifact'; artifactId: string; title: string; runId?: string }
  | { kind: 'room'; roomId: string; eventId: string; hash: string; operation: 'publish' | 'revise' | 'retract'; targetMessageId?: string; referenceOnly: boolean; eventType?: string; revision?: number; evidenceRefs?: string[]; actorType?: 'principal' | 'agent' | 'system' }
  | { kind: 'routine'; routineId: string; deliveryId: string; trigger: 'schedule' | 'webhook' | 'manual' };
export interface Conversation extends Ownership {
  schemaVersion: 'conversation/1';
  id: string;
  title: string;
  /** Stable person this life thread belongs to. Missing on conversations created before personal agents. */
  agentId?: string;
  /** Owner-written sentence that stays with this person. Missing when none is pinned. */
  standingInstruction?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  focusTaskId?: string;
  recentTaskIds: string[];
  tasks: ConversationTask[];
  messages: ConversationMessage[];
}
export interface ConversationStore {
  /** System recovery keyset page; never load every Bot aggregate at once. */
  scanPage?(after?: string, limit?: number): Promise<{ items: Conversation[]; next?: string }>;
  init(): Promise<void>;
  close(): Promise<void>;
  create(value: Conversation): Promise<void>;
  get(id: string, scope: Ownership): Promise<Conversation>;
  list(scope: Ownership): Promise<Conversation[]>;
  mutate(id: string, scope: Ownership, change: (value: Conversation) => void): Promise<Conversation>;
  pending(): AsyncIterable<Conversation>;
}

/** Apply append-only imported revisions for every view and future execution context. */
export function visibleConversationMessages(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const visible: ConversationMessage[] = [];
  for (const original of messages) {
    const message = structuredClone(original), source = message.source;
    if (source?.kind === 'room' && source.targetMessageId && source.targetMessageId !== message.id) {
      const target = visible.find(item => item.id === source.targetMessageId);
      if (target) { target.text = source.operation === 'retract' ? '（已撤回）' : message.text; target.source = { ...source, targetMessageId: target.id }; }
    } else visible.push(message);
  }
  return visible;
}
