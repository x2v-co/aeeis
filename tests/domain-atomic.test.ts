import { describe, expect, it } from 'vitest';
import { mkdtemp, rename, mkdir, rmdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { JsonFileStore } from '../src/adapters/json-store.js';

for (const adapter of ['memory', 'json'] as const) {
  describe(`${adapter} atomic Task transitions`, () => {
    it('preserves concurrent DAG branches and rejects duplicate transitions across service instances', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'aeeis-atomic-'));
      const store = adapter === 'memory' ? new InMemoryStore() : new JsonFileStore(join(dir, 'domain.json'));
      if (store instanceof JsonFileStore) await store.init();
      try {
        const services = Array.from({ length: 12 }, () => new AeeisService(store));
        const first = services[0]!;
        const goal = await first.createGoal({ title: 'Concurrent branches' });
        const nodes = services.map((_, index) => ({ id: `task${index}`, title: `Task ${index}` }));
        const plan = await first.createPlan({ goalId: goal.id, nodes: [...nodes, { id: 'join', title: 'Join', dependsOn: nodes.map(n => n.id) }] });
        await Promise.all(services.map((service, index) => service.transitionTask({ planId: plan.id, taskId: nodes[index]!.id, transition: 'start' })));
        await Promise.all(services.map((service, index) => service.transitionTask({ planId: plan.id, taskId: nodes[index]!.id, transition: 'succeed' })));
        const snapshot = await first.getSnapshot(plan.id);
        expect(snapshot.plan.nodes.slice(0, 12).every(n => n.status === 'succeeded')).toBe(true);
        expect(snapshot.plan.nodes.at(-1)?.status).toBe('ready');
        expect(snapshot.receipts).toHaveLength(24);
        expect(snapshot.goal.status).toBe('active');
        const duplicates = await Promise.allSettled(services.map(service => service.transitionTask({ planId: plan.id, taskId: 'join', transition: 'start' })));
        expect(duplicates.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        await first.transitionTask({ planId: plan.id, taskId: 'join', transition: 'succeed' });
        expect((await first.getSnapshot(plan.id)).receipts).toHaveLength(26);
        expect((await first.getGoal(goal.id)).status).toBe('completed');
      } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
    });
  });
}

it('keeps Plan, Goal and Receipt unchanged when the JSON replacement fails, and commits all three on retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeeis-atomic-failure-'));
  const path = join(dir, 'domain.json');
  const store = new JsonFileStore(path); await store.init();
  const service = new AeeisService(store);
  try {
    const goal = await service.createGoal({ title: 'Atomic completion' });
    const plan = await service.createPlan({ goalId: goal.id, nodes: [{ id: 'draft', title: 'Draft' }] });
    await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'start' });
    const before = await service.getSnapshot(plan.id);
    await rename(path, path + '.backup'); await mkdir(path);
    await expect(service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'succeed' })).rejects.toThrow();
    expect(await service.getSnapshot(plan.id)).toEqual(before);
    await rmdir(path); await rename(path + '.backup', path);
    await service.transitionTask({ planId: plan.id, taskId: 'draft', transition: 'succeed' });
    await store.close();
    const reopened = new JsonFileStore(path); await reopened.init();
    try {
      const restored = await new AeeisService(reopened).getSnapshot(plan.id);
      expect(restored.plan.nodes[0]?.status).toBe('succeeded');
      expect(restored.goal.status).toBe('completed');
      expect(restored.receipts.map(r => r.to)).toEqual(['running', 'succeeded']);
    } finally { await reopened.close(); }
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

it('rejects a second JSON writer without releasing the first writer lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aeeis-domain-lock-'));
  const path = join(dir, 'domain.json');
  const first = new JsonFileStore(path), second = new JsonFileStore(path);
  try {
    await first.init();
    await expect(second.init()).rejects.toThrow('live writer');
    await second.close();
    await expect(second.init()).rejects.toThrow('live writer');
    await first.close();
    await second.init();
  } finally { await first.close(); await second.close(); await rm(dir, { recursive: true, force: true }); }
});
