import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentEngine, digest, event } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { decideRunAdvance, maxStalledAdvances } from '../src/temporal/run-advance.js';
import type { AdvanceRunActivityResult } from '../src/temporal/activity.js';
import { InMemoryGlobalBudgetLedger } from '../src/global-budget.js';
import { randomUUID } from 'node:crypto';
import { ThreadService } from '../src/application/thread-service.js';

it.each([false, true])('terminalizes a model timeout without a wake; sources alone do not salvage a zero-output run (materials=%s)', async materials => {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async () => { throw new ModelOutcomeUnknown('Model timed out after 180000ms'); });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  try {
    const run = await engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1', ...(materials ? { materials: [{ title: 'notes.txt', content: '开发完成', source: 'upload' }] } : {}) });
    expect(await engine.advance(run.id)).toBe('unknown');
    const request = { method: 'POST' as const, url: `/internal/runs/${run.id}/terminalize`, payload: { reason: 'Model outcome unknown' } };
    expect((await app.inject(request)).statusCode).toBe(401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject({ ...request, headers: { authorization: 'Bearer worker' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('failed');
    }
    const stopped = await repository.get(run.id);
    expect(stopped.calls[0]?.state).toBe('unknown');
    expect(stopped.status).toBe('failed');
    expect(stopped.partial).toBeFalsy();
    expect(stopped.artifacts).toHaveLength(0);
    expect(stopped.error).toContain('Independent review was not completed');
    expect(stopped.events.filter(event => event.data.terminalized)).toHaveLength(1);
    expect(stopped.events.some(event => event.type === 'run.failed' && event.data.producedArtifacts === 0)).toBe(true);
    expect(await engine.advance(run.id)).toBe('failed');
    expect(complete).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});

it('terminalizes a timeout as succeeded(partial) only when a model-produced artifact already exists', async () => {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async () => { throw new ModelOutcomeUnknown('Model timed out after 180000ms'); });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  try {
    const run = await engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1', materials: [{ title: 'notes.txt', content: '开发完成', source: 'upload' }] });
    await repository.mutate(run.id, current => {
      current.artifacts.push({
        id: `artifact_${randomUUID()}`, taskId: 'pulse', title: 'Project Pulse', content: '开发完成',
        evidenceRefs: [current.context.sources[0]!.id], hash: digest('开发完成'), createdAt: current.createdAt,
      });
      current.status = 'running';
      current.calls.push({ id: 'inflight', phase: 'executor', state: 'started', inputHash: 'hash', startedAt: current.createdAt });
    });
    const response = await app.inject({ method: 'POST', url: `/internal/runs/${run.id}/terminalize`, headers: { authorization: 'Bearer worker' }, payload: { reason: 'Model outcome unknown' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('succeeded');
    const stopped = await repository.get(run.id);
    expect(stopped.partial).toBe(true);
    expect(stopped.artifacts).toHaveLength(1);
    expect(stopped.artifacts[0]).toMatchObject({ partial: true, limitations: [expect.stringContaining('Independent review was not completed')] });
    expect(stopped.events.some(event => event.type === 'run.partial' && event.data.producedArtifacts === 1)).toBe(true);
  } finally { await app.close(); }
});

it('discards a late model result after activity timeout terminalization', async () => {
  const repository = new InMemoryRunRepository();
  let resolve!: (result: any) => void, began!: () => void;
  const started = new Promise<void>(done => { began = done; });
  const pending = new Promise<any>(done => { resolve = done; });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async () => { began(); return pending; } });
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  const run = await engine.create({ goal: 'Project Pulse', materials: [{ title: 'notes.txt', content: '开发完成', source: 'upload' }] });
  const advancing = engine.advance(run.id);
  try {
    await started;
    const response = await app.inject({ method: 'POST', url: `/internal/runs/${run.id}/terminalize`, headers: { authorization: 'Bearer worker' }, payload: { reason: 'Activity timeout' } });
    expect(response.json().status).toBe('failed');
    resolve({ value: { summary: 'Late plan', nodes: [] } });
    expect(await advancing).toBe('failed');
    const stopped = await repository.get(run.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.partial).toBeFalsy();
    expect(stopped.plans).toHaveLength(0);
    expect(stopped.artifacts).toHaveLength(0);
    expect(stopped.events.some(event => event.type === 'model.result_discarded')).toBe(true);
  } finally { resolve({ value: {} }); await advancing; await app.close(); }
});

it('fails an unknown follow-up with no produced artifacts even when thread history has sources', async () => {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async () => { throw new ModelOutcomeUnknown('No response'); } });
  const parent = await engine.create({ goal: 'Project Pulse', materials: [{ title: 'notes.txt', content: '开发完成', source: 'upload' }] }, 'owner', 'local');
  await repository.mutate(parent.id, run => {
    run.status = 'succeeded';
    run.artifacts.push({ id: `artifact_${randomUUID()}`, taskId: 'pulse', title: 'Project Pulse', content: '开发完成', evidenceRefs: [run.context.sources[0]!.id], hash: digest('开发完成'), createdAt: run.createdAt });
  });
  const thread = { id: `thread_${randomUUID()}`, owner: 'owner', tenantId: 'local', createdAt: new Date().toISOString() };
  await repository.createThread(thread, parent.id);
  const child = await new ThreadService(repository, engine).followUp(thread.id, { idempotencyKey: 'unknown-follow', parentRunId: parent.id, request: { goal: 'Follow-up', builtinSkill: 'project-pulse/1' } }, { owner: 'owner', tenantId: 'local' });
  expect(child.context.sources).toEqual([]);
  expect(await engine.advance(child.id)).toBe('unknown');
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  try {
    const response = await app.inject({ method: 'POST', url: `/internal/runs/${child.id}/terminalize`, headers: { authorization: 'Bearer worker' }, payload: { reason: 'Model timeout' } });
    expect(response.json().status).toBe('failed');
    const stopped = await repository.get(child.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.partial).toBeFalsy();
    expect(stopped.artifacts).toHaveLength(0);
    expect(stopped.error).toContain('Model timeout');
  } finally { await app.close(); }
});

it.each(['completed', 'in flight'])('refunds a stale tick when another API call is %s after its budget reservation is delayed', async outcome => {
  const repository = new InMemoryRunRepository(), ledger = new InMemoryGlobalBudgetLedger();
  const select = () => ({ accountKey: 'shared', owner: 'owner', tenantId: 'local', windowKey: 'unbounded', budget: { calls: 2, tokens: 1000 } });
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementationOnce(async (selection, key) => { started(); await pending; return reserve(selection, key); });
  let finish!: () => void, called!: () => void;
  const providerPending = new Promise<void>(resolve => { finish = resolve; });
  const providerBegan = new Promise<void>(resolve => { called = resolve; });
  const complete = vi.fn(async () => {
    called();
    if (outcome === 'in flight') await providerPending;
    return { value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] }, usage: { inputTokens: 10, outputTokens: 5 } };
  });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const services = { model, globalBudget: { ledger, select } };
  const first = new AgentEngine(repository, services), second = new AgentEngine(repository, services);
  const run = await first.create({ goal: 'Report' });
  const advancing = first.advance(run.id);
  let winning: ReturnType<AgentEngine['advance']> | undefined;
  try {
    await began;
    winning = second.advance(run.id);
    await providerBegan;
    if (outcome === 'completed') expect(await winning).toBe('needs_approval');
    release();
    expect(await advancing).toBe(outcome === 'completed' ? 'needs_approval' : 'planning');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await repository.get(run.id)).calls).toHaveLength(1);
    let account = (await ledger.get('shared'))!;
    expect(account.usedCalls).toBe(1);
    expect(Object.values(account.entries).filter(entry => entry.state === 'released')).toHaveLength(1);
    finish();
    expect(await winning).toBe('needs_approval');
    account = (await ledger.get('shared'))!;
    expect(Object.values(account.entries).map(entry => entry.state).sort()).toEqual(['released', 'settled']);
    expect(account.usedTokens).toBe(15);
    expect(account.unreportedTokenCalls).toBe(0);
    // Only the executed call lacks pricing; the released entry adds no hold.
    expect(account.unreportedMoneyCalls).toBe(1);
    const next = await second.create({ goal: 'Another report' });
    expect(await second.advance(next.id)).toBe('needs_approval');
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await ledger.get('shared'))?.usedCalls).toBe(2);
  } finally { release(); finish(); await Promise.all([advancing, winning]); await ledger.close(); }
});

it('returns 202 during a blocked tick, polls after completion, and never duplicates across activity retries or API instances', async () => {
  const repository = new InMemoryRunRepository();
  let resolve!: (value: any) => void;
  let started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  const pending = new Promise<any>(done => { resolve = done; });
  const complete = vi.fn(async () => { started(); return pending; });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, model);
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  const second = buildApp({ repository, engine: new AgentEngine(repository, model), workerToken: 'worker' });
  const run = await engine.create({ goal: 'Report' });
  const request = { method: 'POST' as const, url: `/internal/runs/${run.id}/advance`, headers: { authorization: 'Bearer worker', 'x-aeeis-advance-async': '1' }, payload: {} };
  try {
    const first = await app.inject(request);
    expect(first.statusCode).toBe(202);
    await began;
    for (const server of [app, second, app]) {
      expect((await server.inject(request)).statusCode).toBe(202);
      const poll = await server.inject({ url: request.url, headers: { authorization: 'Bearer worker' } });
      expect(poll.statusCode).toBe(202);
      expect(poll.json().status).toBe('planning');
    }
    expect((await second.inject({ url: request.url })).statusCode).toBe(401);
    expect(complete).toHaveBeenCalledTimes(1);
    resolve({ value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] } });
    let poll;
    for (let i = 0; i < 20; i++) {
      poll = await app.inject({ url: request.url, headers: { authorization: 'Bearer worker' } });
      if (poll.statusCode === 200) break;
      await new Promise(done => setTimeout(done, 1));
    }
    expect(poll!.statusCode).toBe(200);
    expect(poll!.json().status).toBe('needs_approval');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await repository.get(run.id)).calls).toHaveLength(1);
  } finally { resolve({ value: {} }); await app.close(); await second.close(); }
});

it.each([false, true])('completes all ten tasks without a wake (progress enabled: %s)', async progressEnabled => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-advance-ten-tasks-'));
  const repository = new FileRunRepository(directory); await repository.init();
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `task_${i}`, title: `Task ${i}`, instruction: 'Report supplied evidence', dependsOn: i ? [`task_${i - 1}`] : [] }));
  const engine = new AgentEngine(repository, {
    pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' },
    complete: async request => ({ value: request.system.includes('Plan a real deliverable') ? { summary: 'Ten tasks', nodes }
      : request.system.includes('Independently review') ? { verdict: 'accepted', summary: 'Verified all ten tasks' }
      : { type: 'finish', title: 'Report', content: 'Evidence supports the report.', evidenceRefs: [(request.input as { sourceCatalog: Array<{ id: string }> }).sourceCatalog[0]!.id] } }),
  });
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  try {
    const run = await engine.create({ goal: 'Complete ten tasks', materials: [{ title: 'Brief', source: 'upload', content: 'Evidence supports the report.' }] });
    const advance = async (): Promise<AdvanceRunActivityResult> => {
      const response = await app.inject({ method: 'POST', url: `/internal/runs/${run.id}/advance`, headers: { authorization: 'Bearer worker', ...(progressEnabled ? { 'x-aeeis-advance-progress': '1' } : {}) }, payload: {} });
      expect(response.statusCode).toBe(200);
      return response.json();
    };
    expect((await advance()).status).toBe('needs_approval');
    await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
    let previousProgress: string | undefined;
    let stalled = 0, completedTasks = 0, ticks = 0;
    for (; ticks < 100; ticks++) {
      const result = await advance();
      const succeeded = (await repository.get(run.id)).steps.filter(step => step.status === 'succeeded').length;
      // A completing step must reset even a counter one advance from parking.
      if (progressEnabled && succeeded > completedTasks) stalled = maxStalledAdvances - 1;
      const decision = decideRunAdvance(result, previousProgress, stalled);
      expect(decision.kind).not.toBe('wait');
      expect(decision.stalled).toBe(0);
      expect(decision.delayMs).toBe(0);
      previousProgress = result.progress; stalled = decision.stalled; completedTasks = succeeded;
      if (decision.kind === 'terminal') break;
    }
    expect(ticks).toBeGreaterThan(maxStalledAdvances);
    const finished = await repository.get(run.id);
    expect(finished.status, finished.error).toBe('succeeded');
    expect(finished.steps).toHaveLength(10);
    expect(finished.steps.every(step => step.status === 'succeeded')).toBe(true);
    expect(finished.artifacts).toHaveLength(10);
  } finally { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

it('returns durable unknown after a model timeout and never retries it on subsequent advances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-advance-unknown-'));
  const repository = new FileRunRepository(directory); await repository.init();
  const complete = vi.fn(async () => { throw new ModelOutcomeUnknown('Model timed out after 180000ms; reconcile before retrying'); });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete });
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  try {
    const run = await engine.create({ goal: 'Report' });
    const advance = () => app.inject({ method: 'POST', url: `/internal/runs/${run.id}/advance`, headers: { authorization: 'Bearer worker', 'x-aeeis-advance-progress': '1' }, payload: {} });
    const first = await advance();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'unknown', progress: expect.any(String) });
    expect((await repository.get(run.id)).calls[0]?.state).toBe('unknown');
    await repository.mutate(run.id, current => { event(current, 'domain.sync_failed', { reason: 'Telemetry does not prove progress' }); });
    expect((await advance()).json()).toEqual(first.json());
    const legacy = await app.inject({ method: 'POST', url: `/internal/runs/${run.id}/advance`, headers: { authorization: 'Bearer worker' }, payload: {} });
    expect(legacy.json()).toEqual({ status: 'unknown' });
    expect((await advance()).json()).toEqual(first.json());
    expect(complete).toHaveBeenCalledTimes(1);
  } finally { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

it('reports stable progress for an active run fenced by a started model call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-advance-fenced-'));
  const repository = new FileRunRepository(directory); await repository.init();
  const complete = vi.fn();
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete });
  const app = buildApp({ repository, engine, workerToken: 'worker' });
  try {
    const run = await engine.create({ goal: 'Report' });
    await repository.mutate(run.id, current => {
      current.status = 'planning';
      current.calls.push({ id: 'inflight', phase: 'planner', state: 'started', inputHash: 'hash', startedAt: current.createdAt });
    });
    const advance = () => app.inject({ method: 'POST', url: `/internal/runs/${run.id}/advance`, headers: { authorization: 'Bearer worker', 'x-aeeis-advance-progress': '1' }, payload: {} });
    const first = (await advance()).json();
    expect(first).toEqual({ status: 'planning', progress: expect.any(String) });
    await repository.mutate(run.id, current => { event(current, 'domain.sync_failed'); });
    expect((await advance()).json()).toEqual(first);
    expect(complete).not.toHaveBeenCalled();
    await repository.mutate(run.id, current => { current.calls[0]!.state = 'unknown'; current.status = 'unknown'; });
    const changed = (await advance()).json();
    expect(changed.status).toBe('unknown');
    expect(changed.progress).not.toBe(first.progress);
  } finally { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
});
