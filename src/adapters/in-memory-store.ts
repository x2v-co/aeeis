import type { Goal, Id, Plan, RunReceipt } from "../contracts.js";

export interface AeeisStore {
  saveGoal(goal: Goal): void;
  getGoal(id: Id): Goal | undefined;
  savePlan(plan: Plan): void;
  getPlan(id: Id): Plan | undefined;
  appendReceipt(receipt: RunReceipt): void;
  getReceipts(planId: Id): RunReceipt[];
}

export class InMemoryStore implements AeeisStore {
  private readonly goals = new Map<Id, Goal>();
  private readonly plans = new Map<Id, Plan>();
  private readonly receipts = new Map<Id, RunReceipt[]>();

  saveGoal(goal: Goal): void {
    this.goals.set(goal.id, structuredClone(goal));
  }

  getGoal(id: Id): Goal | undefined {
    const goal = this.goals.get(id);
    return goal ? structuredClone(goal) : undefined;
  }

  savePlan(plan: Plan): void {
    this.plans.set(plan.id, structuredClone(plan));
  }

  getPlan(id: Id): Plan | undefined {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : undefined;
  }

  appendReceipt(receipt: RunReceipt): void {
    const existing = this.receipts.get(receipt.planId) ?? [];
    existing.push(structuredClone(receipt));
    this.receipts.set(receipt.planId, existing);
  }

  getReceipts(planId: Id): RunReceipt[] {
    return structuredClone(this.receipts.get(planId) ?? []);
  }
}
