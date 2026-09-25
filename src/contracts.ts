import type { ContextAudienceSnapshot } from './context-audience.js';

export type Id = string;

export interface Room {
  id: Id;
  owner?: string;
  tenantId?: string;
  title: string;
  description?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | "planned"
  | "ready"
  | "running"
  | "waiting"
  | "needs_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type TaskTransition =
  | "start"
  | "wait"
  | "request_approval"
  | "block"
  | "succeed"
  | "fail"
  | "cancel"
  | "mark_unknown"
  | "retry";

export type TaskKind = "task" | "review" | "approval" | "deliverable";

export interface Goal {
  id: Id;
  /** Ownership is optional for backwards-compatible legacy snapshots. Missing
   * ownership is treated as the local `owner` principal at the service edge. */
  owner?: string;
  tenantId?: string;
  /** Optional first-class Room that groups this Goal and its projections. */
  roomId?: Id;
  title: string;
  description?: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
}

export type MemoryKind = "fact" | "decision" | "preference" | "note";
export type MemoryScope = "private" | "project" | "session";
export type MemoryState = "active" | "superseded" | "retracted";
export type MemoryClassification = "public" | "internal" | "confidential" | "private";

export interface MemoryEntry {
  id: Id;
  goalId?: Id;
  /** Ownership is retained on the entry as a defence-in-depth boundary. */
  owner?: string;
  tenantId?: string;
  kind: MemoryKind;
  scope: MemoryScope;
  classification?: MemoryClassification;
  content: string;
  source: string;
  confidence: number;
  /** New entries start at version 1. Legacy snapshots are interpreted as 1. */
  version?: number;
  state?: MemoryState;
  /** Receipts, artifacts, claims or source IDs supporting this memory. */
  evidenceRefs?: Id[];
  /** Run whose evidence graph was used for a governed writeback. */
  evidenceRunId?: Id;
  /** Links a correction to the memory version it supersedes. */
  supersedesId?: Id;
  retractedAt?: string;
  retractionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextMemory {
  id: Id;
  kind: MemoryKind;
  content: string;
  source: string;
  confidence: number;
  score: number;
  version: number;
  classification: MemoryClassification;
  evidenceRefs: Id[];
  evidenceRunId?: Id;
}

export interface ContextManifest {
  id: Id;
  goalId?: Id;
  /** A Room-scoped manifest can cover several Goals in one Shared Session. */
  roomId?: Id;
  goalIds?: Id[];
  goalContextRefs?: Array<{ goalId: Id; contextManifestId: Id; bindingHash: string }>;
  owner?: string;
  tenantId?: string;
  purpose: string;
  audience: string[];
  /** Frozen recipients and membership evidence; current authorization is still required. */
  audienceSnapshot?: ContextAudienceSnapshot;
  memoryRefs: Id[];
  included: ContextMemory[];
  knowledgeRefs?: Id[];
  includedKnowledge?: Array<{ id: Id; title: string; content: string; source: string; classification: "public" | "internal" | "confidential" | "private"; contentHash: string; score: number }>;
  excluded: string[];
  createdAt: string;
}

export interface PlanNodeInput {
  id: Id;
  title: string;
  instruction?: string;
  kind?: TaskKind;
  dependsOn?: Id[];
  /** Evidence that motivated a durable follow-up task. */
  evidenceRefs?: string[];
  /** Run whose Evidence Graph contains the referenced observations. */
  evidenceRunId?: Id;
}

export interface PlanNode extends Omit<PlanNodeInput, "kind" | "dependsOn"> {
  kind: TaskKind;
  dependsOn: Id[];
  status: TaskStatus;
  attempt: number;
  lastError?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Plan {
  id: Id;
  goalId: Id;
  version: number;
  nodes: PlanNode[];
  createdAt: string;
}

export interface RunReceipt {
  id: Id;
  planId: Id;
  taskId: Id;
  transition: TaskTransition;
  from: TaskStatus;
  to: TaskStatus;
  occurredAt: string;
  attempt: number;
  reason?: string;
}

export type ProjectionAggregateType = "room" | "goal" | "plan" | "task" | "run" | "competition" | "debate" | "evolution" | "reminder" | "session_event";

/** Durable intent written with the domain transition. It is deliberately
 * transport-neutral; the Projection Outbox owns delivery and reconciliation. */
export interface ProjectionIntent {
  id: Id;
  owner: string;
  tenantId: string;
  channel: string;
  destination: string;
  aggregateType: ProjectionAggregateType;
  aggregateId: string;
  idempotencyKey: string;
  payload: unknown;
  status: "pending" | "dispatched";
  createdAt: string;
  dispatchedAt?: string;
}

export interface CreateGoalInput {
  title: string;
  description?: string;
  roomId?: Id;
}

export interface CreateRoomInput {
  title: string;
  description?: string;
}

export interface UpdateRoomInput {
  title?: string;
  description?: string;
  status?: Room['status'];
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  scope?: MemoryScope;
  classification?: MemoryClassification;
  content: string;
  source?: string;
  confidence?: number;
  evidenceRefs?: Id[];
  /** Only accepted by an evidence-bound writeback flow. */
  evidenceRunId?: Id;
}

export interface CreateContextInput {
  purpose: string;
  query?: string;
  audience?: string[];
  audienceMode?: 'owner' | 'room';
  maxItems?: number;
  memoryMaxItems?: number;
  memoryClassifications?: MemoryClassification[];
  knowledgeClassifications?: Array<"public" | "internal" | "confidential" | "private">;
}

export interface CreateSessionContextInput {
  purpose: string;
  /** Published Goal contexts, each already authorized for every recipient. */
  contexts: Array<{ goalId: Id; contextManifestId: Id }>;
  audience?: string[];
}

export interface CreatePlanInput {
  goalId: Id;
  nodes: PlanNodeInput[];
}

export interface TransitionTaskInput {
  planId: Id;
  taskId: Id;
  transition: TaskTransition;
  reason?: string;
}

export interface AeeisSnapshot {
  goal: Goal;
  plan: Plan;
  receipts: RunReceipt[];
  memories: MemoryEntry[];
}
