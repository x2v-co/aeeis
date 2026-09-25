import { describe, expect, it } from "vitest";
import { AeeisService } from "../src/application/aeeis-service.js";
import { InMemoryStore } from "../src/adapters/in-memory-store.js";
import { FileProjectionOutbox } from "../src/collaboration-projection.js";
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';

describe("AeeisService", () => {
  it('creates first-class rooms and binds goals to the same owner/tenant', async () => {
    const service = new AeeisService(new InMemoryStore());
    const room = await service.createRoom({ title: 'Release room', description: 'Shared project context' }, '2026-09-19T00:00:00.000Z', 'alice', 'team-a');
    const goal = await service.createGoal({ title: 'Ship release', roomId: room.id }, '2026-09-19T00:00:01.000Z', 'alice', 'team-a');
    expect(goal.roomId).toBe(room.id);
    expect(await service.listGoalsInRoom(room.id, 'alice', 'team-a')).toEqual([expect.objectContaining({ id: goal.id, roomId: room.id })]);
    await expect(service.createGoal({ title: 'Cross tenant', roomId: room.id }, undefined, 'bob', 'team-b')).rejects.toThrow('Unknown room');
  });

  it('updates and archives rooms atomically, projecting the new lifecycle state', async () => {
    const store = new InMemoryStore();
    const service = new AeeisService(store, [{ channel: 'hermes', destination: 'room.1', aggregateTypes: ['room'] }]);
    const room = await service.createRoom({ title: 'Release room' }, '2026-09-19T00:00:00.000Z', 'alice', 'team-a');
    const archived = await service.updateRoom(room.id, { title: 'Archived release room', status: 'archived' }, '2026-09-19T00:00:01.000Z', 'alice', 'team-a');
    expect(archived).toMatchObject({ title: 'Archived release room', status: 'archived' });
    await expect(service.createGoal({ title: 'Too late', roomId: room.id }, undefined, 'alice', 'team-a')).rejects.toThrow('Archived room');
    const intents = await store.listProjectionIntents();
    expect(intents.map(intent => intent.idempotencyKey)).toEqual([
      `hermes:room.1:room:${room.id}:created`,
      `hermes:room.1:room:${room.id}:updated`,
    ]);
  });

  it('uses active Room membership for shared reads and editor Goal creation', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const service = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await service.createRoom({ title: 'Shared room' }, undefined, 'alice', 'team-a');
    await service.addRoomMember(room.id, 'bob', 'editor', 'alice', 'team-a');
    expect((await service.listRoomsForPrincipal('bob', 'team-a')).map(item => item.id)).toEqual([room.id]);
    const goal = await service.createGoal({ title: 'Bob goal', roomId: room.id }, undefined, 'bob', 'team-a');
    expect((await service.listGoalsInRoomForPrincipal(room.id, 'bob', 'team-a')).map(item => item.id)).toEqual([goal.id]);
    expect(await service.listRoomsForProjection()).toEqual([{ room: expect.objectContaining({ id: room.id }), members: [expect.objectContaining({ principalId: 'bob', role: 'editor', status: 'active' })] }]);
    await service.revokeRoomMember(room.id, 'bob', 'alice', 'team-a');
    expect(await service.listRoomsForPrincipal('bob', 'team-a')).toEqual([]);
    expect((await service.listRoomsForProjection())[0]?.members[0]).toMatchObject({ principalId: 'bob', status: 'revoked' });
  });

  it('applies active Room membership to Goal and Plan graph reads', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const service = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await service.createRoom({ title: 'Shared graph' }, undefined, 'alice', 'team-a');
    const goal = await service.createGoal({ title: 'Shared goal', roomId: room.id }, undefined, 'alice', 'team-a');
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'step', title: 'Step' }] }, undefined, 'alice', 'team-a');
    await service.addMemory(goal.id, { kind: 'note', content: 'shared', scope: 'project' }, undefined, 'alice', 'team-a');
    await service.addMemory(goal.id, { kind: 'note', content: 'confidential', scope: 'project', classification: 'confidential' }, undefined, 'alice', 'team-a');
    await service.addMemory(goal.id, { kind: 'note', content: 'private', scope: 'private' }, undefined, 'alice', 'team-a');
    const confidentialManifest = await service.createContextManifest(goal.id, { purpose: 'owner context', memoryClassifications: ['confidential'] }, undefined, 'alice', 'team-a');
    await expect(service.getGoal(goal.id, 'bob', 'team-a')).rejects.toThrow('Unknown goal');
    await service.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    expect(await service.getGoal(goal.id, 'bob', 'team-a')).toMatchObject({ id: goal.id });
    expect(await service.getPlan(plan.id, 'bob', 'team-a')).toMatchObject({ id: plan.id });
    expect((await service.listMemories(goal.id, 'bob', 'team-a')).map(memory => memory.content)).toEqual(['shared']);
    // Bob joined after the manifest was frozen and cannot inherit its audience.
    await expect(service.getContextManifest(goal.id, confidentialManifest.id, 'bob', 'team-a')).rejects.toThrow('Unknown context manifest');
    const sharedManifest = await service.createContextManifest(goal.id, { purpose: 'shared context', audienceMode: 'room' }, undefined, 'alice', 'team-a');
    expect((await service.getContextManifest(goal.id, sharedManifest.id, 'bob', 'team-a')).included.map(memory => memory.content)).toEqual(['shared']);
    await expect(service.createPlan({ goalId: goal.id, nodes: [{ id: 'viewer', title: 'Viewer cannot plan' }] }, undefined, 'bob', 'team-a')).rejects.toThrow('Room editor role required');
    await service.addRoomMember(room.id, 'erin', 'editor', 'alice', 'team-a');
    const editorPlan = await service.createPlanRevision({ goalId: goal.id, nodes: [{ id: 'editor', title: 'Editor plan' }] }, undefined, 'erin', 'team-a');
    await service.addRoomMember(room.id, 'carol', 'agent', 'alice', 'team-a');
    expect(await service.transitionTask({ planId: editorPlan.id, taskId: 'editor', transition: 'start' }, undefined, 'carol', 'team-a')).toMatchObject({ to: 'running' });
    await service.revokeRoomMember(room.id, 'bob', 'alice', 'team-a');
    await expect(service.getPlan(plan.id, 'bob', 'team-a')).rejects.toThrow('Unknown goal');
  });

  it('reconciles Room projections through a stable bounded cursor', async () => {
    const service = new AeeisService(new InMemoryStore());
    const rooms = await Promise.all([
      service.createRoom({ title: 'Old' }, '2026-09-18T00:00:00.000Z'),
      service.createRoom({ title: 'Newest A' }, '2026-09-20T00:00:00.000Z'),
      service.createRoom({ title: 'Newest B' }, '2026-09-20T00:00:00.000Z'),
    ]);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.pageRoomsForProjection(2, cursor);
      seen.push(...page.items.map(item => item.room.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...rooms].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)).map(room => room.id));
    await expect(service.pageRoomsForProjection(2, 'invalid-cursor')).rejects.toThrow('cursor');
  });

  it("creates a goal, plan, transition, and durable receipt", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Ship the design" }, "2026-09-18T00:00:00.000Z");
    const plan = await service.createPlan(
      {
        goalId: goal.id,
        nodes: [{ id: "draft", title: "Draft" }],
      },
      "2026-09-18T00:00:01.000Z",
    );

    const receipt = await service.transitionTask(
      { planId: plan.id, taskId: "draft", transition: "start" },
      "2026-09-18T00:00:02.000Z",
    );
    const snapshot = await service.getSnapshot(plan.id);

    expect(receipt.to).toBe("running");
    expect(snapshot.plan.nodes[0]?.status).toBe("running");
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.receipts[0]?.id).toMatch(/^receipt_/);
  });

  it("creates a Project Pulse plan and completes its goal after all tasks succeed", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Ship MVP" });
    const plan = await service.createProjectPulsePlan(goal.id);
    for (const task of ["understand", "next_action", "review"]) {
      await service.transitionTask({ planId: plan.id, taskId: task, transition: "start" });
      await service.transitionTask({ planId: plan.id, taskId: task, transition: "succeed" });
    }
    expect((await service.getGoal(goal.id)).status).toBe("completed");
  });

  it("creates immutable plan revisions with increasing versions", async () => {
    const service = new AeeisService(new InMemoryStore());
    const goal = await service.createGoal({ title: "Iterate safely" });
    const first = await service.createPlan({ goalId: goal.id, nodes: [{ id: "draft", title: "Draft" }] });
    const second = await service.createPlanRevision({ goalId: goal.id, nodes: [{ id: "review", title: "Review" }] });

    expect(second.id).not.toBe(first.id);
    expect(second.version).toBe(2);
    expect((await service.listPlans(goal.id)).map(plan => plan.version)).toEqual([2, 1]);
    expect((await service.getSnapshot(first.id)).plan.version).toBe(1);
  });

  it('writes task projection intents with the domain commit and drains them idempotently', async () => {
    const store = new InMemoryStore();
    const service = new AeeisService(store, [{ channel: 'hermes', destination: 'room.1' }]);
    const goal = await service.createGoal({ title: 'Project state' });
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    const receipt = await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
    expect(receipt.to).toBe('running');
    expect(await store.listProjectionIntents()).toHaveLength(6);

    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-domain-outbox-'))); await outbox.init();
    expect(await service.drainProjectionIntents(outbox)).toEqual({ dispatched: 6, failed: 0 });
    expect(await service.drainProjectionIntents(outbox)).toEqual({ dispatched: 0, failed: 0 });
    expect((await outbox.list()).map(event => event.aggregateType).sort()).toEqual(['goal', 'goal', 'goal', 'plan', 'plan', 'task']);
    await outbox.close();
  });

  it('keeps projection idempotency separate for two destinations on one channel', async () => {
    const store = new InMemoryStore();
    const service = new AeeisService(store, [
      { channel: 'hermes', destination: 'room.one' },
      { channel: 'hermes', destination: 'room.two' },
    ]);
    const goal = await service.createGoal({ title: 'Project to two rooms' });
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
    const intents = await store.listProjectionIntents();
    expect(intents).toHaveLength(12);
    expect(new Set(intents.map(intent => intent.idempotencyKey)).size).toBe(12);
    expect(new Set(intents.map(intent => intent.destination))).toEqual(new Set(['room.one', 'room.two']));
  });
});
