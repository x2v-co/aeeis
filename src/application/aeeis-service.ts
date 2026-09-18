import { randomUUID } from "node:crypto";
import type {
  AeeisSnapshot,
  ContextManifest,
  CreateContextInput,
  CreateGoalInput,
  CreateMemoryInput,
  CreatePlanInput,
  Goal,
  Id,
  Plan,
  RunReceipt,
  MemoryEntry,
  TransitionTaskInput,
} from "../contracts.js";
import { createPlan, refreshReadyTasks, transitionTask } from "../domain/plan.js";
import type { AeeisStore } from "../adapters/in-memory-store.js";
import type { KnowledgeProvider } from "../knowledge.js";

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

  createProjectPulsePlan(goalId: Id, now = new Date().toISOString()): Plan {
    const goal = this.getGoal(goalId);
    return this.createPlan({
      goalId,
      nodes: [
        { id: "understand", title: `Understand: ${goal.title}` },
        { id: "next_action", title: "Choose and execute the next action", dependsOn: ["understand"] },
        { id: "review", title: "Review outcome and capture learning", kind: "review", dependsOn: ["next_action"] },
      ],
    }, now);
  }

  transitionTask(input: TransitionTaskInput, now = new Date().toISOString()): RunReceipt {
    const current = this.store.getPlan(input.planId);
    if (!current) throw new Error(`Unknown plan: ${input.planId}`);
    const result = transitionTask(current, input.taskId, input.transition, input.reason, now);
    const next = refreshReadyTasks(result.plan);
    this.store.savePlan(next);
    if (next.nodes.every((node) => node.status === "succeeded")) {
      const goal = this.store.getGoal(next.goalId);
      if (goal) this.store.saveGoal({ ...goal, status: "completed" });
    }
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

  addMemory(goalId: Id, input: CreateMemoryInput, now = new Date().toISOString()): MemoryEntry {
    if (!this.store.getGoal(goalId)) throw new Error(`Unknown goal: ${goalId}`);
    if (!input.content.trim()) throw new Error("Memory content is required");
    const memory: MemoryEntry = {
      id: `memory_${randomUUID()}`,
      goalId,
      kind: input.kind,
      scope: input.scope ?? "project",
      content: input.content.trim(),
      source: input.source?.trim() || "user",
      confidence: clamp(input.confidence ?? 1),
      createdAt: now,
      updatedAt: now,
    };
    this.store.saveMemory(memory);
    return memory;
  }

  listMemories(goalId: Id): MemoryEntry[] {
    if (!this.store.getGoal(goalId)) throw new Error(`Unknown goal: ${goalId}`);
    return this.store.getMemories(goalId);
  }

  createContextManifest(goalId: Id, input: CreateContextInput, now = new Date().toISOString()): ContextManifest {
    if (!this.store.getGoal(goalId)) throw new Error(`Unknown goal: ${goalId}`);
    if (!input.purpose.trim()) throw new Error("Context purpose is required");
    const queryTerms = tokenize(input.query ?? "");
    const maxItems = Math.max(1, Math.min(input.maxItems ?? 8, 50));
    const memories = this.store
      .getMemories(goalId)
      .filter((memory) => memory.scope !== "private")
      .map((memory) => ({ memory, score: scoreMemory(memory.content, queryTerms) }))
      .filter(({ score }) => queryTerms.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, maxItems)
      .map(({ memory }) => memory);
    const privateMemoryCount = this.store
      .getMemories(goalId)
      .filter((memory) => memory.scope === "private").length;
    const manifest: ContextManifest = {
      id: `ctx_${randomUUID()}`,
      purpose: input.purpose.trim(),
      audience: input.audience ?? ["owner"],
      memoryRefs: memories.map((memory) => memory.id),
      included: memories.map(({ id, kind, content, source, confidence }) => ({ id, kind, content, source, confidence })),
      excluded: privateMemoryCount > 0 ? ["private memories omitted by scope policy"] : [],
      createdAt: now,
    };
    this.store.saveContextManifest(manifest);
    return manifest;
  }

  async createContextManifestWithKnowledge(goalId: Id, input: CreateContextInput, knowledge: KnowledgeProvider, now = new Date().toISOString()): Promise<ContextManifest> {
    const manifest = this.createContextManifest(goalId, input, now);
    const hits = await knowledge.search({
      query: input.query ?? '', maxItems: Math.max(1, Math.min(input.maxItems ?? 8, 50)),
      allowedClassifications: input.knowledgeClassifications ?? ['public', 'internal'], audience: input.audience?.[0] ?? 'owner',
    });
    const includedKnowledge = hits.map(({ record, score }) => ({ id: record.id, title: record.title, content: record.content.slice(0, 4000), source: record.source, classification: record.classification, contentHash: record.contentHash, score }));
    const next: ContextManifest = { ...manifest, knowledgeRefs: includedKnowledge.map(item => item.id), includedKnowledge };
    this.store.saveContextManifest(next);
    return next;
  }

  getSnapshot(planId: Id): AeeisSnapshot {
    const plan = this.store.getPlan(planId);
    if (!plan) throw new Error(`Unknown plan: ${planId}`);
    const goal = this.store.getGoal(plan.goalId);
    if (!goal) throw new Error(`Plan ${planId} references missing goal ${plan.goalId}`);
    return { goal, plan, receipts: this.store.getReceipts(planId), memories: this.store.getMemories(plan.goalId) };
  }

  getSnapshotForGoal(goalId: Id): AeeisSnapshot {
    const plan = this.listPlans(goalId)[0];
    if (!plan) {
      const goal = this.store.getGoal(goalId);
      if (!goal) throw new Error(`Unknown goal: ${goalId}`);
      throw new Error(`Goal ${goalId} has no plan`);
    }
    return this.getSnapshot(plan.id);
  }

  getGoal(goalId: Id): Goal {
    const goal = this.store.getGoal(goalId);
    if (!goal) throw new Error(`Unknown goal: ${goalId}`);
    return goal;
  }

  listPlans(goalId: Id): Plan[] {
    if (!this.store.getGoal(goalId)) throw new Error(`Unknown goal: ${goalId}`);
    // Stores intentionally expose a small MVP query through their plan IDs in a later adapter.
    // The current store contract is extended by this in-memory-compatible scan method.
    return this.store.getPlans(goalId);
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
}

function scoreMemory(content: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 1;
  const text = tokenize(content);
  return queryTerms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}
