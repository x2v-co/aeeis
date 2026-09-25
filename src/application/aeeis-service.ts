import { afterCollectionCursor, decodeCollectionCursor, encodeCollectionCursor, recentFirst, validateCollectionLimit } from '../adapters/collection-query.js';
import { randomUUID } from "node:crypto";
import type {
  AeeisSnapshot,
  ContextManifest,
  CreateContextInput,
  CreateSessionContextInput,
  CreateGoalInput,
  CreateRoomInput,
  UpdateRoomInput,
  CreateMemoryInput,
  CreatePlanInput,
  Goal,
  Id,
  Plan,
  RunReceipt,
  MemoryEntry,
  ProjectionAggregateType,
  ProjectionIntent,
  Room,
  TransitionTaskInput,
} from "../contracts.js";
import { createPlan, refreshReadyTasks, transitionTask } from "../domain/plan.js";
import type { AeeisStore, GoalPage, PlanPage, RoomPage } from "../adapters/in-memory-store.js";
import { MemoryWriteConflict, PlanWriteConflict, RoomWriteConflict } from "../adapters/task-commit.js";
import { principalAudience, validatePrincipal } from '../security/principal.js';
import { RoomMembershipConflict, RoomMembershipNotFound, type RoomMember, type RoomMemberRole, type RoomMembershipRepository } from '../room-membership.js';
import { isAudienceAllowed, normalizeKnowledgeSearchResult, validateKnowledgeHits, type KnowledgeProvider } from "../knowledge.js";
import { contextAudienceSnapshotSchema, createContextAudienceSnapshot, type ContextAudienceSnapshot } from '../context-audience.js';
import { goalContextSourceHash } from '../context-manifest-binding.js';
import { PrincipalDirectoryUnavailable, type PrincipalDirectory } from '../security/principal-directory.js';

export class AeeisNotFound extends Error {}
export class AeeisConflict extends Error {}

export interface ProjectionTarget {
  channel: string;
  destination: string;
  aggregateTypes?: ProjectionAggregateType[] | undefined;
}

export interface ProjectionIntentSink {
  enqueue(input: { channel: string; destination: string; aggregateType: ProjectionAggregateType; aggregateId: string; payload: unknown; idempotencyKey: string; owner?: string; tenantId?: string }): Promise<unknown>;
}

export class AeeisService {
  public constructor(private readonly store: AeeisStore, private readonly projectionTargets: ProjectionTarget[] = [], private readonly memberships?: RoomMembershipRepository, private readonly principalDirectory?: PrincipalDirectory) {}

  async createRoom(input: CreateRoomInput, now = new Date().toISOString(), owner = 'owner', tenantId = 'local'): Promise<Room> {
    validatePrincipal({ id: owner, tenantId, roles: ['owner'] });
    if (!input.title.trim()) throw new Error('Room title is required');
    const room: Room = { id: `room_${randomUUID()}`, owner, tenantId, title: input.title.trim(), ...(input.description === undefined ? {} : { description: input.description }), status: 'active', createdAt: now, updatedAt: now };
    await this.store.commitRoomCreation(room, this.buildRoomProjectionIntents(room));
    return room;
  }

  async updateRoom(roomId: Id, input: UpdateRoomInput, now = new Date().toISOString(), owner = 'owner', tenantId = 'local'): Promise<Room> {
    validatePrincipal({ id: owner, tenantId, roles: ['owner'] });
    if (input.title !== undefined && !input.title.trim()) throw new Error('Room title is required');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.store.getRoom(roomId);
      if (!current || (current.tenantId ?? 'local') !== tenantId) throw new AeeisNotFound(`Unknown room: ${roomId}`);
      const role = await this.roomRole(current, owner, tenantId);
      if (role === undefined) throw new AeeisNotFound(`Unknown room: ${roomId}`);
      if (role !== 'owner' && role !== 'editor') throw new RoomMembershipConflict('Room editor role required');
      if (role !== 'owner' && input.status !== undefined) throw new RoomMembershipConflict('Only the Room owner can archive a Room');
      const next: Room = {
        ...current,
        ...(input.title === undefined ? {} : { title: input.title.trim() }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        updatedAt: now,
      };
      try {
        await this.store.commitRoomUpdate(current, next, this.buildRoomProjectionIntents(next, 'updated'));
        return next;
      } catch (error) {
        if (!(error instanceof RoomWriteConflict)) throw error;
      }
    }
    throw new AeeisConflict('Room is busy; retry the update');
  }

  async getRoomForPrincipal(roomId: Id, principalId = 'owner', tenantId = 'local'): Promise<Room> {
    const room = await this.store.getRoom(roomId);
    if (!room || (room.tenantId ?? 'local') !== tenantId) throw new AeeisNotFound(`Unknown room: ${roomId}`);
    if (!this.owns(room, principalId, tenantId)) {
      const member = this.memberships ? await this.memberships.get(roomId, principalId, tenantId) : undefined;
      if (!member || member.status !== 'active') throw new AeeisNotFound(`Unknown room: ${roomId}`);
      return room ?? (() => { throw new AeeisNotFound(`Unknown room: ${roomId}`); })();
    }
    return room;
  }

  async listRoomsForPrincipal(principalId = 'owner', tenantId = 'local', limit?: number): Promise<Room[]> {
    validateCollectionLimit(limit);
    const memberRoomIds = this.memberships ? await this.memberships.activeRoomIds(principalId, tenantId) : [];
    return this.store.getRooms({ owner: principalId, tenantId }, limit, memberRoomIds);
  }

  /** Internal projection view. The projector is allowed to rediscover every
   * canonical Room so membership changes converge even though membership and
   * domain stores are separate durable boundaries. HTTP callers use the
   * principal-scoped methods above instead. */
  async listRoomsForProjection(): Promise<Array<{ room: Room; members: RoomMember[] }>> {
    const rooms = await this.store.getRooms();
    const members = this.memberships?.listForRooms ? await this.memberships.listForRooms(rooms.map(room => room.id)) : undefined;
    const membersByRoom = new Map<string, RoomMember[]>();
    for (const member of members ?? []) membersByRoom.set(member.roomId, [...(membersByRoom.get(member.roomId) ?? []), member]);
    return members
      ? rooms.map(room => ({ room, members: membersByRoom.get(room.id) ?? [] }))
      : Promise.all(rooms.map(async room => ({ room, members: this.memberships ? await this.memberships.list(room.id, room.tenantId ?? 'local') : [] })));
  }

  async pageRoomsForProjection(limit: number, cursor?: string): Promise<RoomPage & { items: Array<{ room: Room; members: RoomMember[] }> }> {
    validateCollectionLimit(limit);
    let page: RoomPage;
    if (this.store.getRoomsPage) {
      page = await this.store.getRoomsPage(limit, cursor);
    } else {
      const pageCursor = decodeCollectionCursor(cursor);
      const selected = (await this.store.getRooms()).filter(room => afterCollectionCursor(room, room.updatedAt, pageCursor)).sort(recentFirst(room => room.updatedAt));
      const rows = selected.slice(0, limit + 1); const hasMore = rows.length > limit; const visible = hasMore ? rows.slice(0, limit) : rows;
      page = { rooms: visible, ...(hasMore && visible.length ? { nextCursor: encodeCollectionCursor({ timestamp: visible.at(-1)!.updatedAt, id: visible.at(-1)!.id }) } : {}) };
    }
    const members = this.memberships?.listForRooms ? await this.memberships.listForRooms(page.rooms.map(room => room.id)) : undefined;
    const membersByRoom = new Map<string, RoomMember[]>();
    for (const member of members ?? []) membersByRoom.set(member.roomId, [...(membersByRoom.get(member.roomId) ?? []), member]);
    const items = members
      ? page.rooms.map(room => ({ room, members: membersByRoom.get(room.id) ?? [] }))
      : await Promise.all(page.rooms.map(async room => ({ room, members: this.memberships ? await this.memberships.list(room.id, room.tenantId ?? 'local') : [] })));
    return { ...page, items };
  }

  /**
   * Return the canonical Room snapshot used by an explicit projection request.
   * Membership is a separate durable boundary, so the projection payload must
   * include the latest membership snapshot instead of exposing the Room row
   * alone. The principal check remains the same as the HTTP Room API.
   */
  async getRoomProjectionForPrincipal(roomId: Id, principalId = 'owner', tenantId = 'local'): Promise<Room & { members: RoomMember[] }> {
    const room = await this.getRoomForPrincipal(roomId, principalId, tenantId);
    // A Room projection is an external side effect and includes the current
    // membership snapshot. Reading a Room is sufficient for a viewer, but
    // publishing that snapshot requires the same editor boundary used for
    // Room metadata and membership changes.
    const role = await this.roomRole(room, principalId, tenantId);
    if (role !== 'owner' && role !== 'editor') throw new RoomMembershipConflict('Room editor role required to project a Room');
    const members = this.memberships ? await this.memberships.list(room.id, tenantId) : [];
    return { ...room, members };
  }

  async listGoalsInRoomForPrincipal(roomId: Id, principalId = 'owner', tenantId = 'local'): Promise<Goal[]> {
    await this.getRoomForPrincipal(roomId, principalId, tenantId);
    return (await this.store.getGoals()).filter(goal => goal.roomId === roomId && (goal.tenantId ?? 'local') === tenantId);
  }

  async addRoomMember(roomId: Id, principalId: string, role: Exclude<RoomMemberRole, 'owner'>, invitedBy = 'owner', tenantId = 'local', now = new Date().toISOString()): Promise<RoomMember> {
    if (!this.memberships) throw new AeeisConflict('Room membership store is not configured');
    const room = await this.getRoomForPrincipal(roomId, invitedBy, tenantId);
    const inviterRole = await this.roomRole(room, invitedBy, tenantId);
    if (inviterRole !== 'owner' && inviterRole !== 'editor') throw new RoomMembershipConflict('Room editor role required to manage members');
    if (principalId === (room.owner ?? 'owner')) throw new RoomMembershipConflict('Room owner is already a member');
    if (!['editor', 'viewer', 'agent'].includes(role)) throw new RoomMembershipConflict('Invalid room member role');
    if (this.principalDirectory) {
      let entry;
      try { entry = await this.principalDirectory.lookup(principalId, tenantId); }
      catch (error) {
        if (error instanceof PrincipalDirectoryUnavailable) throw error;
        throw error;
      }
      if (!entry || entry.principalId !== principalId || entry.tenantId !== tenantId) throw new RoomMembershipConflict('Target principal is not in this tenant');
      if (entry.status !== 'active') throw new RoomMembershipConflict('Target principal is not active');
    }
    return this.memberships.add(room.id, principalId, tenantId, role, invitedBy, now);
  }

  async listRoomMembers(roomId: Id, owner = 'owner', tenantId = 'local'): Promise<RoomMember[]> {
    await this.getRoomForPrincipal(roomId, owner, tenantId);
    if (!this.memberships) return [];
    return this.memberships.list(roomId, tenantId);
  }

  /** Shared Session writers are explicit Room owners, editors or admitted
   * agents. Viewers retain read access but cannot publish canonical events. */
  async assertRoomEventWriter(roomId: Id, principalId = 'owner', tenantId = 'local'): Promise<Room> {
    const room = await this.getRoomForPrincipal(roomId, principalId, tenantId);
    const role = await this.roomRole(room, principalId, tenantId);
    if (!role || !['owner', 'editor', 'agent'].includes(role)) throw new RoomMembershipConflict('Room writer role required for Session events');
    return room;
  }

  async revokeRoomMember(roomId: Id, principalId: string, revokedBy = 'owner', tenantId = 'local', now = new Date().toISOString()): Promise<RoomMember> {
    if (!this.memberships) throw new AeeisConflict('Room membership store is not configured');
    const room = await this.getRoomForPrincipal(roomId, revokedBy, tenantId);
    const revokerRole = await this.roomRole(room, revokedBy, tenantId);
    if (revokerRole !== 'owner' && revokerRole !== 'editor') throw new RoomMembershipConflict('Room editor role required to manage members');
    if (principalId === (room.owner ?? 'owner')) throw new RoomMembershipConflict('Room owner cannot be revoked');
    return this.memberships.revoke(roomId, principalId, tenantId, revokedBy, now);
  }

  private async roomRole(room: Room, principalId: string, tenantId: string): Promise<RoomMemberRole | undefined> {
    if (this.owns(room, principalId, tenantId)) return 'owner';
    const member = this.memberships ? await this.memberships.get(room.id, principalId, tenantId) : undefined;
    return member?.status === 'active' ? member.role : undefined;
  }

  async getRoom(roomId: Id, owner = 'owner', tenantId = 'local'): Promise<Room> {
    const room = await this.store.getRoom(roomId);
    if (!room || !this.owns(room, owner, tenantId)) throw new AeeisNotFound(`Unknown room: ${roomId}`);
    return room;
  }

  async listRooms(owner = 'owner', tenantId = 'local'): Promise<Room[]> {
    return (await this.store.getRooms()).filter(room => this.owns(room, owner, tenantId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listGoalsInRoom(roomId: Id, owner = 'owner', tenantId = 'local'): Promise<Goal[]> {
    await this.getRoom(roomId, owner, tenantId);
    return (await this.listGoals(owner, tenantId)).filter(goal => goal.roomId === roomId);
  }

  async createGoal(input: CreateGoalInput, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<Goal> {
    validatePrincipal({ id: owner, tenantId, roles: ['owner'] });
    if (!input.title.trim()) throw new Error("Goal title is required");
    if (input.roomId) {
      const room = this.memberships ? await this.getRoomForPrincipal(input.roomId, owner, tenantId) : await this.getRoom(input.roomId, owner, tenantId);
      if (room.status !== 'active') throw new AeeisConflict('Archived room cannot receive new goals');
      if (this.memberships && !this.owns(room, owner, tenantId)) {
        const member = await this.memberships.get(room.id, owner, tenantId);
        if (!member || member.status !== 'active' || !['owner', 'editor'].includes(member.role)) throw new AeeisConflict('Room editor role required');
      }
    }
    const goal: Goal = {
      id: `goal_${randomUUID()}`,
      owner,
      tenantId,
      ...(input.roomId ? { roomId: input.roomId } : {}),
      title: input.title.trim(),
      ...(input.description === undefined ? {} : { description: input.description }),
      status: "active",
      createdAt: now,
    };
    await this.store.commitGoalCreation(goal, this.buildCreationProjectionIntents(goal));
    return goal!;
  }

  async createPlan(input: CreatePlanInput, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<Plan> {
    const goal = await this.assertEditorGoal(await this.store.getGoal(input.goalId), input.goalId, owner, tenantId);
    const plan = createPlan(`plan_${randomUUID()}`, input.goalId, 1, input.nodes, now);
    await this.store.commitPlanCreation(plan, this.buildPlanProjectionIntents(goal, plan));
    return plan;
  }

  /** Create an immutable successor plan for a goal. Older plan versions remain
   * addressable so execution receipts and evidence can still point to them. */
  async createPlanRevision(input: CreatePlanInput, now = new Date().toISOString(), owner = "owner", tenantId = "local", options: { reopenGoal?: boolean } = {}): Promise<Plan> {
    const goal = await this.assertEditorGoal(await this.store.getGoal(input.goalId), input.goalId, owner, tenantId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const versions = await this.store.getPlans(input.goalId);
      const nextVersion = versions.reduce((maximum, plan) => Math.max(maximum, plan.version), 0) + 1;
      const plan = createPlan(`plan_${randomUUID()}`, input.goalId, nextVersion, input.nodes, now);
      try {
        const projectionGoal = options.reopenGoal && goal.status !== 'active' ? { ...goal, status: 'active' as const } : goal;
        await this.store.commitPlanCreation(plan, this.buildPlanProjectionIntents(projectionGoal, plan), options.reopenGoal ?? false);
        return plan;
      } catch (error) {
        if (!isPlanVersionConflict(error)) throw error;
      }
    }
    throw new AeeisConflict('Plan revisions are busy; retry the replan');
  }

  async createProjectPulsePlan(goalId: Id, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<Plan> {
    const goal = await this.getGoal(goalId, owner, tenantId);
    return this.createPlan({
      goalId,
      nodes: [
        { id: "understand", title: `Understand: ${goal.title}` },
        { id: "next_action", title: "Choose and execute the next action", dependsOn: ["understand"] },
        { id: "review", title: "Review outcome and capture learning", kind: "review", dependsOn: ["next_action"] },
      ],
    }, now, owner, tenantId);
  }

  async transitionTask(input: TransitionTaskInput, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<RunReceipt> {
    // Recompute the transition after a stale read; never replay a stale Plan
    // snapshot over another task's committed state.
    for (let conflictCount = 0; conflictCount < 32; conflictCount++) {
      const current = await this.store.getPlan(input.planId);
      if (!current) throw new AeeisNotFound(`Unknown plan: ${input.planId}`);
      const goal = await this.assertParticipantGoal(await this.store.getGoal(current.goalId), current.goalId, owner, tenantId);
      const result = transitionTask(current, input.taskId, input.transition, input.reason, now);
      const next = refreshReadyTasks(result.plan);
      const receipt: RunReceipt = {
        id: `receipt_${randomUUID()}`, planId: input.planId, taskId: input.taskId,
        transition: input.transition, from: result.from, to: result.to,
        occurredAt: now, attempt: result.attempt,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
      const intents = this.buildProjectionIntents(goal, next, receipt);
      try {
        await this.store.commitTaskTransition(current, next, receipt, intents);
        return receipt;
      } catch (error) {
        if (!(error instanceof PlanWriteConflict)) throw error;
      }
    }
    throw new AeeisConflict('Plan is busy; retry the task transition');
  }

  async addMemory(goalId: Id, input: CreateMemoryInput, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<MemoryEntry> {
    this.assertOwnedGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    if (!input.content.trim()) throw new Error("Memory content is required");
    const evidenceRefs = [...new Set((input.evidenceRefs ?? []).map(ref => ref.trim()).filter(Boolean))];
    if (evidenceRefs.length > 100) throw new Error('A memory can reference at most 100 evidence items');
    const scope = input.scope ?? "project";
    const memory: MemoryEntry = {
      id: `memory_${randomUUID()}`,
      goalId,
      owner,
      tenantId,
      kind: input.kind,
      scope,
      classification: scope === 'private' ? 'private' : (input.classification ?? 'internal'),
      content: input.content.trim(),
      source: input.source?.trim() || "user",
      confidence: clamp(input.confidence ?? 1),
      version: 1,
      state: 'active',
      evidenceRefs,
      ...(input.evidenceRunId ? { evidenceRunId: input.evidenceRunId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveMemory(memory);
    return memory;
  }

  /** Create an append-only correction and retain the superseded version for audit. */
  async correctMemory(goalId: Id, memoryId: Id, input: CreateMemoryInput, now = new Date().toISOString(), owner = 'owner', tenantId = 'local'): Promise<MemoryEntry> {
    this.assertOwnedGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    const stored = (await this.store.getMemories(goalId)).find(memory => memory.id === memoryId);
    const previous = normalizeMemory(stored);
    if (!this.owns(previous, owner, tenantId)) throw new AeeisNotFound(`Unknown memory: ${memoryId}`);
    if (previous.state !== 'active') throw new AeeisConflict('Only an active memory can be corrected');
    if (!input.content.trim()) throw new Error('Memory content is required');
    const evidenceRefs = [...new Set((input.evidenceRefs ?? previous.evidenceRefs ?? []).map(ref => ref.trim()).filter(Boolean))];
    const next: MemoryEntry = {
      ...previous,
      id: `memory_${randomUUID()}`,
      kind: input.kind,
      scope: input.scope ?? previous.scope,
      classification: (input.scope ?? previous.scope) === 'private' ? 'private' : (input.classification ?? previous.classification ?? 'internal'),
      content: input.content.trim(),
      source: input.source?.trim() || previous.source,
      confidence: clamp(input.confidence ?? previous.confidence),
      version: (previous.version ?? 1) + 1,
      state: 'active',
      evidenceRefs,
      ...(input.evidenceRunId ?? previous.evidenceRunId ? { evidenceRunId: input.evidenceRunId ?? previous.evidenceRunId } : {}),
      supersedesId: previous.id,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.commitMemoryRevision(stored!, next);
      return next;
    } catch (error) {
      if (error instanceof MemoryWriteConflict) throw new AeeisConflict('Memory changed during correction; reload and retry');
      throw error;
    }
  }

  /** Retraction is durable and auditable; the content remains for evidence history. */
  async retractMemory(goalId: Id, memoryId: Id, reason: string, now = new Date().toISOString(), owner = 'owner', tenantId = 'local'): Promise<MemoryEntry> {
    this.assertOwnedGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    if (!reason.trim()) throw new Error('Memory retraction reason is required');
    const stored = (await this.store.getMemories(goalId)).find(memory => memory.id === memoryId);
    const current = normalizeMemory(stored);
    if (!this.owns(current, owner, tenantId)) throw new AeeisNotFound(`Unknown memory: ${memoryId}`);
    if (current.state !== 'active') throw new AeeisConflict('Only an active memory can be retracted');
    const next: MemoryEntry = { ...current, state: 'retracted', updatedAt: now, retractedAt: now, retractionReason: reason.trim() };
    try {
      await this.store.commitMemoryUpdate(stored!, next);
      return next;
    } catch (error) {
      if (error instanceof MemoryWriteConflict) throw new AeeisConflict('Memory changed during retraction; reload and retry');
      throw error;
    }
  }

  async listMemories(goalId: Id, owner = "owner", tenantId = "local", limit?: number): Promise<MemoryEntry[]> {
    validateCollectionLimit(limit);
    const goal = await this.assertReadableGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    const memories = (await this.store.getMemories(goalId, limit)).map(normalizeMemory);
    return this.owns(goal, owner, tenantId)
      ? memories.filter(memory => this.owns(memory, owner, tenantId))
      : memories.filter(memory => memory.state === 'active' && memory.scope !== 'private' && classificationRank(memory.classification ?? 'internal') <= classificationRank('internal'));
  }

  async createContextManifest(goalId: Id, input: CreateContextInput, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<ContextManifest> {
    const manifest = await this.buildContextManifest(goalId, input, now, owner, tenantId);
    await this.assertAudienceCurrent(manifest);
    await this.store.saveContextManifest(manifest);
    return manifest;
  }

  /** Compose published Goal contexts without acquiring any new data access. */
  async createSessionContextManifest(roomId: Id, input: CreateSessionContextInput, now = new Date().toISOString(), actor = 'owner', tenantId = 'local'): Promise<ContextManifest> {
    const room = await this.getRoomForPrincipal(roomId, actor, tenantId);
    const role = await this.roomRole(room, actor, tenantId);
    if (role !== 'owner' && role !== 'editor') throw new RoomMembershipConflict('Room editor role required');
    if (room.status !== 'active') throw new AeeisConflict('Archived Room cannot receive a new context manifest');
    if (!input.purpose.trim()) throw new AeeisConflict('Context purpose is required');
    if (!Array.isArray(input.contexts) || input.contexts.length < 1 || input.contexts.length > 20 || new Set(input.contexts.map(ref => ref.goalId)).size !== input.contexts.length) throw new AeeisConflict('Session context requires 1 to 20 unique Goals');
    const sources: ContextManifest[] = [];
    for (const ref of input.contexts) {
      const goal = await this.getGoal(ref.goalId, actor, tenantId);
      if (goal.roomId !== roomId) throw new AeeisConflict('All session context Goals must belong to the target Room');
      sources.push(await this.getContextManifest(ref.goalId, ref.contextManifestId, actor, tenantId));
    }
    const owner = room.owner ?? 'owner';
    // Reuse recipient selection, then bind authority to the actual Room owner.
    const sourceGoal = await this.getGoal(input.contexts[0]!.goalId, actor, tenantId);
    const captured = await this.captureContextAudience(sourceGoal, { purpose: input.purpose, ...(input.audience ? { audience: input.audience } : { audienceMode: 'room' }) }, now, owner, tenantId);
    const audienceSnapshot = createContextAudienceSnapshot({
      schemaVersion: 'context-audience/1', scope: 'room', roomId, capturedAt: now,
      participants: captured.participants.map(participant => participant.principalId === owner ? { ...participant, authority: 'room-owner' as const } : participant),
    });
    if (!audienceSnapshot.participants.some(participant => participant.principalId === actor)) throw new AeeisConflict('Session context must include its creator');
    const included = mergeContextItems(sources.flatMap(source => source.included));
    const includedKnowledge = mergeContextItems(sources.flatMap(source => source.includedKnowledge ?? []));
    const manifest: ContextManifest = {
      id: `ctx_${randomUUID()}`, roomId, goalIds: input.contexts.map(ref => ref.goalId),
      goalContextRefs: sources.map(source => ({ goalId: source.goalId!, contextManifestId: source.id, bindingHash: goalContextSourceHash(source) })),
      owner, tenantId, purpose: input.purpose.trim(), audience: audienceSnapshot.participants.map(participant => participant.audience), audienceSnapshot,
      memoryRefs: included.map(item => item.id), included, knowledgeRefs: includedKnowledge.map(item => item.id), includedKnowledge,
      excluded: [...new Set(sources.flatMap(source => source.excluded))], createdAt: now,
    };
    // Every recipient must be authorized for every source; being able to read
    // the Room alone never grants access to a Goal owner's private context.
    for (const participant of audienceSnapshot.participants) await this.assertSessionSources(manifest, participant.principalId, tenantId);
    await this.assertAudienceCurrent(manifest);
    await this.store.saveContextManifest(manifest);
    return manifest;
  }

  private async buildContextManifest(goalId: Id, input: CreateContextInput, now: string, owner: string, tenantId: string): Promise<ContextManifest> {
    const goal = this.assertOwnedGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    if (!input.purpose.trim()) throw new Error("Context purpose is required");
    const audienceSnapshot = await this.captureContextAudience(goal, input, now, owner, tenantId);
    const shared = audienceSnapshot.participants.length > 1;
    const queryTerms = tokenize(input.query ?? "");
    const maxItems = Math.max(1, Math.min(input.maxItems ?? 8, 50));
    const allowedClassifications = (input.memoryClassifications ?? ['public', 'internal']).filter(level => !shared || classificationRank(level) <= classificationRank('internal'));
    const allMemories = (await this.store.getMemories(goalId)).map(normalizeMemory).filter(memory => this.owns(memory, owner, tenantId));
    const memories = allMemories
      .filter((memory) => memory.state === 'active' && memory.scope !== "private")
      .filter((memory) => allowedClassifications.includes(memory.classification ?? 'internal'))
      .map((memory) => ({ memory, score: scoreMemory(`${memory.kind} ${memory.content} ${memory.source}`, queryTerms) }))
      .filter(({ score }) => queryTerms.length === 0 || score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, Math.max(1, Math.min(input.memoryMaxItems ?? maxItems, 50)));
    const selected = memories.map(({ memory, score }) => ({
      id: memory.id, kind: memory.kind, content: memory.content, source: memory.source,
      confidence: memory.confidence, score, version: memory.version ?? 1,
      classification: memory.classification ?? (memory.scope === 'private' ? 'private' : 'internal'),
      evidenceRefs: memory.evidenceRefs ?? [],
      ...(memory.evidenceRunId ? { evidenceRunId: memory.evidenceRunId } : {}),
    }));
    const excludedReasons: string[] = [];
    if (allMemories.some(memory => memory.scope === 'private')) excludedReasons.push('private memories omitted by scope policy');
    if (allMemories.some(memory => memory.state === 'superseded')) excludedReasons.push('superseded memory versions omitted');
    if (allMemories.some(memory => memory.state === 'retracted')) excludedReasons.push('retracted memories omitted');
    if (allMemories.some(memory => memory.scope !== 'private' && !allowedClassifications.includes(memory.classification ?? 'internal'))) excludedReasons.push('memory classification exceeds the requested context policy');
    const manifest: ContextManifest = {
      id: `ctx_${randomUUID()}`,
      goalId,
      owner,
      tenantId,
      purpose: input.purpose.trim(),
      audience: audienceSnapshot.participants.map(participant => participant.audience),
      audienceSnapshot,
      memoryRefs: selected.map((memory) => memory.id),
      included: selected,
      excluded: excludedReasons,
      createdAt: now,
    };
    return manifest;
  }

  async createContextManifestWithKnowledge(goalId: Id, input: CreateContextInput, knowledge: KnowledgeProvider, now = new Date().toISOString(), owner = "owner", tenantId = "local"): Promise<ContextManifest> {
    const manifest = await this.buildContextManifest(goalId, input, now, owner, tenantId);
    const shared = manifest.audience.length > 1;
    const request = {
      query: input.query ?? '', maxItems: Math.max(1, Math.min(input.maxItems ?? 8, 50)),
      allowedClassifications: (input.knowledgeClassifications ?? ['public', 'internal'] as const).filter(level => !shared || classificationRank(level) <= classificationRank('internal')),
      audience: principalAudience({ id: owner, tenantId }), tenantId,
    };
    const result = normalizeKnowledgeSearchResult(await knowledge.search(request));
    const hits = validateKnowledgeHits(request, result.hits);
    const includedKnowledge = hits.filter(({ record }) => manifest.audience.every(audience => isAudienceAllowed(record, audience)))
      .map(({ record, score }) => ({ id: record.id, title: record.title, content: record.content.slice(0, 4000), source: record.source, classification: record.classification, contentHash: record.contentHash, score }));
    const next: ContextManifest = { ...manifest, knowledgeRefs: includedKnowledge.map(item => item.id), includedKnowledge };
    // A slow connector must not publish a context after its recipients change.
    await this.assertAudienceCurrent(next);
    await this.store.saveContextManifest(next);
    return next;
  }

  /** Read a frozen context manifest through the same ownership boundary as its Goal. */
  async getContextManifest(goalId: Id, id: Id, owner = 'owner', tenantId = 'local'): Promise<ContextManifest> {
    const goal = await this.assertReadableGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    const manifest = await this.store.getContextManifest(id);
    if (!manifest) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    const normalized = normalizeContextManifest(manifest);
    if (normalized.goalId !== goalId || (normalized.tenantId ?? 'local') !== tenantId) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    if (this.owns(normalized, owner, tenantId)) return normalized;
    // Legacy manifests did not bind recipients to membership. They remain
    // owner-readable, but cannot silently become shared history.
    if (!normalized.audienceSnapshot) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    const snapshot = this.validatedAudience(normalized);
    const participant = snapshot.participants.find(item => item.principalId === owner && item.tenantId === tenantId);
    if (!participant || snapshot.roomId !== goal.roomId || !(await this.isAudienceParticipantCurrent(snapshot, participant))) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    const included = normalized.included.filter(item => classificationRank(item.classification) <= classificationRank('internal'));
    const includedKnowledge = (normalized.includedKnowledge ?? []).filter(item => classificationRank(item.classification) <= classificationRank('internal'));
    return {
      ...normalized,
      memoryRefs: included.map(item => item.id),
      included,
      knowledgeRefs: includedKnowledge.map(item => item.id),
      includedKnowledge,
      excluded: [...normalized.excluded, 'confidential and private context omitted for shared Room reader'],
    };
  }

  /** Current membership and each source authorization remain mandatory. */
  async getSessionContextManifest(roomId: Id, id: Id, actor = 'owner', tenantId = 'local'): Promise<ContextManifest> {
    await this.getRoomForPrincipal(roomId, actor, tenantId);
    const stored = await this.store.getContextManifest(id);
    if (!stored) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    const manifest = normalizeContextManifest(stored);
    if (manifest.roomId !== roomId || manifest.tenantId !== tenantId || manifest.goalId !== undefined) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    const snapshot = this.validatedAudience(manifest);
    const participant = snapshot.participants.find(item => item.principalId === actor && item.tenantId === tenantId);
    if (!participant || snapshot.roomId !== roomId || !(await this.isAudienceParticipantCurrent(snapshot, participant))) throw new AeeisNotFound(`Unknown context manifest: ${id}`);
    await this.assertSessionSources(manifest, actor, tenantId);
    if (manifest.owner === actor) return manifest;
    const included = manifest.included.filter(item => classificationRank(item.classification) <= classificationRank('internal'));
    const includedKnowledge = (manifest.includedKnowledge ?? []).filter(item => classificationRank(item.classification) <= classificationRank('internal'));
    return { ...manifest, memoryRefs: included.map(item => item.id), included, knowledgeRefs: includedKnowledge.map(item => item.id), includedKnowledge, excluded: [...manifest.excluded, 'confidential and private context omitted for shared Room reader'] };
  }

  private async assertSessionSources(manifest: ContextManifest, actor: string, tenantId: string): Promise<void> {
    if (!manifest.goalContextRefs?.length || JSON.stringify(manifest.goalIds) !== JSON.stringify(manifest.goalContextRefs.map(ref => ref.goalId))) throw new AeeisConflict('Invalid session context sources');
    for (const ref of manifest.goalContextRefs) {
      const goal = await this.getGoal(ref.goalId, actor, tenantId);
      if (goal.roomId !== manifest.roomId) throw new AeeisNotFound('Session context Goal is no longer in the Room');
      const source = await this.getContextManifest(ref.goalId, ref.contextManifestId, actor, tenantId);
      if (!source.audience.includes(principalAudience({ id: actor, tenantId })) || goalContextSourceHash(source) !== ref.bindingHash) throw new AeeisNotFound('Session context source is unavailable or changed');
    }
  }

  private async captureContextAudience(goal: Goal, input: CreateContextInput, now: string, owner: string, tenantId: string): Promise<ContextAudienceSnapshot> {
    if (input.audienceMode !== undefined && input.audienceMode !== 'owner' && input.audienceMode !== 'room') throw new AeeisConflict('Invalid audience mode');
    if (input.audienceMode !== undefined && input.audience !== undefined) throw new AeeisConflict('Choose audienceMode or explicit audience, not both');
    if (input.audience && (input.audience.length < 1 || input.audience.length > 100 || new Set(input.audience).size !== input.audience.length)) throw new AeeisConflict('Audience must contain 1 to 100 unique recipients');
    const ownerAudience = principalAudience({ id: owner, tenantId });
    const ownerParticipant = { principalId: owner, tenantId, audience: ownerAudience, authority: 'goal-owner' as const, role: 'owner' as const };
    const shared = input.audienceMode === 'room' || input.audience?.some(item => item !== ownerAudience);
    if (!shared) return createContextAudienceSnapshot({ schemaVersion: 'context-audience/1', capturedAt: now, participants: [ownerParticipant] });
    if (!goal.roomId) throw new AeeisConflict('Shared audience requires a Room');
    const room = await this.getRoomForPrincipal(goal.roomId, owner, tenantId);
    const members = this.memberships ? await this.memberships.list(room.id, tenantId) : [];
    const participants: ContextAudienceSnapshot['participants'] = [ownerParticipant];
    const roomOwner = room.owner ?? 'owner';
    if (roomOwner !== owner) participants.push({ principalId: roomOwner, tenantId, audience: principalAudience({ id: roomOwner, tenantId }), authority: 'room-owner', role: 'owner' });
    for (const member of members) {
      if (member.status !== 'active' || member.roomId !== room.id || member.tenantId !== tenantId || member.principalId === owner || member.principalId === roomOwner) continue;
      participants.push({ principalId: member.principalId, tenantId, audience: principalAudience({ id: member.principalId, tenantId }), authority: 'room-member', role: member.role, membershipId: member.id, membershipUpdatedAt: member.updatedAt });
    }
    if (input.audience?.some(audience => !participants.some(participant => participant.audience === audience))) throw new AeeisConflict('Audience must be active members of the Goal Room');
    const selected = input.audience ? participants.filter(participant => participant.principalId === owner || input.audience!.includes(participant.audience)) : participants;
    if (selected.length > 100) throw new AeeisConflict('Room audience exceeds 100 recipients; select an explicit audience');
    return createContextAudienceSnapshot({ schemaVersion: 'context-audience/1', capturedAt: now, roomId: room.id, participants: selected });
  }

  private validatedAudience(manifest: ContextManifest): ContextAudienceSnapshot {
    const parsed = contextAudienceSnapshotSchema.safeParse(manifest.audienceSnapshot);
    if (!parsed.success) throw new AeeisConflict('Invalid context audience snapshot');
    const snapshot = parsed.data;
    if ((manifest.roomId !== undefined) !== (snapshot.scope === 'room')) throw new AeeisConflict('Context audience scope mismatch');
    const audience = snapshot.participants.map(participant => participant.audience);
    if (JSON.stringify(audience) !== JSON.stringify(manifest.audience) || !snapshot.participants.some(participant => participant.authority === (manifest.roomId ? 'room-owner' : 'goal-owner') && participant.principalId === manifest.owner && participant.tenantId === manifest.tenantId)) throw new AeeisConflict('Context audience binding mismatch');
    return snapshot;
  }

  private async isAudienceParticipantCurrent(snapshot: ContextAudienceSnapshot, participant: ContextAudienceSnapshot['participants'][number]): Promise<boolean> {
    if (participant.authority === 'goal-owner') return true;
    if (!snapshot.roomId) return false;
    const room = await this.store.getRoom(snapshot.roomId);
    if (!room || (room.tenantId ?? 'local') !== participant.tenantId) return false;
    if (participant.authority === 'room-owner') return (room.owner ?? 'owner') === participant.principalId;
    const member = await this.memberships?.get(snapshot.roomId, participant.principalId, participant.tenantId);
    return member?.status === 'active' && member.id === participant.membershipId && member.role === participant.role && member.updatedAt === participant.membershipUpdatedAt;
  }

  private async assertAudienceCurrent(manifest: ContextManifest): Promise<void> {
    const snapshot = this.validatedAudience(manifest);
    if (snapshot.roomId) await this.getRoomForPrincipal(snapshot.roomId, manifest.owner, manifest.tenantId);
    for (const participant of snapshot.participants) {
      if (!(await this.isAudienceParticipantCurrent(snapshot, participant))) throw new AeeisConflict('Context audience changed; create a new manifest');
    }
  }

  async getSnapshot(planId: Id, owner = "owner", tenantId = "local"): Promise<AeeisSnapshot> {
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new AeeisNotFound(`Unknown plan: ${planId}`);
    const goal = await this.assertReadableGoal(await this.store.getGoal(plan.goalId), plan.goalId, owner, tenantId);
    const memories = (await this.store.getMemories(plan.goalId)).map(normalizeMemory);
    const visibleMemories = this.owns(goal, owner, tenantId)
      ? memories
      : memories.filter(memory => memory.state === 'active' && memory.scope !== 'private' && classificationRank(memory.classification ?? 'internal') <= classificationRank('internal'));
    return { goal, plan, receipts: await this.store.getReceipts(planId), memories: visibleMemories };
  }

  async getSnapshotForGoal(goalId: Id, owner = "owner", tenantId = "local"): Promise<AeeisSnapshot> {
    const plan = (await this.listPlans(goalId, owner, tenantId))[0];
    if (!plan) {
      await this.getGoal(goalId, owner, tenantId);
      throw new Error(`Goal ${goalId} has no plan`);
    }
    return this.getSnapshot(plan.id, owner, tenantId);
  }

  async getGoal(goalId: Id, owner = "owner", tenantId = "local"): Promise<Goal> {
    return this.assertReadableGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
  }

  async getPlan(planId: Id, owner = "owner", tenantId = "local"): Promise<Plan> {
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new AeeisNotFound(`Unknown plan: ${planId}`);
    await this.assertReadableGoal(await this.store.getGoal(plan.goalId), plan.goalId, owner, tenantId);
    return plan;
  }

  async listGoals(owner = "owner", tenantId = "local", limit?: number): Promise<Goal[]> {
    return this.store.getGoals({ owner, tenantId }, limit);
  }

  /** Canonical Goal IDs that the principal can read through active Room membership. */
  async readableGoalIds(principalId = 'owner', tenantId = 'local'): Promise<Set<Id>> {
    const rooms = await this.listRoomsForPrincipal(principalId, tenantId);
    const roomIds = new Set(rooms.map(room => room.id));
    const goals = this.store.getReadableGoals
      ? await this.store.getReadableGoals({ owner: principalId, tenantId }, [...roomIds])
      : (await this.store.getGoals()).filter(goal =>
      (goal.tenantId ?? 'local') === tenantId && (this.owns(goal, principalId, tenantId) || Boolean(goal.roomId && roomIds.has(goal.roomId))),
      );
    return new Set(goals.map(goal => goal.id));
  }

  async hasSharedReadableGoals(principalId = 'owner', tenantId = 'local'): Promise<boolean> {
    const roomIds = this.memberships ? await this.memberships.activeRoomIds(principalId, tenantId) : [];
    const goals = this.store.getReadableGoals
      ? await this.store.getReadableGoals({ owner: principalId, tenantId }, roomIds)
      : (await this.store.getGoals()).filter(goal =>
        (goal.tenantId ?? 'local') === tenantId && (this.owns(goal, principalId, tenantId) || Boolean(goal.roomId && roomIds.includes(goal.roomId))),
      );
    return goals.some(goal => !this.owns(goal, principalId, tenantId));
  }

  async listGoalsPage(owner = 'owner', tenantId = 'local', limit = 50, cursor?: string): Promise<GoalPage> {
    validateCollectionLimit(limit);
    if (this.store.getGoalsPage) return this.store.getGoalsPage({ owner, tenantId }, limit, cursor);
    const pageCursor = cursor === undefined ? undefined : (() => { try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { timestamp: string; id: string }; } catch { throw new RangeError('Invalid collection cursor'); } })();
    const goals = (await this.store.getGoals({ owner, tenantId })).filter(goal => !pageCursor || Date.parse(goal.createdAt) < Date.parse(pageCursor.timestamp) || (Date.parse(goal.createdAt) === Date.parse(pageCursor.timestamp) && goal.id > pageCursor.id)).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const visible = goals.slice(0, limit); return { goals: visible, ...(goals.length > limit && visible.length ? { nextCursor: Buffer.from(JSON.stringify({ timestamp: visible.at(-1)!.createdAt, id: visible.at(-1)!.id }), 'utf8').toString('base64url') } : {}) };
  }

  async listPlans(goalId: Id, owner = "owner", tenantId = "local"): Promise<Plan[]> {
    await this.assertReadableGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    return (await this.store.getPlans(goalId)).sort((left, right) => right.version - left.version || right.createdAt.localeCompare(left.createdAt));
  }
  async listPlansPage(goalId: Id, owner = 'owner', tenantId = 'local', limit = 50, cursor?: string): Promise<PlanPage> {
    validateCollectionLimit(limit);
    await this.assertReadableGoal(await this.store.getGoal(goalId), goalId, owner, tenantId);
    if (this.store.getPlansPage) return this.store.getPlansPage(goalId, limit, cursor);
    const plans = (await this.listPlans(goalId, owner, tenantId)).filter(plan => {
      if (!cursor) return true;
      try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { version: number; id: string }; return plan.version < parsed.version || (plan.version === parsed.version && plan.id > parsed.id); } catch { throw new RangeError('Invalid version cursor'); }
    });
    const visible = plans.slice(0, limit);
    return { plans: visible, ...(plans.length > limit && visible.length ? { nextCursor: Buffer.from(JSON.stringify({ version: visible.at(-1)!.version, id: visible.at(-1)!.id }), 'utf8').toString('base64url') } : {}) };
  }

  /** Move durable domain intents into the transport outbox. If the process
   * stops after enqueue and before marking, the outbox idempotency key makes
   * the retry harmless. */
  async drainProjectionIntents(outbox: ProjectionIntentSink): Promise<{ dispatched: number; failed: number }> {
    let dispatched = 0; let failed = 0;
    for (const intent of await this.store.listProjectionIntents()) {
      try {
        await outbox.enqueue({ channel: intent.channel, destination: intent.destination, aggregateType: intent.aggregateType, aggregateId: intent.aggregateId, payload: intent.payload, idempotencyKey: intent.idempotencyKey, owner: intent.owner, tenantId: intent.tenantId });
        await this.store.markProjectionIntentDispatched(intent.id);
        dispatched += 1;
      } catch { failed += 1; }
    }
    return { dispatched, failed };
  }

  private buildProjectionIntents(goal: Goal, next: Plan, receipt: RunReceipt): ProjectionIntent[] {
    if (this.projectionTargets.length === 0) return [];
    const completed = next.nodes.every(node => node.status === 'succeeded');
    const nextGoal: Goal = { ...goal, status: completed ? 'completed' : goal.status };
    const task = next.nodes.find(node => node.id === receipt.taskId);
    if (!task) return [];
    const owner = goal.owner ?? 'owner'; const tenantId = goal.tenantId ?? 'local';
    const records: Array<{ type: ProjectionAggregateType; id: string; payload: unknown }> = [
      { type: 'goal', id: goal.id, payload: nextGoal },
      { type: 'plan', id: next.id, payload: { goal: nextGoal, plan: next, receipt } },
      { type: 'task', id: `${next.id}.${task.id}`, payload: { goal: nextGoal, planId: next.id, task, receipt } },
    ];
    return this.projectionTargets.flatMap((target, targetIndex) => records.filter(record => !target.aggregateTypes || target.aggregateTypes.includes(record.type)).map((record, recordIndex) => ({
      id: `intent_${receipt.id}_${targetIndex}_${recordIndex}`,
      owner, tenantId, channel: target.channel, destination: target.destination, aggregateType: record.type, aggregateId: record.id,
      idempotencyKey: `${target.channel}:${target.destination}:${record.type}:${record.id}:${receipt.id}`, payload: record.payload, status: 'pending' as const, createdAt: receipt.occurredAt,
    })));
  }

  private buildCreationProjectionIntents(goal: Goal): ProjectionIntent[] {
    return this.buildProjectionIntentsForRecords(goal, [{ type: 'goal', id: goal.id, payload: goal }], 'created');
  }

  private buildRoomProjectionIntents(room: Room, suffix = 'created'): ProjectionIntent[] {
    if (this.projectionTargets.length === 0) return [];
    return this.projectionTargets.filter(target => !target.aggregateTypes || target.aggregateTypes.includes('room')).map((target, index) => ({
      id: `intent_room_${room.id}_${index}_${suffix}`, owner: room.owner ?? 'owner', tenantId: room.tenantId ?? 'local', channel: target.channel, destination: target.destination,
      aggregateType: 'room', aggregateId: room.id, idempotencyKey: `${target.channel}:${target.destination}:room:${room.id}:${suffix}`, payload: room, status: 'pending' as const, createdAt: room.createdAt,
    }));
  }

  private buildPlanProjectionIntents(goal: Goal, plan: Plan): ProjectionIntent[] {
    return this.buildProjectionIntentsForRecords(goal, [
      { type: 'goal', id: goal.id, payload: goal },
      { type: 'plan', id: plan.id, payload: { goal, plan } },
    ], 'plan-created');
  }

  private buildProjectionIntentsForRecords(goal: Goal, records: Array<{ type: ProjectionAggregateType; id: string; payload: unknown }>, suffix: string): ProjectionIntent[] {
    if (this.projectionTargets.length === 0) return [];
    const owner = goal.owner ?? 'owner'; const tenantId = goal.tenantId ?? 'local';
    return this.projectionTargets.flatMap((target, targetIndex) => records.filter(record => !target.aggregateTypes || target.aggregateTypes.includes(record.type)).map((record, recordIndex) => ({
      id: `intent_${record.type}_${record.id}_${targetIndex}_${recordIndex}_${suffix}`,
      owner, tenantId, channel: target.channel, destination: target.destination, aggregateType: record.type, aggregateId: record.id,
      idempotencyKey: `${target.channel}:${target.destination}:${record.type}:${record.id}:${suffix}`, payload: record.payload, status: 'pending' as const, createdAt: goal.createdAt,
    })));
  }


  private owns(value: { owner?: string; tenantId?: string }, owner: string, tenantId: string): boolean { return (value.owner ?? "owner") === owner && (value.tenantId ?? "local") === tenantId; }
  private assertOwnedGoal(goal: Goal | undefined, goalId: Id, owner: string, tenantId: string): Goal {
    if (!goal || !this.owns(goal, owner, tenantId)) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
    return goal;
  }

  /**
   * Shared Rooms grant read access to their Goal and Plan graph. Keep this
   * check in the domain service so HTTP, Temporal and internal callers cannot
   * accidentally disagree about membership visibility. Mutating operations
   * continue to use assertOwnedGoal or their explicit editor checks.
   */
  private async assertReadableGoal(goal: Goal | undefined, goalId: Id, owner: string, tenantId: string): Promise<Goal> {
    const role = await this.goalRole(goal, goalId, owner, tenantId);
    if (role === undefined) throw new AeeisNotFound(`Unknown goal: ${goalId}`);
    return goal!;
  }

  private async assertEditorGoal(goal: Goal | undefined, goalId: Id, owner: string, tenantId: string): Promise<Goal> {
    const role = await this.goalRole(goal, goalId, owner, tenantId);
    if (role !== 'owner' && role !== 'editor') throw new RoomMembershipConflict('Room editor role required');
    return goal!;
  }

  private async assertParticipantGoal(goal: Goal | undefined, goalId: Id, owner: string, tenantId: string): Promise<Goal> {
    const role = await this.goalRole(goal, goalId, owner, tenantId);
    if (role !== 'owner' && role !== 'editor' && role !== 'agent') throw new RoomMembershipConflict('Active Room participant required');
    return goal!;
  }

  private async goalRole(goal: Goal | undefined, goalId: Id, principalId: string, tenantId: string): Promise<RoomMemberRole | undefined> {
    if (!goal || (goal.tenantId ?? 'local') !== tenantId) return undefined;
    if (this.owns(goal, principalId, tenantId)) return 'owner';
    if (!goal.roomId || !this.memberships) return undefined;
    const room = await this.store.getRoom(goal.roomId);
    if (!room || (room.tenantId ?? 'local') !== tenantId) return undefined;
    return this.roomRole(room, principalId, tenantId);
  }
}

function normalizeMemory(memory: MemoryEntry | undefined): MemoryEntry {
  if (!memory) throw new AeeisNotFound('Unknown memory');
  return {
    ...memory,
    owner: memory.owner ?? 'owner',
    tenantId: memory.tenantId ?? 'local',
    classification: memory.classification ?? (memory.scope === 'private' ? 'private' : 'internal'),
    version: memory.version ?? 1,
    state: memory.state ?? 'active',
    evidenceRefs: memory.evidenceRefs ?? [],
  };
}

function normalizeContextManifest(manifest: ContextManifest): ContextManifest {
  return {
    ...manifest,
    ...(manifest.goalId ? { goalId: manifest.goalId } : {}),
    ...(manifest.roomId ? { roomId: manifest.roomId } : {}),
    ...(manifest.goalIds ? { goalIds: [...manifest.goalIds] } : {}),
    owner: manifest.owner ?? 'owner',
    tenantId: manifest.tenantId ?? 'local',
    memoryRefs: manifest.memoryRefs ?? [],
    included: (manifest.included ?? []).map(memory => ({
      ...memory,
      version: memory.version ?? 1,
      classification: memory.classification ?? 'internal',
      evidenceRefs: memory.evidenceRefs ?? [],
    })),
  };
}

function classificationRank(value: 'public' | 'internal' | 'confidential' | 'private'): number {
  return { public: 0, internal: 1, confidential: 2, private: 3 }[value];
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

function isPlanVersionConflict(error: unknown): boolean {
  if (error instanceof Error && error.message === 'Plan version already exists') return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && candidate.constraint === 'aeeis_plans_goal_version_idx';
}

/** Same ID with different content cannot be silently merged across Goals. */
function mergeContextItems<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new AeeisConflict('Conflicting session context item versions');
    byId.set(item.id, item);
  }
  return [...byId.values()];
}
