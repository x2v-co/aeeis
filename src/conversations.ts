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
export interface ConversationMessage {
  id: string;
  keyHash: string;
  requestHash: string;
  role: 'user' | 'notification';
  text: string;
  createdAt: string;
  replyTo?: string;
  correctsMessageId?: string;
  route: ConversationRoute;
  execution?: {
    taskId: string;
    runId: string;
    parentRunId?: string;
    request: TaskRequest;
    state: 'pending' | 'completed' | 'cancelled';
  };
  notificationRunId?: string;
}
export interface Conversation extends Ownership {
  schemaVersion: 'conversation/1';
  id: string;
  title: string;
  /** Stable person this life thread belongs to. Missing on conversations created before personal agents. */
  agentId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  focusTaskId?: string;
  recentTaskIds: string[];
  tasks: ConversationTask[];
  messages: ConversationMessage[];
}
export interface ConversationStore {
  init(): Promise<void>;
  close(): Promise<void>;
  create(value: Conversation): Promise<void>;
  get(id: string, scope: Ownership): Promise<Conversation>;
  list(scope: Ownership): Promise<Conversation[]>;
  mutate(id: string, scope: Ownership, change: (value: Conversation) => void): Promise<Conversation>;
  pending(): AsyncIterable<Conversation>;
}
