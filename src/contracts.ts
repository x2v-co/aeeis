export type Id = string;

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
  title: string;
  description?: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
}

export type MemoryKind = "fact" | "decision" | "preference" | "note";
export type MemoryScope = "private" | "project" | "session";

export interface MemoryEntry {
  id: Id;
  goalId?: Id;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  source: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContextManifest {
  id: Id;
  purpose: string;
  audience: string[];
  memoryRefs: Id[];
  included: Array<Pick<MemoryEntry, "id" | "kind" | "content" | "source" | "confidence">>;
  knowledgeRefs?: Id[];
  includedKnowledge?: Array<{ id: Id; title: string; content: string; source: string; classification: "public" | "internal" | "confidential" | "private"; contentHash: string; score: number }>;
  excluded: string[];
  createdAt: string;
}

export interface PlanNodeInput {
  id: Id;
  title: string;
  kind?: TaskKind;
  dependsOn?: Id[];
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

export type ProjectionAggregateType = "goal" | "plan" | "task";

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
}

export interface CreateMemoryInput {
  kind: MemoryKind;
  scope?: MemoryScope;
  content: string;
  source?: string;
  confidence?: number;
}

export interface CreateContextInput {
  purpose: string;
  query?: string;
  audience?: string[];
  maxItems?: number;
  knowledgeClassifications?: Array<"public" | "internal" | "confidential" | "private">;
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
