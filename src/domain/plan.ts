import type {
  Id,
  Plan,
  PlanNode,
  PlanNodeInput,
  TaskStatus,
  TaskTransition,
} from "../contracts.js";

const terminalStatuses = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

const allowedTransitions: Record<TaskStatus, Partial<Record<TaskTransition, TaskStatus>>> = {
  planned: { start: "running", cancel: "cancelled" },
  ready: { start: "running", cancel: "cancelled" },
  running: {
    wait: "waiting",
    request_approval: "needs_approval",
    block: "blocked",
    succeed: "succeeded",
    fail: "failed",
    cancel: "cancelled",
    mark_unknown: "unknown",
  },
  waiting: { start: "running", cancel: "cancelled", mark_unknown: "unknown" },
  needs_approval: { start: "running", cancel: "cancelled", mark_unknown: "unknown" },
  blocked: { start: "running", cancel: "cancelled", mark_unknown: "unknown" },
  failed: { retry: "ready", cancel: "cancelled" },
  unknown: { retry: "ready", cancel: "cancelled" },
  succeeded: {},
  cancelled: {},
};

export function createPlan(
  id: Id,
  goalId: Id,
  version: number,
  inputs: PlanNodeInput[],
  now = new Date().toISOString(),
): Plan {
  if (inputs.length === 0) throw new Error("Plan must contain at least one task");
  validateGraph(inputs);
  const ids = new Set(inputs.map((node) => node.id));
  const nodes: PlanNode[] = inputs.map((input) => {
    const dependsOn = [...(input.dependsOn ?? [])];
    return {
      id: input.id,
      title: input.title,
      kind: input.kind ?? "task",
      dependsOn,
      status: dependsOn.length === 0 ? "ready" : "planned",
      attempt: 0,
    };
  });

  if (ids.size !== inputs.length) {
    throw new Error("Plan node IDs must be unique");
  }

  return { id, goalId, version, nodes, createdAt: now };
}

export function transitionTask(
  plan: Plan,
  taskId: Id,
  transition: TaskTransition,
  reason?: string,
  now = new Date().toISOString(),
): { plan: Plan; from: TaskStatus; to: TaskStatus; attempt: number } {
  const node = plan.nodes.find((candidate) => candidate.id === taskId);
  if (!node) throw new Error(`Unknown task: ${taskId}`);

  if (transition === "start" && !dependenciesSucceeded(plan, node)) {
    throw new Error(`Task ${taskId} is not ready: dependencies have not succeeded`);
  }

  const to = allowedTransitions[node.status][transition];
  if (!to) {
    throw new Error(`Cannot ${transition} task ${taskId} from ${node.status}`);
  }

  const from = node.status;
  const attempt = transition === "retry" ? node.attempt + 1 : node.attempt;
  const updatedNode: PlanNode = {
    ...node,
    status: to,
    attempt,
    ...(reason === undefined ? {} : { lastError: reason }),
    ...(to === "running" ? { startedAt: now } : {}),
    ...(terminalStatuses.has(to) ? { completedAt: now } : {}),
  };
  return {
    plan: {
      ...plan,
      nodes: plan.nodes.map((candidate) =>
        candidate.id === taskId ? updatedNode : candidate,
      ),
    },
    from,
    to,
    attempt,
  };
}

export function refreshReadyTasks(plan: Plan): Plan {
  return {
    ...plan,
    nodes: plan.nodes.map((node) =>
      node.status === "planned" && dependenciesSucceeded(plan, node)
        ? { ...node, status: "ready" }
        : node,
    ),
  };
}

function dependenciesSucceeded(plan: Plan, node: PlanNode): boolean {
  const byId = new Map(plan.nodes.map((candidate) => [candidate.id, candidate]));
  return node.dependsOn.every((dependencyId) => byId.get(dependencyId)?.status === "succeeded");
}

function validateGraph(inputs: PlanNodeInput[]): void {
  const ids = new Set(inputs.map((node) => node.id));
  for (const node of inputs) {
    for (const dependencyId of node.dependsOn ?? []) {
      if (!ids.has(dependencyId)) {
        throw new Error(`Task ${node.id} depends on unknown task ${dependencyId}`);
      }
      if (dependencyId === node.id) {
        throw new Error(`Task ${node.id} cannot depend on itself`);
      }
    }
  }

  const dependencies = new Map(inputs.map((node) => [node.id, node.dependsOn ?? []]));
  const visiting = new Set<Id>();
  const visited = new Set<Id>();
  const visit = (id: Id): void => {
    if (visiting.has(id)) throw new Error("Plan graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependencyId of dependencies.get(id) ?? []) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}
