import { randomUUID } from "node:crypto";
import type {
  AeeisSnapshot,
  CreateGoalInput,
  CreatePlanInput,
  Goal,
  Id,
  Plan,
  RunReceipt,
  TransitionTaskInput,
} from "../contracts.js";
import { createPlan, refreshReadyTasks, transitionTask } from "../domain/plan.js";
import type { AeeisStore } from "../adapters/in-memory-store.js";

export class AeeisService {
  public constructor(private readonly store: AeeisStore) {}

  createGoal(input: CreateGoalInput, now = new Date().toISOString()): Goal {
    if (!input.title.trim()) throw new Error("Goal title is required");
    const goal: Goal = {
      id: `goal_${randomUUID()}`,
      title: input.title.trim(),
      ...(input.description === undefined ? {} : { description: input.description }),
      status: "active",
      createdAt: now,
    };
    this.store.saveGoal(goal);
    return goal;
  }

  createPlan(input: CreatePlanInput, now = new Date().toISOString()): Plan {
    if (!this.store.getGoal(input.goalId)) throw new Error(`Unknown goal: ${input.goalId}`);
    const plan = createPlan(`plan_${randomUUID()}`, input.goalId, 1, input.nodes, now);
    this.store.savePlan(plan);
    return plan;
  }

  transitionTask(input: TransitionTaskInput, now = new Date().toISOString()): RunReceipt {
    const current = this.store.getPlan(input.planId);
    if (!current) throw new Error(`Unknown plan: ${input.planId}`);
    const result = transitionTask(current, input.taskId, input.transition, input.reason, now);
    const next = refreshReadyTasks(result.plan);
    this.store.savePlan(next);
    const receipt: RunReceipt = {
      id: `receipt_${randomUUID()}`,
      planId: input.planId,
      taskId: input.taskId,
      transition: input.transition,
      from: result.from,
      to: result.to,
      occurredAt: now,
      attempt: result.attempt,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    this.store.appendReceipt(receipt);
    return receipt;
  }

  getSnapshot(planId: Id): AeeisSnapshot {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    const goal = this.store.getGoal(plan.goalId);
    if (!goal) throw new Error(`Plan ${planId} references missing goal ${plan.goalId}`);
    return { goal, plan, receipts: this.store.getReceipts(planId) };
  }
}
