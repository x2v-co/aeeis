import { describe, expect, it } from 'vitest';
import { AeeisService } from '../src/application/aeeis-service.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres domain store', () => {
  it.skipIf(!databaseUrl)('persists the Goal domain across service instances', async () => {
    const first = new PostgresAeeisStore(databaseUrl!);
    await first.init();
    const service = new AeeisService(first);
    const goal = await service.createGoal({ title: 'Postgres domain fixture' });
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
    await service.addMemory(goal.id, { kind: 'decision', content: 'Persist receipts in PostgreSQL' });
    await first.close();

    const second = new PostgresAeeisStore(databaseUrl!);
    await second.init();
    const restored = await new AeeisService(second).getSnapshot(plan.id);
    expect(restored.goal.id).toBe(goal.id);
    expect(restored.plan.nodes[0]?.status).toBe('running');
    expect(restored.receipts).toHaveLength(1);
    expect(restored.memories).toHaveLength(1);
    await second.close();
  });
});
