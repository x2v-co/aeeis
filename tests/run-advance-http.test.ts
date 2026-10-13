import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentEngine, event } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { decideRunAdvance, maxStalledAdvances } from '../src/temporal/run-advance.js';
import type { AdvanceRunActivityResult } from '../src/temporal/activity.js';
import { InMemoryGlobalBudgetLedger } from '../src/global-budget.js';

it('does not duplicate a stale tick when another API finishes while its budget reservation is delayed', async () => {
  const repository = new InMemoryRunRepository(), ledger = new InMemoryGlobalBudgetLedger();
  const select = () => ({ accountKey: 'shared', owner: 'owner', tenantId: 'local', windowKey: 'unbounded', budget: { calls: 10, tokens: 1000 } });
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const reserve = ledger.reserve.bind(ledger);
  vi.spyOn(ledger, 'reserve').mockImplementationOnce(async (selection, key) => { started(); await pending; return reserve(selection, key); });
  const complete = vi.fn(async () => ({ value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] }, usage: { inputTokens: 10, outputTokens: 5 } }));
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const services = { model, globalBudget: { ledger, select } };
  const first = new AgentEngine(repository, services), second = new AgentEngine(repository, services);
  const run = await first.create({ goal: 'Report' });
  const advancing = first.advance(run.id);
  try {
    await began;
    expect(await second.advance(run.id)).toBe('needs_approval');
    release();
    expect(await advancing).toBe('needs_approval');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await repository.get(run.id)).calls).toHaveLength(1);
    const account = (await ledger.get('shared'))!;
    expect(Object.values(account.entries).every(entry => entry.state === 'settled')).toBe(true);
    expect(account.usedTokens).toBe(15);
  } finally { release(); await advancing; }
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
