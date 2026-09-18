import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelPin } from '../src/runtime/contracts.js';

const pin: ModelPin = { model: 'fixture-model', endpoint: 'http://127.0.0.1:9999/chat/completions', promptVersion: 'fixture/1' };

class PlanningFixture implements ModelAdapter {
  readonly pin = pin;
  readonly calls: ModelRequest[] = [];
  async complete(request: ModelRequest) {
    this.calls.push(request);
    if (request.system.includes('Plan a real deliverable')) {
      return { value: { summary: 'Research and synthesize the supplied brief', nodes: [
        { id: 'research', title: 'Research the brief', instruction: 'Read the supplied source and extract facts', dependsOn: [] },
        { id: 'synthesize', title: 'Synthesize a report', instruction: 'Produce the final report', dependsOn: ['research'] },
      ] } };
    }
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Evidence supports the report', issues: [] } };
    const input = request.input as { task: { id: string }; observations: Array<{ result: unknown }>; dependencies: Array<{ id: string }>; sourceCatalog: Array<{ id: string }> };
    const sourceId = input.sourceCatalog[0]!.id;
    if (input.task.id === 'research' && input.observations.length === 0) return { value: { type: 'tool', tool: 'sources.read', argument: sourceId } };
    if (input.task.id === 'research') return { value: { type: 'finish', title: 'Research notes', content: 'The source says to ship safely.', evidenceRefs: [sourceId] } };
    return { value: { type: 'finish', title: 'Final report', content: 'The report recommends shipping safely.', evidenceRefs: input.dependencies.map(d => d.id) } };
  }
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-runtime-'));
  const repo = new FileRunRepository(directory);
  await repo.init();
  return repo;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const oneTaskPlan = { summary: 'Specific fixture task', nodes: [{ id: 'one', title: 'One', instruction: 'Produce a result', dependsOn: [] }] };

describe('AEEIS runtime', () => {
  it('generates a dynamic plan, requires exact approval, executes with evidence, and reviews it', async () => {
    const repo = await repository();
    const model = new PlanningFixture();
    const engine = new AgentEngine(repo, model);
    const run = await engine.create({ goal: 'Assess this release', materials: [{ title: 'Brief', source: 'fixture', content: 'The source says to ship safely.' }] });
    expect((await engine.advance(run.id))).toBe('needs_approval');
    let current = await repo.get(run.id);
    expect(current.plans[0]?.nodes).toHaveLength(2);
    expect(current.calls.some(call => call.phase === 'executor')).toBe(false);
    await expect(engine.command(run.id, 'approve', { planHash: 'wrong' })).rejects.toThrow('match');
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    for (let i = 0; i < 10; i += 1) {
      const status = await engine.advance(run.id);
      if (['succeeded', 'failed'].includes(status)) break;
    }
    current = await repo.get(run.id);
    expect(current.status).toBe('succeeded');
    expect(current.artifacts.map(a => a.title)).toEqual(['Research notes', 'Final report']);
    expect(current.review?.verdict).toBe('accepted');
    expect(current.events.map(e => e.type)).toContain('tool.completed');
    expect(model.calls.filter(call => call.system.includes('Plan a real deliverable'))).toHaveLength(1);
    await repo.close();
  });

  it('serializes concurrent mutations and preserves revisions on disk', async () => {
    const repo = await repository();
    const engine = new AgentEngine(repo, new PlanningFixture());
    const run = await engine.create({ goal: 'Concurrent writes' });
    await Promise.all(Array.from({ length: 12 }, (_, index) => repo.mutate(run.id, current => {
      current.error = `write-${index}`;
    })));
    const current = await repo.get(run.id);
    expect(current.revision).toBe(12);
    expect(current.error).toMatch(/^write-/);
    await repo.close();
  });

  it('reserves one request under concurrent ticks and discards a cancelled result', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>();
    const entered = deferred<void>();
    let requests = 0;
    const engine = new AgentEngine(repo, { pin, complete: async () => { requests++; entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Cancellation' });
    const tick = engine.advance(run.id);
    await entered.promise;
    await Promise.all([engine.advance(run.id), engine.advance(run.id)]);
    expect(requests).toBe(1);
    await engine.command(run.id, 'cancel', {});
    response.resolve({ value: oneTaskPlan });
    expect(await tick).toBe('cancelled');
    const current = await repo.get(run.id);
    expect(current.plans).toEqual([]);
    expect(current.calls[0]?.state).toBe('discarded');
    await repo.close();
  });

  it('checkpoints a plan returned while paused and resumes into approval', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>(), entered = deferred<void>();
    const engine = new AgentEngine(repo, { pin, complete: async () => { entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Pause' });
    const tick = engine.advance(run.id); await entered.promise;
    await engine.command(run.id, 'pause', {});
    response.resolve({ value: oneTaskPlan });
    expect(await tick).toBe('paused');
    expect((await repo.get(run.id)).resumeStatus).toBe('needs_approval');
    expect((await engine.command(run.id, 'resume', {})).status).toBe('needs_approval');
    await repo.close();
  });

  it('requires reconciliation after ambiguous transport failure, including a paused call', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>(), entered = deferred<void>();
    const engine = new AgentEngine(repo, { pin, complete: async () => { entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Unknown outcome' });
    const tick = engine.advance(run.id); await entered.promise;
    await engine.command(run.id, 'pause', {});
    response.reject(new ModelOutcomeUnknown('Provider may have completed'));
    expect(await tick).toBe('unknown');
    await expect(engine.command(run.id, 'retry', {})).rejects.toThrow('reconciliation');
    expect(await engine.advance(run.id)).toBe('unknown');
    expect((await repo.get(run.id)).calls).toHaveLength(1);
    expect((await engine.command(run.id, 'reconcile', { reason: 'Checked provider status and authorize another call' })).status).toBe('queued');
    await repo.close();
  });

  it('preserves a definite failure received while paused instead of silently retrying on resume', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>(), entered = deferred<void>();
    const engine = new AgentEngine(repo, { pin, complete: async () => { entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Pause and fail' });
    const tick = engine.advance(run.id); await entered.promise;
    await engine.command(run.id, 'pause', {});
    response.reject(new Error('Model provider returned HTTP 401'));
    expect(await tick).toBe('paused');
    expect((await engine.command(run.id, 'resume', {})).status).toBe('failed');
    await repo.close();
  });

  it('recovers interrupted reservations without resending the request', async () => {
    const repo = await repository();
    const model = new PlanningFixture(), engine = new AgentEngine(repo, model);
    const run = await engine.create({ goal: 'Restart recovery' });
    await repo.mutate(run.id, current => {
      current.status = 'planning';
      current.calls.push({ id: 'interrupted-call', phase: 'planner', state: 'started', inputHash: 'hash', startedAt: new Date().toISOString() });
    });
    await engine.recover();
    expect(await engine.advance(run.id)).toBe('unknown');
    expect(model.calls).toEqual([]);
    await repo.close();
  });
});
