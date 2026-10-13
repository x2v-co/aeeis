import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { executionLimitsConfig, runSourceReadUsage, sourceReadUsage, type ExecutionLimits } from '../src/runtime/execution-limits.js';
import type { ModelRequest } from '../src/runtime/model.js';

const csv = ['id,status', ...Array.from({ length: 800 }, (_, i) => `${i},blocked`)].join('\n');
async function setup(limits: Partial<ExecutionLimits> = {}, decide?: (input: any) => unknown, nodes = 1, pulse = false) {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Report', nodes: Array.from({ length: nodes }, (_, i) => ({ id: `task_${i}`, title: 'Report', instruction: 'Inspect relevant evidence', dependsOn: i ? [`task_${i - 1}`] : [] })) } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Honest partial result' } };
    if (input.executionBudget.finalOnly) {
      expect(request.system).toContain('FINAL CALL');
      return { value: decide?.(input) ?? { type: 'finish', title: 'Report', content: 'The supplied summary reports blocked items; unread rows remain unverified.', evidenceRefs: [input.sourceCatalog[0].id],
        ...(input.expectedArtifactType ? { artifactType: 'project-pulse/1', structured: { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] } } : {}) } };
    }
    const last = input.observations.at(-1)?.result;
    return { value: decide?.(input) ?? { type: 'tool', tool: 'sources.read', ...(last?.page?.nextRead ?? { argument: input.sourceCatalog[0].id, offset: 0, limit: 20 }) } };
  });
  let engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete }, executionLimits: limits });
  const run = await engine.create({ goal: 'Report blocked items', ...(pulse ? { builtinSkill: 'project-pulse/1' } : {}), materials: [{ title: 'large.csv', source: 'upload', content: csv }] });
  await engine.advance(run.id);
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
  const drain = async () => {
    for (let i = 0; i < 40; i++) { const status = await engine.advance(run.id); if (['succeeded', 'failed', 'unknown'].includes(status)) return repository.get(run.id); }
    throw new Error('Run did not terminate within its bounded calls');
  };
  return { repository, engine, run, complete, drain, replaceEngine: () => { engine = new AgentEngine(repository, { model: { pin: run.model, complete }, executionLimits: { maxNodeSourcePages: 100 } }); } };
}

describe('durable execution allowances', () => {
  it('stops runaway CSV nextRead after four pages and makes one partial Project Pulse finish', async () => {
    const fixture = await setup({}, undefined, 1, true);
    await fixture.engine.advance(fixture.run.id);
    fixture.replaceEngine(); // Frozen allowances and observations survive restart.
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(5);
    expect(sourceReadUsage(finished.steps).pages).toBe(4);
    const artifact = finished.artifacts[0]!;
    expect(artifact).toMatchObject({ partial: true, limitations: ['Node source page limit reached'], artifactType: 'project-pulse/1' });
    expect(artifact.content).toContain('Partial answer');
    expect((artifact.structured as any).unknowns[0].text).toContain('Limited evidence');
    expect(finished.partial).toBe(true);
    expect(finished.steps[0]!.finalCallId).toBe(finished.calls.filter(call => call.phase === 'executor').at(-1)!.id);
    expect(artifact.hash).toBe(digest({ type: 'finish', title: artifact.title, content: artifact.content, evidenceRefs: artifact.evidenceRefs, artifactType: artifact.artifactType, structured: artifact.structured }));
  });

  it('reserves the last node iteration for finish even when search repeats forever', async () => {
    const fixture = await setup({ maxNodeIterations: 3 }, input => input.executionBudget.finalOnly
      ? { type: 'finish', title: 'Partial', content: 'No row inspection was completed.', evidenceRefs: [input.sourceCatalog[0].id] }
      : { type: 'tool', tool: 'sources.search', argument: 'blocked' });
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(3);
    expect(finished.artifacts[0]!.limitations).toEqual(['Node model iteration limit reached']);
  });

  it.each(['tool', 'capability', 'delegate', 'question'])('rejects a %s in the final call without executing it or repairing again', async type => {
    const fixture = await setup({ maxNodeIterations: 2 }, () => type === 'tool' ? { type, tool: 'sources.search', argument: 'blocked' }
      : type === 'capability' ? { type, toolId: 'forbidden', toolVersion: '1', input: {}, purpose: 'Forbidden' }
      : type === 'delegate' ? { type, agentId: 'forbidden', goal: 'Forbidden', expectedOutput: 'result-envelope/1', mode: 'sync' }
      : { type, question: 'Read more?' });
    // The ordinary first call must be safe; inject a pre-existing model iteration.
    await fixture.repository.mutate(fixture.run.id, current => { current.calls.push({ id: 'prior', phase: 'executor', taskId: 'task_0', state: 'completed', inputHash: 'hash', startedAt: current.createdAt }); });
    const finished = await fixture.drain();
    expect(finished.status).toBe('failed');
    expect(finished.error).toContain('tools are disallowed');
    expect(finished.steps[0]!.observations).toEqual([]);
    expect(finished.pendingTool).toBeUndefined();
    expect(finished.pendingDelegation).toBeUndefined();
    await fixture.engine.advance(finished.id);
    expect(fixture.complete).toHaveBeenCalledTimes(2); // planner + final
  });

  it.each(['maxNodeSourceChars', 'maxRunSourceChars'] as const)('never admits a page larger than remaining %s', async name => {
    const fixture = await setup({ [name]: 100 });
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(sourceReadUsage(finished.steps)).toEqual({ pages: 0, chars: 0 });
    expect(finished.steps[0]!.observations[0]!.tool).toBe('sources.read.limit');
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(2);
    expect(finished.artifacts[0]!.partial).toBe(true);
  });

  it('enforces total run page consumption across nodes and replanning', async () => {
    const fixture = await setup({ maxRunSourcePages: 2 }, undefined, 2);
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(runSourceReadUsage(finished).pages).toBe(2);
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(4);
    expect(finished.artifacts.every(artifact => artifact.partial)).toBe(true);
    await fixture.repository.mutate(finished.id, current => { current.steps = [{ taskId: 'new', status: 'pending', attempts: 0, observations: [] }]; });
    expect(runSourceReadUsage(await fixture.repository.get(finished.id)).pages).toBe(2);
  });

  it('counts artifact repairs within the same model iteration allowance', async () => {
    const fixture = await setup({ maxNodeIterations: 2 }, input => ({ type: 'finish', title: 'Candidate', content: 'Partial', evidenceRefs: [input.sourceCatalog[0].id], ...(input.executionBudget.finalOnly ? {} : { artifactType: 'project-pulse/1' }) }));
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(2);
    expect(finished.artifacts[0]!.partial).toBe(true);
  });

  it('validates configuration and defaults', () => {
    expect(executionLimitsConfig({}).maxNodeIterations).toBe(8);
    expect(executionLimitsConfig({ AEEIS_MAX_NODE_ITERATIONS: '3' }).maxNodeIterations).toBe(3);
    expect(() => executionLimitsConfig({ AEEIS_MAX_NODE_ITERATIONS: '1' })).toThrow();
    for (const value of ['NaN', '0', '-1', '1.5']) expect(() => executionLimitsConfig({ AEEIS_MAX_RUN_SOURCE_CHARS: value })).toThrow();
  });
});
