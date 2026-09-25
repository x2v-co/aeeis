import { afterCollectionCursor, afterVersionCursor, decodeCollectionCursor, decodeVersionCursor, encodeCollectionCursor, encodeVersionCursor, recentFirst, scopedRecent, validateCollectionLimit, visibleRooms } from './collection-query.js';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import type { ContextManifest, Goal, Id, MemoryEntry, Plan, ProjectionIntent, RunReceipt, Room } from "../contracts.js";
import { assertMemoryCommit, assertRoomCommit, assertTaskCommit } from './task-commit.js';

export interface AeeisStore {
  commitRoomCreation(room: Room, intents?: ProjectionIntent[]): Promise<void>;
  commitRoomUpdate(expected: Room, next: Room, intents?: ProjectionIntent[]): Promise<void>;
  getRoom(id: Id): Promise<Room | undefined>;
  getRooms(scope?: Ownership, limit?: number, memberRoomIds?: string[]): Promise<Room[]>;
  getRoomsPage?(limit: number, cursor?: string): Promise<RoomPage>;
  commitGoalCreation(goal: Goal, intents?: ProjectionIntent[]): Promise<void>;
  commitPlanCreation(plan: Plan, intents?: ProjectionIntent[], reopenGoal?: boolean): Promise<void>;
  commitTaskTransition(expected: Plan, next: Plan, receipt: RunReceipt, intents?: ProjectionIntent[]): Promise<void>;
  saveGoal(goal: Goal): Promise<void>;
  getGoal(id: Id): Promise<Goal | undefined>;
  getGoals(scope?: Ownership, limit?: number): Promise<Goal[]>;
  getReadableGoals?(scope: Ownership, memberRoomIds: readonly string[]): Promise<Goal[]>;
  getGoalsPage?(scope: Ownership, limit: number, cursor?: string): Promise<GoalPage>;
  savePlan(plan: Plan): Promise<void>;
  getPlan(id: Id): Promise<Plan | undefined>;
  getPlans(goalId?: Id): Promise<Plan[]>;
  getPlansPage?(goalId: Id, limit: number, cursor?: string): Promise<PlanPage>;
  appendReceipt(receipt: RunReceipt): Promise<void>;
  getReceipts(planId: Id): Promise<RunReceipt[]>;
  saveMemory(memory: MemoryEntry): Promise<void>;
  commitMemoryUpdate(expected: MemoryEntry, next: MemoryEntry): Promise<void>;
  commitMemoryRevision(previous: MemoryEntry, next: MemoryEntry): Promise<void>;
  getMemories(goalId?: Id, limit?: number): Promise<MemoryEntry[]>;
  saveContextManifest(manifest: ContextManifest): Promise<void>;
  getContextManifest(id: Id): Promise<ContextManifest | undefined>;
  listProjectionIntents(): Promise<ProjectionIntent[]>;
  markProjectionIntentDispatched(id: Id, dispatchedAt?: string): Promise<void>;
  close(): Promise<void>;
}
export interface GoalPage { goals: Goal[]; nextCursor?: string }
export interface PlanPage { plans: Plan[]; nextCursor?: string }
export interface RoomPage { rooms: Room[]; nextCursor?: string }

export class InMemoryStore implements AeeisStore {
  private readonly rooms = new Map<Id, Room>();
  private readonly goals = new Map<Id, Goal>();
  private readonly plans = new Map<Id, Plan>();
  private readonly receipts = new Map<Id, RunReceipt[]>();
  private readonly memories = new Map<Id, MemoryEntry>();
  private readonly manifests = new Map<Id, ContextManifest>();
  private readonly projectionIntents = new Map<Id, ProjectionIntent>();

  async commitRoomCreation(room: Room, intents: ProjectionIntent[] = []): Promise<void> {
    this.rooms.set(room.id, structuredClone(room));
    for (const intent of intents) this.projectionIntents.set(intent.id, structuredClone(intent));
  }

  async commitRoomUpdate(expected: Room, next: Room, intents: ProjectionIntent[] = []): Promise<void> {
    assertRoomCommit(this.rooms.get(expected.id), expected, next);
    this.rooms.set(next.id, structuredClone(next));
    for (const intent of intents) this.projectionIntents.set(intent.id, structuredClone(intent));
  }

  async getRoom(id: Id): Promise<Room | undefined> { const room = this.rooms.get(id); return room ? structuredClone(room) : undefined; }
  async getRooms(scope?: Ownership, limit?: number, memberRoomIds?: string[]): Promise<Room[]> { return structuredClone(visibleRooms([...this.rooms.values()], scope, limit, memberRoomIds)); }
  async getRoomsPage(limit: number, cursor?: string): Promise<RoomPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const selected = [...this.rooms.values()].filter(room => afterCollectionCursor(room, room.updatedAt, pageCursor)).sort(recentFirst(room => room.updatedAt));
    const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { rooms: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
  }

  async commitGoalCreation(goal: Goal, intents: ProjectionIntent[] = []): Promise<void> {
    this.goals.set(goal.id, structuredClone(goal));
    for (const intent of intents) this.projectionIntents.set(intent.id, structuredClone(intent));
  }

  async commitPlanCreation(plan: Plan, intents: ProjectionIntent[] = [], reopenGoal = false): Promise<void> {
    const goal = this.goals.get(plan.goalId);
    if (!goal) throw new Error('Plan creation references missing goal');
    if ([...this.plans.values()].some(existing => existing.goalId === plan.goalId && existing.version === plan.version && existing.id !== plan.id)) {
      throw new Error('Plan version already exists');
    }
    this.plans.set(plan.id, structuredClone(plan));
    for (const intent of intents) this.projectionIntents.set(intent.id, structuredClone(intent));
    if (reopenGoal && goal.status !== 'active') this.goals.set(goal.id, { ...goal, status: 'active' });
  }

  async commitTaskTransition(expected: Plan, next: Plan, receipt: RunReceipt, intents: ProjectionIntent[] = []): Promise<void> {
    assertTaskCommit(this.plans.get(expected.id), expected, next, receipt);
    const goal = this.goals.get(next.goalId);
    if (!goal) throw new Error('Task commit references missing goal');
    this.plans.set(next.id, structuredClone(next));
    this.receipts.set(next.id, [...(this.receipts.get(next.id) ?? []), structuredClone(receipt)]);
    for (const intent of intents) this.projectionIntents.set(intent.id, structuredClone(intent));
    if (next.nodes.every(node => node.status === 'succeeded')) this.goals.set(goal.id, { ...goal, status: 'completed' });
  }

  async saveGoal(goal: Goal): Promise<void> {
    this.goals.set(goal.id, structuredClone(goal));
  }

  async getGoal(id: Id): Promise<Goal | undefined> {
    const goal = this.goals.get(id);
    return goal ? structuredClone(goal) : undefined;
  }

  async getGoals(scope?: Ownership, limit?: number): Promise<Goal[]> {
    return structuredClone(scopedRecent([...this.goals.values()], goal => goal.createdAt, scope, limit));
  }
  async getReadableGoals(scope: Ownership, memberRoomIds: readonly string[]): Promise<Goal[]> {
    const roomIds = new Set(memberRoomIds);
    return structuredClone([...this.goals.values()].filter(goal => isOwnedBy(goal, scope) || ((goal.tenantId ?? 'local') === scope.tenantId && goal.roomId !== undefined && roomIds.has(goal.roomId))));
  }
  async getGoalsPage(scope: Ownership, limit: number, cursor?: string): Promise<GoalPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeCollectionCursor(cursor);
    const selected = [...this.goals.values()].filter(goal => isOwnedBy(goal, scope) && afterCollectionCursor(goal, goal.createdAt, pageCursor)).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { goals: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.createdAt, id: visible.at(-1)!.id }) } : {}) };
  }

  async savePlan(plan: Plan): Promise<void> {
    if ([...this.plans.values()].some(existing => existing.goalId === plan.goalId && existing.version === plan.version && existing.id !== plan.id)) {
      throw new Error('Plan version already exists');
    }
    this.plans.set(plan.id, structuredClone(plan));
  }

  async getPlan(id: Id): Promise<Plan | undefined> {
    const plan = this.plans.get(id);
    return plan ? structuredClone(plan) : undefined;
  }

  async getPlans(goalId?: Id): Promise<Plan[]> {
    return structuredClone([...this.plans.values()].filter((plan) => goalId === undefined || plan.goalId === goalId));
  }
  async getPlansPage(goalId: Id, limit: number, cursor?: string): Promise<PlanPage> {
    validateCollectionLimit(limit);
    const pageCursor = decodeVersionCursor(cursor);
    const selected = [...this.plans.values()].filter(plan => plan.goalId === goalId && afterVersionCursor(plan, pageCursor)).sort((left, right) => right.version - left.version || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const page = selected.slice(0, limit + 1); const hasMore = page.length > limit; const visible = hasMore ? page.slice(0, limit) : page;
    return { plans: structuredClone(visible), ...(hasMore && visible.length ? { nextCursor: encodeVersionCursor({ version: visible.at(-1)!.version, id: visible.at(-1)!.id }) } : {}) };
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

  async commitMemoryUpdate(expected: MemoryEntry, next: MemoryEntry): Promise<void> {
    assertMemoryCommit(this.memories.get(expected.id), expected, next);
    this.memories.set(next.id, structuredClone(next));
  }

  async commitMemoryRevision(previous: MemoryEntry, next: MemoryEntry): Promise<void> {
    assertMemoryCommit(this.memories.get(previous.id), previous, previous);
    if (this.memories.has(next.id)) throw new Error('Memory revision already exists');
    this.memories.set(previous.id, structuredClone({ ...previous, state: 'superseded', updatedAt: next.updatedAt }));
    this.memories.set(next.id, structuredClone(next));
  }

  async getMemories(goalId?: Id, limit?: number): Promise<MemoryEntry[]> {
    validateCollectionLimit(limit);
    const memories = [...this.memories.values()].filter((memory) => goalId === undefined || memory.goalId === goalId);
    if (limit !== undefined) memories.sort(recentFirst(memory => memory.updatedAt));
    return structuredClone(limit === undefined ? memories : memories.slice(0, limit));
  }

  async saveContextManifest(manifest: ContextManifest): Promise<void> {
    this.manifests.set(manifest.id, structuredClone(manifest));
  }

  async getContextManifest(id: Id): Promise<ContextManifest | undefined> {
    const manifest = this.manifests.get(id);
    return manifest ? structuredClone(manifest) : undefined;
  }

  async listProjectionIntents(): Promise<ProjectionIntent[]> { return structuredClone([...this.projectionIntents.values()].filter(intent => intent.status === 'pending')); }
  async markProjectionIntentDispatched(id: Id, dispatchedAt = new Date().toISOString()): Promise<void> {
    const intent = this.projectionIntents.get(id); if (!intent) return;
    this.projectionIntents.set(id, { ...intent, status: 'dispatched', dispatchedAt });
  }

  async close(): Promise<void> {}
}
