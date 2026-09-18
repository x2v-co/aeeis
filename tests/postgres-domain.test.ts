import { describe, expect, it } from 'vitest';
import { AeeisService } from '../src/application/aeeis-service.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { refreshReadyTasks, transitionTask } from '../src/domain/plan.js';

import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres domain store', () => {
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
});
