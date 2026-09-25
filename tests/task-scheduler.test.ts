import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine, taskRunIdFor } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import type { Dispatcher } from '../src/runtime/dispatcher.js';
import { FileTaskDispatchRepository, InMemoryTaskDispatchRepository, TaskScheduler } from '../src/task-scheduler.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(fileDispatches = false) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-task-scheduler-'));
  const runs = new FileRunRepository(directory); await runs.init();
  const store = new InMemoryStore(); const memberships = new InMemoryRoomMembershipRepository(); const domain = new AeeisService(store, [], memberships);
  const room = await domain.createRoom({ title: 'Release room' }, undefined, 'alice', 'team-a');
  const goal = await domain.createGoal({ title: 'Release', roomId: room.id }, undefined, 'alice', 'team-a');
  const model: ModelAdapter = {
    pin: { model: 'fixture', endpoint: 'http://fixture', promptVersion: 'test' },
    complete: async request => request.system.includes('Independently review')
      ? { value: { verdict: 'accepted', summary: 'ok', issues: [] } }
      : { value: { type: 'finish', title: 'Done', content: 'Completed', evidenceRefs: [] } },
  };
  const engine = new AgentEngine(runs, { model, domain });
  const dispatcher: Dispatcher = {
    async notify(id) {
      for (let i = 0; i < 30; i += 1) {
        const status = await engine.advance(id);
        if (!['queued', 'planning', 'running', 'reviewing'].includes(status)) return;
      }
      throw new Error('fake dispatcher exceeded ticks');
    },
    async close() {},
  };
  const plan = await domain.createPlan({ goalId: goal.id, nodes: [
    { id: 'prepare', title: 'Prepare release notes' },
    { id: 'verify', title: 'Verify release notes', dependsOn: ['prepare'] },
  ] }, undefined, 'alice', 'team-a');
  const dispatches = fileDispatches ? new FileTaskDispatchRepository(join(directory, 'dispatch.json')) : new InMemoryTaskDispatchRepository();
  const scheduler = new TaskScheduler(domain, engine, dispatcher, dispatches); await scheduler.init();
  cleanup.push(async () => { await dispatches.close(); await runs.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, runs, domain, goal, room, plan, engine, scheduler, dispatches, dispatcher };
}

async function approve(engine: AgentEngine, runs: FileRunRepository, id: string) {
  const run = await runs.get(id);
  await engine.command(id, 'approve', { planHash: run.plans.at(-1)!.hash });
}

describe('durable domain task scheduler', () => {
  it('lets an active Room member view the owner-owned dispatch ledger', async () => {
    const { room, plan, scheduler, domain } = await setup();
    await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
    await scheduler.schedulePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    expect(await scheduler.listVisibleForPlan(plan.id, { owner: 'bob', tenantId: 'team-a' })).toEqual([
      expect.objectContaining({ planId: plan.id, owner: 'alice', tenantId: 'team-a', taskId: 'prepare' }),
    ]);
  });

  it('reserves ready tasks idempotently and dispatches dependents after success', async () => {
    const { runs, plan, engine, scheduler, dispatches, domain, dispatcher } = await setup();
    const first = await scheduler.schedulePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ planId: plan.id, taskId: 'prepare', state: 'dispatched', dispatchAttempts: 1 });
    const again = await scheduler.schedulePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    expect(again).toHaveLength(1);
    expect(await dispatches.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
    expect((await dispatches.get(first[0]!.id, { owner: 'alice', tenantId: 'team-a' })).dispatchAttempts).toBe(1);
    const runId = first[0]!.runId;
    await approve(engine, runs, runId);
    await dispatcher.notify(runId);
    await scheduler.reconcilePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    const records = await dispatches.list({ owner: 'alice', tenantId: 'team-a' });
    expect(records).toHaveLength(2);
    expect(records.find(record => record.taskId === 'prepare')?.state).toBe('succeeded');
    expect(records.find(record => record.taskId === 'verify')).toMatchObject({ state: 'dispatched', dispatchAttempts: 1 });
    expect((await domain.getPlan(plan.id, 'alice', 'team-a')).nodes.map(node => node.status)).toEqual(['succeeded', 'ready']);
  });

  it('keeps unknown Run outcomes unknown across reconciliation and restart', async () => {
    const { plan, scheduler, dispatches, runs, engine, domain, dispatcher } = await setup();
    const [record] = await scheduler.schedulePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    await runs.mutate(record!.runId, current => { current.status = 'unknown'; current.error = 'provider outcome unknown'; });
    const reconciled = await scheduler.reconcilePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    expect(reconciled[0]).toMatchObject({ state: 'unknown', lastRunStatus: 'unknown' });
    const restarted = new TaskScheduler(domain, engine, dispatcher, dispatches);
    await restarted.reconcilePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    expect((await dispatches.get(record!.id, { owner: 'alice', tenantId: 'team-a' })).state).toBe('unknown');
  });

  it('replays a queued reservation left behind before Run creation', async () => {
    const { plan, scheduler, dispatches, dispatcher } = await setup();
    const runId = taskRunIdFor('alice', 'team-a', { domainPlanId: plan.id, taskId: 'prepare' });
    await dispatches.reserve({ owner: 'alice', tenantId: 'team-a', goalId: plan.goalId, planId: plan.id, taskId: 'prepare', taskAttempt: 0, runId, workflowId: runId, runner: dispatcher.constructor.name });
    const records = await scheduler.reconcilePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    expect(records[0]).toMatchObject({ taskId: 'prepare', dispatchAttempts: 1, state: 'dispatched' });
  });

  it.each([false, true])('serializes local lease claims (file=%s)', async file => {
    const { plan, dispatches } = await setup(file);
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const runId = taskRunIdFor(scope.owner, scope.tenantId, { domainPlanId: plan.id, taskId: 'prepare' });
    const { record } = await dispatches.reserve({ ...scope, goalId: plan.goalId, planId: plan.id, taskId: 'prepare', taskAttempt: 0, runId, workflowId: runId, runner: 'test' });
    const winners: string[] = [];
    await Promise.all(['a', 'b'].map(token => dispatches.mutate(record.id, current => {
      if (current.createLease) return;
      current.createLease = { token, expiresAt: new Date(Date.now() + 30_000).toISOString() };
      winners.push(token);
    }, scope)));
    expect(winners).toHaveLength(1);
    expect((await dispatches.get(record.id, scope)).createLease?.token).toBe(winners[0]);
  });

  it.each([false, true])('does not recreate a Run while another scheduler holds the creation lease (file=%s)', async file => {
    const { plan, domain, engine, runs, dispatches, scheduler, dispatcher } = await setup(file);
    const scope = { owner: 'alice', tenantId: 'team-a' };
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    // Capture before spyOn; binding the spy would recursively invoke the mock.
    const original = engine.create.bind(engine);
    const create = vi.spyOn(engine, 'create').mockImplementationOnce(async (...args) => {
      entered(); await held; return original(...args);
    });
    const first = scheduler.schedulePlan(plan.id, scope, { runOptions: { maxModelCalls: 7, materials: [{ title: 'Pinned', source: 'test', content: 'Original input' }] } });
    try {
      await started;
      const other = new TaskScheduler(domain, engine, dispatcher, dispatches);
      expect((await other.schedulePlan(plan.id, scope))[0]?.state).toBe('queued');
      await other.reconcilePlan(plan.id, scope);
      expect(create).toHaveBeenCalledTimes(1);
    } finally { release(); await first; }
    expect(await runs.list(scope)).toHaveLength(1);
    expect((await runs.list(scope))[0]).toMatchObject({ maxModelCalls: 7, status: 'needs_approval' });
    expect((await dispatches.list(scope))[0]).toMatchObject({ state: 'dispatched', dispatchAttempts: 1 });
    expect((await dispatches.list(scope))[0]?.createLease).toBeUndefined();
  });

  it('preserves creation inputs after the file ledger is closed and reopened before a Run exists', async () => {
    const { directory, plan, domain, engine, dispatches, scheduler, dispatcher, runs } = await setup(true);
    const scope = { owner: 'alice', tenantId: 'team-a' };
    vi.spyOn(engine, 'create').mockRejectedValueOnce(new Error('creation interrupted'));
    await expect(scheduler.schedulePlan(plan.id, scope, { runOptions: {
      maxModelCalls: 7, privacy: 'private', modelBudget: { tokens: 1234 }, materials: [{ title: 'Pinned', source: 'test', content: 'Keep me' }],
    } })).rejects.toThrow('creation interrupted');
    const [record] = await dispatches.list(scope);
    await dispatches.mutate(record!.id, item => { item.createLease = { token: 'crashed', expiresAt: '2000-01-01T00:00:00.000Z' }; });
    await dispatches.close();
    const reopened = new FileTaskDispatchRepository(join(directory, 'dispatch.json')); await reopened.init();
    try {
      const recovered = new TaskScheduler(domain, engine, dispatcher, reopened);
      await recovered.reconcilePlan(plan.id, scope);
      expect(await runs.get(record!.runId, scope)).toMatchObject({ maxModelCalls: 7, privacy: 'private', modelBudget: { tokens: 1234 },
        context: { sources: expect.arrayContaining([expect.objectContaining({ content: 'Keep me' })]) } });
      expect((await reopened.get(record!.id)).createLease).toBeUndefined();
    } finally { await reopened.close(); }
  });

  it('adopts an existing Run after lease expiry and notifies before acknowledging dispatch', async () => {
    const { plan, domain, engine, dispatches, dispatcher, scheduler } = await setup();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const run = await engine.create({ goal: 'Original', goalId: plan.goalId, taskExecution: { domainPlanId: plan.id, taskId: 'prepare' }, maxModelCalls: 7 }, scope.owner, scope.tenantId);
    const { record } = await dispatches.reserve({ ...scope, goalId: plan.goalId, planId: plan.id, taskId: 'prepare', taskAttempt: 0, runId: run.id, workflowId: run.id, runner: 'test' });
    await dispatches.mutate(record.id, item => { item.createLease = { token: 'crashed', expiresAt: '2000-01-01T00:00:00.000Z' }; });
    const create = vi.spyOn(engine, 'create');
    const notify = vi.spyOn(dispatcher, 'notify').mockRejectedValueOnce(new Error('runner unavailable'));
    await expect(scheduler.scheduleNodeById(plan.id, 'prepare', scope)).rejects.toThrow('runner unavailable');
    expect(await dispatches.get(record.id)).toMatchObject({ state: 'queued', lastError: 'runner unavailable' });
    await scheduler.scheduleNodeById(plan.id, 'prepare', scope);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(await dispatches.get(record.id)).toMatchObject({ state: 'dispatched', lastRunStatus: 'needs_approval' });
    expect((await engine.repository.get(run.id)).maxModelCalls).toBe(7);
  });

  it('recovers a Run created before notification without rebuilding its configured inputs', async () => {
    const { plan, domain, engine, dispatches, dispatcher } = await setup();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const taskExecution = { domainPlanId: plan.id, taskId: 'prepare' };
    const run = await engine.create({ goal: 'Configured task', goalId: plan.goalId, taskExecution, maxModelCalls: 7 }, scope.owner, scope.tenantId);
    await dispatches.reserve({ ...scope, goalId: plan.goalId, planId: plan.id, taskId: 'prepare', taskAttempt: 0, runId: run.id, workflowId: run.id, runner: 'TemporalDispatcher' });
    const notify = vi.spyOn(dispatcher, 'notify');
    const restarted = new TaskScheduler(domain, engine, dispatcher, dispatches);
    const records = await restarted.reconcilePlan(plan.id, scope);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(run.id);
    expect(records[0]).toMatchObject({ state: 'dispatched', lastRunStatus: 'needs_approval' });
    expect((await engine.repository.get(run.id)).maxModelCalls).toBe(7);
    await restarted.reconcilePlan(plan.id, scope);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retries failed runner notification through reconciliation and preserves unknown outcomes', async () => {
    const { plan, domain, engine, runs, dispatches, dispatcher } = await setup();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const notify = vi.spyOn(dispatcher, 'notify').mockRejectedValueOnce(new Error('Temporal unavailable'));
    const scheduler = new TaskScheduler(domain, engine, dispatcher, dispatches);
    await expect(scheduler.schedulePlan(plan.id, scope)).rejects.toThrow('Temporal unavailable');
    expect((await dispatches.list(scope))[0]?.state).toBe('queued');
    notify.mockRejectedValueOnce(new Error('Temporal still unavailable'));
    await expect(scheduler.reconcilePlan(plan.id, scope)).rejects.toThrow('Temporal still unavailable');
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await dispatches.list(scope))[0]).toMatchObject({ state: 'queued', lastError: 'Temporal still unavailable' });
    await scheduler.reconcilePlan(plan.id, scope);
    expect(notify).toHaveBeenCalledTimes(3);
    const [record] = await dispatches.list(scope);
    expect(record?.state).toBe('dispatched');
    await dispatches.mutate(record!.id, item => { item.state = 'queued'; });
    await runs.mutate(record!.runId, item => { item.status = 'unknown'; });
    await scheduler.reconcilePlan(plan.id, scope);
    expect(notify).toHaveBeenCalledTimes(3);
    expect((await dispatches.list(scope))[0]?.state).toBe('unknown');
  });

  it.each(['paused', 'waiting_external', 'needs_input', 'succeeded', 'cancelled', 'failed'] as const)('does not wake a queued reservation whose Run is %s', async status => {
    const { plan, scheduler, runs, dispatcher, dispatches } = await setup();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const [record] = await scheduler.schedulePlan(plan.id, scope);
    await dispatches.mutate(record!.id, current => { current.state = 'queued'; });
    await runs.mutate(record!.runId, current => { current.status = status; });
    const notify = vi.spyOn(dispatcher, 'notify');
    await scheduler.reconcilePlan(plan.id, scope);
    expect(notify).not.toHaveBeenCalled();
    expect((await dispatches.get(record!.id, scope)).state).not.toBe('queued');
  });

  it('controls the bound Run and records cancellation without creating another reservation', async () => {
    const { plan, scheduler, dispatches, runs, engine, domain } = await setup();
    const [record] = await scheduler.schedulePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    await approve(engine, runs, record!.runId);
    const cancelled = await scheduler.controlTask(plan.id, 'prepare', 'cancel', { owner: 'alice', tenantId: 'team-a' });
    expect(cancelled).toMatchObject({ state: 'cancelled', lastRunStatus: 'cancelled', dispatchAttempts: 1 });
    expect((await domain.getPlan(plan.id, 'alice', 'team-a')).nodes[0]!.status).toBe('cancelled');
    expect(await dispatches.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
  });

  it('retries a failed bound task only after the domain node is ready again', async () => {
    const { plan, scheduler, dispatches, runs, engine, domain, dispatcher } = await setup();
    const [record] = await scheduler.schedulePlan(plan.id, { owner: 'alice', tenantId: 'team-a' });
    await approve(engine, runs, record!.runId);
    await runs.mutate(record!.runId, current => { current.status = 'failed'; current.error = 'failed attempt'; });
    await domain.transitionTask({ planId: plan.id, taskId: 'prepare', transition: 'fail', reason: 'failed attempt' }, undefined, 'alice', 'team-a');
    await domain.transitionTask({ planId: plan.id, taskId: 'prepare', transition: 'retry' }, undefined, 'alice', 'team-a');
    const retried = await scheduler.controlTask(plan.id, 'prepare', 'dispatch', { owner: 'alice', tenantId: 'team-a' });
    expect(retried.dispatchAttempts).toBe(2);
    expect(retried.taskAttempt).toBe(1);
    expect(retried.state).toBe('succeeded');
    expect((await dispatches.get(record!.id, { owner: 'alice', tenantId: 'team-a' })).dispatchAttempts).toBe(2);
  });

  it('persists reservations in the file adapter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-task-ledger-'));
    const path = join(directory, 'dispatch.json');
    const first = new FileTaskDispatchRepository(path); await first.init();
    await first.reserve({ owner: 'alice', tenantId: 'team-a', goalId: 'goal-1', planId: 'plan-1', taskId: 'prepare', taskAttempt: 0, runId: 'run_00000000-0000-4000-8000-000000000000', workflowId: 'run_00000000-0000-4000-8000-000000000000', runner: 'TemporalDispatcher' });
    await first.close();
    const second = new FileTaskDispatchRepository(path); await second.init();
    expect(await second.list({ owner: 'alice', tenantId: 'team-a' })).toHaveLength(1);
    await second.close(); await rm(directory, { recursive: true, force: true });
  });

  it('provides a stable bounded dispatch page for long recovery scans', async () => {
    const dispatches = new InMemoryTaskDispatchRepository(); await dispatches.init();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    for (const [index, taskId] of ['a', 'b', 'c'].entries()) {
      await dispatches.reserve({ ...scope, goalId: 'goal-page', planId: 'plan-page', taskId, taskAttempt: 0,
        runId: `run_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        workflowId: `run_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        runner: 'LocalDispatcher', now: `2026-09-21T00:00:0${index}.000Z` });
    }
    await dispatches.reserve({ ...scope, goalId: 'goal-other', planId: 'plan-other', taskId: 'foreign', taskAttempt: 0,
      runId: 'run_00000000-0000-4000-8000-000000000010', workflowId: 'run_00000000-0000-4000-8000-000000000010', runner: 'LocalDispatcher', now: '2026-09-21T00:00:03.000Z' });
    const first = await dispatches.listPage!(scope, 2, undefined, 'plan-page');
    expect(first.records.map(record => record.taskId)).toEqual(['a', 'b']);
    expect(first.nextCursor).toBeDefined();
    const second = await dispatches.listPage!(scope, 2, first.nextCursor, 'plan-page');
    expect(second.records.map(record => record.taskId)).toEqual(['c']);
    expect(second.nextCursor).toBeUndefined();
    expect(await dispatches.listScopes!()).toEqual([scope]);
    await expect(dispatches.listPage!(scope, 2, 'malformed', 'plan-page')).rejects.toThrow('Invalid task dispatch cursor');
    await dispatches.close();
  });

  it('reconciles a plan through bounded pages without reloading the full ledger', async () => {
    const { plan, scheduler, dispatches } = await setup();
    const scope = { owner: 'alice', tenantId: 'team-a' };
    await scheduler.schedulePlan(plan.id, scope);
    const fullList = vi.spyOn(dispatches, 'list').mockRejectedValue(new Error('full dispatch list forbidden'));
    const pages = vi.spyOn(dispatches, 'listPage');
    await scheduler.reconcilePlan(plan.id, scope, { includeRecords: false, pageSize: 1 });
    expect(pages).toHaveBeenCalled();
    expect(fullList).not.toHaveBeenCalled();
  });
});
