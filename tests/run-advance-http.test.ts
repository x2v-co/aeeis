import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentEngine, event } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';

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
