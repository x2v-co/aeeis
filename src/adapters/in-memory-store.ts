import type { ContextManifest, Goal, Id, MemoryEntry, Plan, RunReceipt } from "../contracts.js";

export interface AeeisStore {
  saveGoal(goal: Goal): void;
  getGoal(id: Id): Goal | undefined;
  getGoals(): Goal[];
  savePlan(plan: Plan): void;
  getPlan(id: Id): Plan | undefined;
  getPlans(goalId?: Id): Plan[];
  appendReceipt(receipt: RunReceipt): void;
  getReceipts(planId: Id): RunReceipt[];
  saveMemory(memory: MemoryEntry): void;
  getMemories(goalId?: Id): MemoryEntry[];
  saveContextManifest(manifest: ContextManifest): void;
  getContextManifest(id: Id): ContextManifest | undefined;
}

export class InMemoryStore implements AeeisStore {
  private readonly goals = new Map<Id, Goal>();
  private readonly plans = new Map<Id, Plan>();
  private readonly receipts = new Map<Id, RunReceipt[]>();
  private readonly memories = new Map<Id, MemoryEntry>();
  private readonly manifests = new Map<Id, ContextManifest>();

  saveGoal(goal: Goal): void {
    this.goals.set(goal.id, structuredClone(goal));
  }

  getGoal(id: Id): Goal | undefined {
    const goal = this.goals.get(id);
    return goal ? structuredClone(goal) : undefined;
  }

  getGoals(): Goal[] {
    return structuredClone([...this.goals.values()]);
  }

  savePlan(plan: Plan): void {
    this.plans.set(plan.id, structuredClone(plan));
  }

  getPlan(id: Id): Plan | undefined {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : undefined;
  }

  getPlans(goalId?: Id): Plan[] {
    return structuredClone([...this.plans.values()].filter((plan) => goalId === undefined || plan.goalId === goalId));
  }

  appendReceipt(receipt: RunReceipt): void {
    const existing = this.receipts.get(receipt.planId) ?? [];
    existing.push(structuredClone(receipt));
    this.receipts.set(receipt.planId, existing);
  }

  getReceipts(planId: Id): RunReceipt[] {
    return structuredClone(this.receipts.get(planId) ?? []);
  }

  saveMemory(memory: MemoryEntry): void {
    this.memories.set(memory.id, structuredClone(memory));
  }

  getMemories(goalId?: Id): MemoryEntry[] {
    return structuredClone(
      [...this.memories.values()].filter((memory) => goalId === undefined || memory.goalId === goalId),
    );
  }

  saveContextManifest(manifest: ContextManifest): void {
    this.manifests.set(manifest.id, structuredClone(manifest));
  }

  getContextManifest(id: Id): ContextManifest | undefined {
    const manifest = this.manifests.get(id);
    return manifest ? structuredClone(manifest) : undefined;
  }
}
