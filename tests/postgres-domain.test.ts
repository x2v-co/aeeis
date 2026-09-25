import { describe, expect, it } from 'vitest';
import { AeeisService } from '../src/application/aeeis-service.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { refreshReadyTasks, transitionTask } from '../src/domain/plan.js';

import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres domain store', () => {
  it.skipIf(!databaseUrl)('persists owner-scoped Rooms and Room-linked Goals', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresAeeisStore(db.url); await store.init();
    try {
      const service = new AeeisService(store);
      const room = await service.createRoom({ title: 'Postgres room' }, undefined, 'alice', 'team-a');
      const goal = await service.createGoal({ title: 'Room goal', roomId: room.id }, undefined, 'alice', 'team-a');
      const archived = await service.updateRoom(room.id, { status: 'archived', title: 'Archived Postgres room' }, undefined, 'alice', 'team-a');
      expect(archived).toMatchObject({ status: 'archived', title: 'Archived Postgres room' });
      await expect(service.createGoal({ title: 'Blocked goal', roomId: room.id }, undefined, 'alice', 'team-a')).rejects.toThrow('Archived room');
      expect((await service.getRoom(room.id, 'alice', 'team-a')).id).toBe(room.id);
      expect((await service.listGoalsInRoom(room.id, 'alice', 'team-a')).map(item => item.id)).toEqual([goal.id]);
      await expect(service.getRoom(room.id, 'bob', 'team-b')).rejects.toThrow('Unknown room');
    } finally { await store.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('commits concurrent transitions across connections and rolls back a receipt insert failure', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url), second = new PostgresAeeisStore(db.url);
    await first.init(); await second.init();
    try {
      const service = new AeeisService(first), other = new AeeisService(second);
      const goal = await service.createGoal({ title: 'Atomic PostgreSQL transitions' });
      const nodes = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
      const plan = await service.createPlan({ goalId: goal.id, nodes });
      await Promise.all([
        service.transitionTask({ planId: plan.id, taskId: 'a', transition: 'start' }),
        other.transitionTask({ planId: plan.id, taskId: 'b', transition: 'start' }),
      ]);
      await service.transitionTask({ planId: plan.id, taskId: 'a', transition: 'succeed' });
      const before = await service.getSnapshot(plan.id);
      expect(before.receipts).toHaveLength(3);
      expect(before.plan.nodes.map(node => node.status)).toEqual(['succeeded', 'running']);
      const next = refreshReadyTasks(transitionTask(before.plan, 'b', 'succeed').plan);
      // Duplicate receipt primary key fails *after* the Plan UPDATE. The
      // transaction must roll back every write, including goal completion.
      await expect(first.commitTaskTransition(before.plan, next, { ...before.receipts[0]!, taskId: 'b', transition: 'succeed', from: 'running', to: 'succeeded' })).rejects.toThrow();
      expect(await other.getSnapshot(plan.id)).toEqual(before);
      await other.transitionTask({ planId: plan.id, taskId: 'b', transition: 'succeed' });
      const completed = await service.getSnapshot(plan.id);
      expect(completed.goal.status).toBe('completed');
      expect(completed.receipts).toHaveLength(4);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
  it.skipIf(!databaseUrl)('persists the Goal domain across service instances', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url);
    await first.init();
    const service = new AeeisService(first);
    const goal = await service.createGoal({ title: 'Postgres domain fixture' });
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
    await service.addMemory(goal.id, { kind: 'decision', content: 'Persist receipts in PostgreSQL' });
    await first.close();

    const second = new PostgresAeeisStore(db.url);
    await second.init();
    const restored = await new AeeisService(second).getSnapshot(plan.id);
    expect(restored.goal.id).toBe(goal.id);
    expect(restored.plan.nodes[0]?.status).toBe('running');
    expect(restored.receipts).toHaveLength(1);
    expect(restored.memories).toHaveLength(1);
    await second.close(); await db.close();
  });

  it.skipIf(!databaseUrl)('commits versioned memory corrections and retractions across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url); await first.init();
    try {
      const service = new AeeisService(first);
      const goal = await service.createGoal({ title: 'Postgres memory lifecycle' }, undefined, 'alice', 'team-a');
      const original = await service.addMemory(goal.id, { kind: 'decision', content: 'Use a queue', evidenceRefs: ['receipt.1'] }, undefined, 'alice', 'team-a');
      const corrected = await service.correctMemory(goal.id, original.id, { kind: 'decision', content: 'Use Temporal', evidenceRefs: ['receipt.2'] }, undefined, 'alice', 'team-a');
      await service.retractMemory(goal.id, corrected.id, 'Architecture review superseded this decision', undefined, 'alice', 'team-a');
      expect((await service.listMemories(goal.id, 'alice', 'team-a')).map(memory => memory.state)).toEqual(['superseded', 'retracted']);
    } finally { await first.close(); }
    const second = new PostgresAeeisStore(db.url); await second.init();
    try {
      const restored = await new AeeisService(second).listMemories((await second.getGoals())[0]!.id, 'alice', 'team-a');
      expect(restored.map(memory => memory.version)).toEqual([1, 2]);
      expect(restored[0]?.evidenceRefs).toEqual(['receipt.1']);
      expect(restored[1]?.retractionReason).toContain('Architecture review');
    } finally { await second.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('persists scoped Context Manifests with structured Goal indexes across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url); await first.init();
    let goalId: string; let manifestId: string;
    try {
      const service = new AeeisService(first);
      const goal = await service.createGoal({ title: 'Scoped manifest' }, undefined, 'alice', 'team-a');
      goalId = goal.id;
      const memory = await service.addMemory(goal.id, { kind: 'decision', content: 'Use the durable manifest' }, undefined, 'alice', 'team-a');
      const manifest = await service.createContextManifest(goal.id, { purpose: 'agent handoff', query: 'durable' }, undefined, 'alice', 'team-a');
      manifestId = manifest.id;
      expect(manifest).toMatchObject({ goalId: goal.id, owner: 'alice', tenantId: 'team-a', memoryRefs: [memory.id] });
    } finally { await first.close(); }
    const second = new PostgresAeeisStore(db.url); await second.init();
    try {
      const service = new AeeisService(second);
      await expect(service.getContextManifest(goalId!, manifestId!, 'bob', 'team-b')).rejects.toThrow('Unknown goal');
      await expect(service.getContextManifest(goalId!, manifestId!, 'alice', 'team-a')).resolves.toMatchObject({ id: manifestId, goalId: goalId, owner: 'alice', tenantId: 'team-a' });
    } finally { await second.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('commits Goal/Plan creation with projection intents and restores them after restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url);
    await first.init();
    try {
      const service = new AeeisService(first, [{ channel: 'hermes', destination: 'room.domain' }]);
      const goal = await service.createGoal({ title: 'Project creation transaction' });
      const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });

      expect((await first.listProjectionIntents()).map(intent => `${intent.aggregateType}:${intent.aggregateId}`).sort()).toEqual([
        `goal:${goal.id}`,
        `goal:${goal.id}`,
        `plan:${plan.id}`,
      ].sort());
      expect((await first.getGoal(goal.id))?.id).toBe(goal.id);
      expect((await first.getPlan(plan.id))?.id).toBe(plan.id);
    } finally {
      await first.close();
    }

    const second = new PostgresAeeisStore(db.url);
    await second.init();
    try {
      expect((await second.getGoals()).length).toBe(1);
      expect((await second.getPlans()).length).toBe(1);
      expect(await second.listProjectionIntents()).toHaveLength(3);
    } finally {
      await second.close();
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('rolls back a failed Plan creation together with its projection intents', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresAeeisStore(db.url);
    await store.init();
    try {
      const missingPlan = {
        id: 'plan_missing_goal', goalId: 'goal_missing', version: 1,
        nodes: [{ id: 'draft', title: 'Draft', status: 'ready' as const }],
        createdAt: '2026-09-18T00:00:00.000Z',
      };
      const intent = {
        id: 'intent_plan_rollback', owner: 'owner', tenantId: 'local', channel: 'hermes', destination: 'room.domain',
        aggregateType: 'plan' as const, aggregateId: missingPlan.id, idempotencyKey: 'hermes:plan:plan_missing_goal',
        payload: missingPlan, status: 'pending' as const, createdAt: missingPlan.createdAt,
      };
      await expect(store.commitPlanCreation(missingPlan, [intent])).rejects.toThrow('missing goal');
      expect(await store.getPlan(missingPlan.id)).toBeUndefined();
      expect(await store.listProjectionIntents()).toEqual([]);
    } finally {
      await store.close();
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('serializes concurrent Plan revisions into unique versions', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url);
    const second = new PostgresAeeisStore(db.url);
    await first.init(); await second.init();
    try {
      const service = new AeeisService(first);
      const other = new AeeisService(second);
      const goal = await service.createGoal({ title: 'Concurrent replanning' });
      await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
      const revisions = await Promise.all([
        service.createPlanRevision({ goalId: goal.id, nodes: [{ id: 'review_a', title: 'Review A' }] }),
        other.createPlanRevision({ goalId: goal.id, nodes: [{ id: 'review_b', title: 'Review B' }] }),
      ]);
      expect(revisions.map(plan => plan.version).sort()).toEqual([2, 3]);
      expect((await service.listPlans(goal.id)).map(plan => plan.version)).toEqual([3, 2, 1]);
    } finally {
      await first.close(); await second.close(); await db.close();
    }
  });
});
