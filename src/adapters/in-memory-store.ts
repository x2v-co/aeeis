import type { ContextManifest, Goal, Id, MemoryEntry, Plan, RunReceipt } from "../contracts.js";

export interface AeeisStore {
  saveGoal(goal: Goal): Promise<void>;
  getGoal(id: Id): Promise<Goal | undefined>;
  getGoals(): Promise<Goal[]>;
  savePlan(plan: Plan): Promise<void>;
  getPlan(id: Id): Promise<Plan | undefined>;
  getPlans(goalId?: Id): Promise<Plan[]>;
  appendReceipt(receipt: RunReceipt): Promise<void>;
  getReceipts(planId: Id): Promise<RunReceipt[]>;
  saveMemory(memory: MemoryEntry): Promise<void>;
  getMemories(goalId?: Id): Promise<MemoryEntry[]>;
  saveContextManifest(manifest: ContextManifest): Promise<void>;
  getContextManifest(id: Id): Promise<ContextManifest | undefined>;
  close(): Promise<void>;
}

export class InMemoryStore implements AeeisStore {
  private readonly goals = new Map<Id, Goal>();
  private readonly plans = new Map<Id, Plan>();
  private readonly receipts = new Map<Id, RunReceipt[]>();
  private readonly memories = new Map<Id, MemoryEntry>();
  private readonly manifests = new Map<Id, ContextManifest>();

  async saveGoal(goal: Goal): Promise<void> {
    this.goals.set(goal.id, structuredClone(goal));
  }

  async getGoal(id: Id): Promise<Goal | undefined> {
    const goal = this.goals.get(id);
    return goal ? structuredClone(goal) : undefined;
  }

  async getGoals(): Promise<Goal[]> {
    return structuredClone([...this.goals.values()]);
  }

  async savePlan(plan: Plan): Promise<void> {
    this.plans.set(plan.id, structuredClone(plan));
  }

  async getPlan(id: Id): Promise<Plan | undefined> {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : undefined;
  }

  async getPlans(goalId?: Id): Promise<Plan[]> {
    return structuredClone([...this.plans.values()].filter((plan) => goalId === undefined || plan.goalId === goalId));
  }

  async appendReceipt(receipt: RunReceipt): Promise<void> {
    const existing = this.receipts.get(receipt.planId) ?? [];
    existing.push(structuredClone(receipt));
    this.receipts.set(receipt.planId, existing);
  }

  async getReceipts(planId: Id): Promise<RunReceipt[]> {
    return structuredClone(this.receipts.get(planId) ?? []);
  }

  async saveMemory(memory: MemoryEntry): Promise<void> {
    this.memories.set(memory.id, structuredClone(memory));
  }

  async getMemories(goalId?: Id): Promise<MemoryEntry[]> {
    return structuredClone(
      [...this.memories.values()].filter((memory) => goalId === undefined || memory.goalId === goalId),
    );
  }

  async saveContextManifest(manifest: ContextManifest): Promise<void> {
    this.manifests.set(manifest.id, structuredClone(manifest));
  }

  async getContextManifest(id: Id): Promise<ContextManifest | undefined> {
    const manifest = this.manifests.get(id);
    return manifest ? structuredClone(manifest) : undefined;
  }

  async close(): Promise<void> {}
}
