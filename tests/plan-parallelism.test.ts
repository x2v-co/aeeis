import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ContentCipher, InMemoryContentKeyStore, configureContentEncryption, openAggregate, sealAggregate } from '../src/content-encryption.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelRequest } from '../src/runtime/model.js';
import { PLAN_PARALLELISM_EVENT, planParallelism, runEventPlain } from '../src/runtime/plan-parallelism.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 20, 0, 0, seconds)).toISOString();
function shaped(nodes: Array<{ id: string; dependsOn: string[] }>, calls: Array<[taskId: string, start: number, end: number]>): AgentRun {
  return {
    status: 'succeeded',
    plans: [{ version: 2, hash: 'h'.repeat(64), createdAt: at(0), summary: 'plan', nodes: nodes.map(node => ({ ...node, title: node.id, instruction: node.id })) }],
    calls: [
      { id: 'model_plan', phase: 'planner', state: 'completed', inputHash: 'x', startedAt: at(0), endedAt: at(500) },
      ...calls.map(([taskId, start, end], index) => ({ id: `model_${index}`, phase: 'executor', taskId, state: 'completed', inputHash: 'x', startedAt: at(start), endedAt: at(end) })),
    ],
  } as unknown as AgentRun;
}

describe('plan parallelism measurement', () => {
  afterEach(() => configureContentEncryption(undefined));

  it('measures width, task time and the time parallel tasks could have saved', () => {
    // a and b are independent research tasks; c waits for both.
    const run = shaped([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }, { id: 'c', dependsOn: ['a', 'b'] }],
      [['a', 10, 40], ['a', 45, 70], ['b', 70, 90], ['c', 90, 100]]);
    expect(planParallelism(run)).toEqual({
      schemaVersion: 'plan-parallelism/1', planHash: 'h'.repeat(64), planVersion: 2, status: 'succeeded',
      tasks: 3, roots: 2, width: 2, measuredTasks: 3,
      serialMs: 90_000, criticalPathMs: 70_000, savableMs: 20_000,
    });
  });

  it('reports nothing to save for a chain', () => {
    const run = shaped([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }], [['a', 0, 30], ['b', 30, 50]]);
    expect(planParallelism(run)).toMatchObject({ width: 1, roots: 1, serialMs: 50_000, criticalPathMs: 50_000, savableMs: 0 });
  });

  it('leaves the critical path unknown when a task never ran', () => {
    const run = shaped([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }], [['a', 0, 30]]);
    expect(planParallelism(run)).toMatchObject({ tasks: 2, width: 2, measuredTasks: 1, serialMs: 30_000, criticalPathMs: null, savableMs: null });
  });

  it('keeps only the measurement numbers readable next to the encrypted event', async () => {
    configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
    const data = { ...planParallelism(shaped([{ id: 'a', dependsOn: [] }], [['a', 0, 5]]))!, extra: 'not copied' };
    const stored = await sealAggregate('run-event', 'local', 'evt_1', data, value => runEventPlain(PLAN_PARALLELISM_EVENT, value)) as Record<string, unknown>;
    expect(stored).toMatchObject({ tasks: 1, width: 1, serialMs: 5_000, savableMs: 0, status: 'succeeded' });
    expect(stored).not.toHaveProperty('extra');
    expect(await openAggregate('run-event', 'evt_1', stored)).toEqual(data);
    // Every other event stays fully sealed.
    expect(runEventPlain('model.started', { tasks: 1 })).toEqual({});
    expect(runEventPlain(PLAN_PARALLELISM_EVENT, { tasks: 1 })).toEqual({});
  });

  it('records one event when a Run finishes', async () => {
    const repository = new InMemoryRunRepository();
    const complete = vi.fn(async (request: ModelRequest) => {
      const input = request.input as any;
      if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Two sources then a summary', nodes: [
        { id: 'first', title: 'First source', instruction: 'Summarize the first source', dependsOn: [] },
        { id: 'second', title: 'Second source', instruction: 'Summarize the second source', dependsOn: [] },
        { id: 'summary', title: 'Summary', instruction: 'Combine both', dependsOn: ['first', 'second'] },
      ] } };
      if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Fine' } };
      return { value: { type: 'finish', title: input.task.title, content: `${input.task.title} done.`, evidenceRefs: [] } };
    });
    const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete } });
    const run = await engine.create({ goal: 'Compare two sources' });
    await engine.advance(run.id);
    const plan = (await repository.get(run.id)).plans[0]!;
    await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
    for (let i = 0; i < 20; i++) if (['succeeded', 'failed'].includes(await engine.advance(run.id))) break;
    await engine.advance(run.id);
    const finished = await repository.get(run.id);
    expect(finished.status, finished.error).toBe('succeeded');
    const recorded = finished.events.filter(item => item.type === PLAN_PARALLELISM_EVENT);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.data).toMatchObject({ planHash: plan.hash, status: 'succeeded', tasks: 3, roots: 2, width: 2, measuredTasks: 3 });
  });
});
