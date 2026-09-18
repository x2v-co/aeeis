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

export class AeeisNotFound extends Error {}
export class AeeisConflict extends Error {}

export class AeeisService {
  public constructor(private readonly store: AeeisStore) {}

  async createGoal(input: CreateGoalInput, now = new Date().toISOString()): Promise<Goal> {
    if (!input.title.trim()) throw new Error("Goal title is required");
    const goal: Goal = {
      id: `goal_${randomUUID()}`,
      title: input.title.trim(),
      ...(input.description === undefined ? {} : { description: input.description }),
      status: "active",
      createdAt: now,
    };
    await this.store.saveGoal(goal);
    return goal;
  }

  async createPlan(input: CreatePlanInput, now = new Date().toISOString()): Promise<Plan> {
    if (!(await this.store.getGoal(input.goalId))) throw new AeeisNotFound(`Unknown goal: ${input.goalId}`);
    const plan = createPlan(`plan_${randomUUID()}`, input.goalId, 1, input.nodes, now);
    await this.store.savePlan(plan);
    return plan;
  }

  /** Create an immutable successor plan for a goal. Older plan versions remain
   * addressable so execution receipts and evidence can still point to them. */
  async createPlanRevision(input: CreatePlanInput, now = new Date().toISOString()): Promise<Plan> {
    if (!(await this.store.getGoal(input.goalId))) throw new AeeisNotFound(`Unknown goal: ${input.goalId}`);
    const versions = await this.store.getPlans(input.goalId);
    const nextVersion = versions.reduce((maximum, plan) => Math.max(maximum, plan.version), 0) + 1;
    const plan = createPlan(`plan_${randomUUID()}`, input.goalId, nextVersion, input.nodes, now);
    await this.store.savePlan(plan);
    return plan;
  }

  async createProjectPulsePlan(goalId: Id, now = new Date().toISOString()): Promise<Plan> {
    const goal = await this.getGoal(goalId);
    return this.createPlan({
      goalId,
      nodes: [
        { id: "understand", title: `Understand: ${goal.title}` },
        { id: "next_action", title: "Choose and execute the next action", dependsOn: ["understand"] },
        { id: "review", title: "Review outcome and capture learning", kind: "review", dependsOn: ["next_action"] },
      ],
    }, now);
  }

  async transitionTask(input: TransitionTaskInput, now = new Date().toISOString()): Promise<RunReceipt> {
    const current = await this.store.getPlan(input.planId);
    if (!current) throw new AeeisNotFound(`Unknown plan: ${input.planId}`);
    const result = transitionTask(current, input.taskId, input.transition, input.reason, now);
    const next = refreshReadyTasks(result.plan);
    await this.store.savePlan(next);
    if (next.nodes.every((node) => node.status === "succeeded")) {
      const goal = await this.store.getGoal(next.goalId);
      if (goal) await this.store.saveGoal({ ...goal, status: "completed" });
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
    await this.store.appendReceipt(receipt);
    return receipt;
  }

  async addMemory(goalId: Id, input: CreateMemoryInput, now = new Date().toISOString()): Promise<MemoryEntry> {
    if (!(await this.store.getGoal(goalId))) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
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
    await this.store.saveMemory(memory);
    return memory;
  }

  async listMemories(goalId: Id): Promise<MemoryEntry[]> {
    if (!(await this.store.getGoal(goalId))) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
    return this.store.getMemories(goalId);
  }

  async createContextManifest(goalId: Id, input: CreateContextInput, now = new Date().toISOString()): Promise<ContextManifest> {
    if (!(await this.store.getGoal(goalId))) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
    if (!input.purpose.trim()) throw new Error("Context purpose is required");
    const queryTerms = tokenize(input.query ?? "");
    const maxItems = Math.max(1, Math.min(input.maxItems ?? 8, 50));
    const memories = (await this.store.getMemories(goalId))
      .filter((memory) => memory.scope !== "private")
      .map((memory) => ({ memory, score: scoreMemory(memory.content, queryTerms) }))
      .filter(({ score }) => queryTerms.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, maxItems)
      .map(({ memory }) => memory);
    const privateMemoryCount = (await this.store.getMemories(goalId))
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
    await this.store.saveContextManifest(manifest);
    return manifest;
  }

  async createContextManifestWithKnowledge(goalId: Id, input: CreateContextInput, knowledge: KnowledgeProvider, now = new Date().toISOString()): Promise<ContextManifest> {
    const manifest = await this.createContextManifest(goalId, input, now);
    const hits = await knowledge.search({
      query: input.query ?? '', maxItems: Math.max(1, Math.min(input.maxItems ?? 8, 50)),
      allowedClassifications: input.knowledgeClassifications ?? ['public', 'internal'], audience: input.audience?.[0] ?? 'owner',
    });
    const includedKnowledge = hits.map(({ record, score }) => ({ id: record.id, title: record.title, content: record.content.slice(0, 4000), source: record.source, classification: record.classification, contentHash: record.contentHash, score }));
    const next: ContextManifest = { ...manifest, knowledgeRefs: includedKnowledge.map(item => item.id), includedKnowledge };
    await this.store.saveContextManifest(next);
    return next;
  }

  async getSnapshot(planId: Id): Promise<AeeisSnapshot> {
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new AeeisNotFound(`Unknown plan: ${planId}`);
    const goal = await this.store.getGoal(plan.goalId);
    if (!goal) throw new AeeisNotFound(`Plan ${planId} references missing goal ${plan.goalId}`);
    return { goal, plan, receipts: await this.store.getReceipts(planId), memories: await this.store.getMemories(plan.goalId) };
  }

  async getSnapshotForGoal(goalId: Id): Promise<AeeisSnapshot> {
    const plan = (await this.listPlans(goalId))[0];
    if (!plan) {
      const goal = await this.store.getGoal(goalId);
      if (!goal) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
      throw new Error(`Goal ${goalId} has no plan`);
    }
    return this.getSnapshot(plan.id);
  }

  async getGoal(goalId: Id): Promise<Goal> {
    const goal = await this.store.getGoal(goalId);
    if (!goal) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
    return goal;
  }

  async listGoals(): Promise<Goal[]> {
    return (await this.store.getGoals()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listPlans(goalId: Id): Promise<Plan[]> {
    if (!(await this.store.getGoal(goalId))) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
    return (await this.store.getPlans(goalId)).sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
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
