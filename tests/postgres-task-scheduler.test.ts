import { describe, expect, it, vi } from 'vitest';
import { PostgresTaskDispatchRepository, TaskScheduler } from '../src/task-scheduler.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres task dispatch ledger', () => {
  it.skipIf(!databaseUrl)('recovers the create/notify crash window after closing every original connection', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const makeStores = () => ({ domain: new PostgresAeeisStore(db.url), runs: new PostgresRunRepository(db.url), dispatches: new PostgresTaskDispatchRepository(db.url) });
    const first = makeStores(); const second = makeStores();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const model = { pin: { model: 'fixture', endpoint: 'http://fixture', promptVersion: 'test' }, complete: vi.fn(async () => { throw new Error('Recovery must not invoke a model before approval'); }) };
    try {
      await Promise.all(Object.values(first).map(store => store.init()));
      const domain = new AeeisService(first.domain);
      const goal = await domain.createGoal({ title: 'Durable dispatch' }, undefined, scope.owner, scope.tenantId);
      const plan = await domain.createPlan({ goalId: goal.id, nodes: [{ id: 'prepare', title: 'Prepare' }] }, undefined, scope.owner, scope.tenantId);
      const engine = new AgentEngine(first.runs, { domain, model });
      const run = await engine.create({ goal: 'Custom configured task', goalId: goal.id, taskExecution: { domainPlanId: plan.id, taskId: 'prepare' }, maxModelCalls: 7 }, scope.owner, scope.tenantId);
      await first.dispatches.reserve({ ...scope, goalId: goal.id, planId: plan.id, taskId: 'prepare', taskAttempt: 0, runId: run.id, workflowId: run.id, runner: 'TemporalDispatcher' });
      await Promise.all(Object.values(first).map(store => store.close()));
      await Promise.all(Object.values(second).map(store => store.init()));
      const recoveredDomain = new AeeisService(second.domain);
      const recoveredEngine = new AgentEngine(second.runs, { domain: recoveredDomain, model });
      const dispatcher = { notify: vi.fn(async (id: string) => { await recoveredEngine.advance(id); }), async close() {} };
      const scheduler = new TaskScheduler(recoveredDomain, recoveredEngine, dispatcher, second.dispatches);
      await scheduler.reconcilePlan(plan.id, scope);
      await scheduler.reconcilePlan(plan.id, scope);
      expect(dispatcher.notify).toHaveBeenCalledTimes(1);
      expect(dispatcher.notify).toHaveBeenCalledWith(run.id);
      expect((await second.runs.get(run.id, scope))).toMatchObject({ status: 'needs_approval', maxModelCalls: 7 });
      expect((await second.dispatches.list(scope))[0]).toMatchObject({ state: 'dispatched', runId: run.id });
      expect(model.complete).not.toHaveBeenCalled();
      expect(await second.dispatches.list({ owner: 'bob', tenantId: 'team-a' })).toEqual([]);
    } finally {
      await Promise.allSettled([...Object.values(first), ...Object.values(second)].map(store => store.close()));
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('deduplicates reservations and preserves scope across instances', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresTaskDispatchRepository(db.url);
    const second = new PostgresTaskDispatchRepository(db.url);
    await first.init(); await second.init();
    const input = { owner: 'alice', tenantId: 'team-a', goalId: 'goal-1', planId: 'plan-1', taskId: 'task-1', taskAttempt: 0, runId: 'run_00000000-0000-4000-8000-000000000000', workflowId: 'run_00000000-0000-4000-8000-000000000000', runner: 'TemporalDispatcher' };
    try {
      expect((await first.reserve(input)).created).toBe(true);
      expect((await second.reserve(input)).created).toBe(false);
      await second.mutate((await second.getForTask('plan-1', 'task-1', { owner: 'alice', tenantId: 'team-a' }))!.id, record => { record.state = 'dispatched'; record.dispatchAttempts = 1; }, { owner: 'alice', tenantId: 'team-a' });
      expect((await first.list({ owner: 'alice', tenantId: 'team-a' }))[0]).toMatchObject({ state: 'dispatched', dispatchAttempts: 1 });
      expect(await first.list({ owner: 'bob', tenantId: 'team-a' })).toEqual([]);
    } finally { await first.close(); await second.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('allows only one concurrent recovery sweep per owner and tenant', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresTaskDispatchRepository(db.url);
    const second = new PostgresTaskDispatchRepository(db.url);
    await first.init(); await second.init();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    let release!: () => void;
    let running = false;
    const firstLease = first.withRecoveryLease!(scope, async () => {
      running = true;
      await new Promise<void>(resolve => { release = resolve; });
      return 'first';
    });
    while (!running) await new Promise(resolve => setImmediate(resolve));
    expect(await second.withRecoveryLease!(scope, async () => 'second')).toBeUndefined();
    release();
    await expect(firstLease).resolves.toBe('first');
    try {
      expect(await second.withRecoveryLease!(scope, async () => 'after-release')).toBe('after-release');
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
