import type { AgentRun } from './contracts.js';
import { nodeModelCalls } from './execution-limits.js';

/**
 * How much a finished Run's plan could have gained from running independent
 * tasks at the same time (docs/design/2026-11-20-parallel-task-execution.md).
 * Recorded once per plan version when the Run finishes. The numbers carry no
 * user content, so they stay readable by SQL when events are encrypted.
 */
export const PLAN_PARALLELISM_EVENT = 'plan.parallelism';

export interface PlanParallelism {
  schemaVersion: 'plan-parallelism/1';
  planHash: string;
  planVersion: number;
  status: string;
  tasks: number;
  /** Tasks with no dependencies. */
  roots: number;
  /** Most tasks at one dependency depth: how many could run at once. */
  width: number;
  /** Tasks whose time is known: they have at least one finished executor call under this plan version. */
  measuredTasks: number;
  /** Sum of task times, first executor call start to last executor call end. */
  serialMs: number;
  /** Longest dependency chain by task time; only when every task was measured. */
  criticalPathMs: number | null;
  /** serialMs − criticalPathMs: time unlimited parallel execution could have saved. */
  savableMs: number | null;
}

export function planParallelism(run: AgentRun): PlanParallelism | undefined {
  const plan = run.plans.at(-1);
  if (!plan?.nodes.length) return undefined;
  // Only this plan version's calls: a replan keeps earlier calls and may reuse task IDs.
  const span = new Map<string, { start: number; end: number }>();
  for (const node of plan.nodes) for (const call of nodeModelCalls(run, node.id)) {
    if (!call.endedAt) continue;
    const start = Date.parse(call.startedAt), end = Date.parse(call.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const current = span.get(node.id);
    span.set(node.id, current ? { start: Math.min(current.start, start), end: Math.max(current.end, end) } : { start, end });
  }
  const nodes = new Map(plan.nodes.map(node => [node.id, node]));
  const duration = (id: string) => { const value = span.get(id); return value ? value.end - value.start : 0; };
  const depth = new Map<string, number>(); const finish = new Map<string, number>();
  const visit = (id: string, path: Set<string>): void => {
    if (depth.has(id)) return;
    const node = nodes.get(id);
    if (!node || path.has(id)) { depth.set(id, 0); finish.set(id, 0); return; }
    path.add(id);
    let level = 0, ready = 0;
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) continue;
      visit(dependency, path);
      level = Math.max(level, depth.get(dependency)! + 1);
      ready = Math.max(ready, finish.get(dependency)!);
    }
    path.delete(id);
    depth.set(id, level); finish.set(id, ready + duration(id));
  };
  for (const node of plan.nodes) visit(node.id, new Set());
  const perLevel = new Map<number, number>();
  for (const node of plan.nodes) perLevel.set(depth.get(node.id)!, (perLevel.get(depth.get(node.id)!) ?? 0) + 1);
  const measuredTasks = plan.nodes.filter(node => span.has(node.id)).length;
  const serialMs = plan.nodes.reduce((total, node) => total + duration(node.id), 0);
  const complete = measuredTasks === plan.nodes.length;
  const criticalPathMs = complete ? Math.max(...plan.nodes.map(node => finish.get(node.id)!)) : null;
  return {
    schemaVersion: 'plan-parallelism/1', planHash: plan.hash, planVersion: plan.version, status: run.status,
    tasks: plan.nodes.length, roots: plan.nodes.filter(node => !node.dependsOn.some(dependency => nodes.has(dependency))).length,
    width: Math.max(...perLevel.values()), measuredTasks, serialMs, criticalPathMs,
    savableMs: criticalPathMs === null ? null : serialMs - criticalPathMs,
  };
}

/** Event fields that stay readable by SQL next to the sealed copy. */
export function runEventPlain(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (type !== PLAN_PARALLELISM_EVENT || data.schemaVersion !== 'plan-parallelism/1') return {};
  const keys = ['schemaVersion', 'planHash', 'planVersion', 'status', 'tasks', 'roots', 'width', 'measuredTasks', 'serialMs', 'criticalPathMs', 'savableMs'];
  return Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]]));
}
