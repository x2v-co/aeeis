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
  title: string;
  description?: string;
  status: "active" | "completed" | "cancelled";
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

export interface CreateGoalInput {
  title: string;
  description?: string;
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
}
