import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { ContextManifest, Goal, Id, MemoryEntry, Plan, RunReceipt } from "../contracts.js";
import type { AeeisStore } from "./in-memory-store.js";

interface StoreState {
  goals: Goal[];
  plans: Plan[];
  receipts: RunReceipt[];
  memories: MemoryEntry[];
  manifests: ContextManifest[];
}

const emptyState = (): StoreState => ({
  goals: [],
  plans: [],
  receipts: [],
  memories: [],
  manifests: [],
});

export class JsonFileStore implements AeeisStore {
  private state: StoreState = emptyState();
  private loaded = false;

  public constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = emptyState();
    }
    this.loaded = true;
  }

  async saveGoal(goal: Goal): Promise<void> {
    this.state.goals = replace(this.state.goals, goal);
    this.persist();
  }

  async getGoal(id: Id): Promise<Goal | undefined> {
    return clone(this.state.goals.find((goal) => goal.id === id));
  }

  async getGoals(): Promise<Goal[]> {
    return structuredClone(this.state.goals);
  }

  async savePlan(plan: Plan): Promise<void> {
    this.state.plans = replace(this.state.plans, plan);
    this.persist();
  }

  async getPlan(id: Id): Promise<Plan | undefined> {
    return clone(this.state.plans.find((plan) => plan.id === id));
  }

  async getPlans(goalId?: Id): Promise<Plan[]> {
    return structuredClone(this.state.plans.filter((plan) => goalId === undefined || plan.goalId === goalId));
  }

  async appendReceipt(receipt: RunReceipt): Promise<void> {
    this.state.receipts.push(structuredClone(receipt));
    this.persist();
  }

  async getReceipts(planId: Id): Promise<RunReceipt[]> {
    return structuredClone(this.state.receipts.filter((receipt) => receipt.planId === planId));
  }

  async saveMemory(memory: MemoryEntry): Promise<void> {
    this.state.memories = replace(this.state.memories, memory);
    this.persist();
  }

  async getMemories(goalId?: Id): Promise<MemoryEntry[]> {
    return structuredClone(this.state.memories.filter((memory) => goalId === undefined || memory.goalId === goalId));
  }

  async saveContextManifest(manifest: ContextManifest): Promise<void> {
    this.state.manifests = replace(this.state.manifests, manifest);
    this.persist();
  }

  async getContextManifest(id: Id): Promise<ContextManifest | undefined> {
    return clone(this.state.manifests.find((manifest) => manifest.id === id));
  }

  async close(): Promise<void> {}

  private persist(): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, "wx", 0o600);
      writeSync(descriptor, serialized, undefined, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(tempPath, this.filePath);
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(tempPath); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }
}

function replace<T extends { id: Id }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, structuredClone(item)];
  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? structuredClone(item) : candidate,
  );
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}
