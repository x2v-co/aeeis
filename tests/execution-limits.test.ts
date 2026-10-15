import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { evidenceWritingGuidance, sourceFidelityGuidance, AgentEngine, digest } from '../src/runtime/engine.js';
import { executionLimitsConfig, runSourceReadUsage, sourceReadUsage, type ExecutionLimits } from '../src/runtime/execution-limits.js';
import { ModelOutcomeUnknown, type ModelRequest } from '../src/runtime/model.js';

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
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash, planVersion: (await repository.get(run.id)).plans[0]!.version });
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
    expect((artifact.structured as any).unknowns).toEqual([]);
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

  it.each(['tool', 'capability', 'delegate', 'question'])('retries a %s in the final call without executing it and fails only after bounded retries', async type => {
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
    expect(finished.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(2);
    expect(finished.error).toContain('retries exhausted');
    expect(fixture.complete).toHaveBeenCalledTimes(4); // planner + final + two corrective turns
  });

  it.each(['tool', 'capability', 'delegate', 'question'])('repairs a final %s decision using existing evidence without executing the action', async type => {
    const fixture = await setup({ maxNodeIterations: 2 }, input => input.outputRecovery
      ? { type: 'finish', title: 'Partial report', content: 'The supplied summary reports blocked items; further inspection remains unverified.', evidenceRefs: [input.sourceCatalog[0].id] }
      : type === 'tool' ? { type, tool: 'sources.search', argument: 'blocked' }
      : type === 'capability' ? { type, toolId: 'forbidden', toolVersion: '1', input: {}, purpose: 'Forbidden' }
      : type === 'delegate' ? { type, agentId: 'forbidden', goal: 'Forbidden', expectedOutput: 'result-envelope/1', mode: 'sync' }
      : { type, question: 'Read more?' });
    await fixture.repository.mutate(fixture.run.id, current => { current.steps[0]!.limitReason = 'Node source page limit reached'; });
    await fixture.engine.advance(fixture.run.id);
    fixture.replaceEngine();
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.steps[0]!.observations).toEqual([]);
    expect(run.pendingTool).toBeUndefined();
    expect(run.pendingDelegation).toBeUndefined();
    expect(run.question).toBeUndefined();
    expect(run.artifacts[0]!.partial).toBe(true);
    expect(run.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(1);
    const retry = fixture.complete.mock.calls.filter(([request]) => request.system.includes('Execute the current task'))[1]![0];
    expect(retry.input).toMatchObject({ executionBudget: { finalOnly: true, remainingModelCalls: 1 }, outputRecovery: { toolsAllowed: false } });
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

  it.each(['offset', 'legacy events'])('restores node iterations for reused IDs after replanning with %s, including after restart', async format => {
    let acceptFinish = false;
    const fixture = await setup({ maxNodeIterations: 2 }, input => input.executionBudget.finalOnly && acceptFinish
      ? { type: 'finish', title: 'Partial', content: 'Inspected relevant rows.', evidenceRefs: [input.sourceCatalog[0].id] }
      : { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0].id, offset: 0, limit: 20 });
    const failed = await fixture.drain();
    expect(failed.status).toBe('failed');
    expect(failed.calls.filter(call => call.phase === 'executor')).toHaveLength(4);
    const usage = runSourceReadUsage(failed);
    // Upgrade an older Run that only kept source consumption in observations.
    if (format === 'legacy events') await fixture.repository.mutate(failed.id, current => { delete current.sourceReadUsage; });
    await fixture.engine.command(failed.id, 'replan', {});
    expect(await fixture.engine.advance(failed.id)).toBe('needs_approval');
    const proposed = await fixture.repository.get(failed.id);
    expect(proposed.plans[1]!.hash).toBe(proposed.plans[0]!.hash); // Same IDs and exact draft, new revision.
    expect(runSourceReadUsage(proposed)).toEqual(usage);
    await fixture.engine.command(failed.id, 'approve', { planHash: proposed.plans[1]!.hash, planVersion: proposed.plans[1]!.version });
    if (format === 'legacy events') await fixture.repository.mutate(failed.id, current => {
      for (const plan of current.plans) delete plan.modelCallOffset;
      // Equal timestamps must not confuse the proposal/call ordering boundary.
      for (const call of current.calls) call.startedAt = current.plans[1]!.createdAt;
    });
    acceptFinish = true;
    fixture.replaceEngine();
    const before = fixture.complete.mock.calls.length;
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    const next = fixture.complete.mock.calls[before]![0].input as any;
    expect(next.executionBudget).toMatchObject({ finalOnly: false, remainingModelCalls: 2, nodeReads: { pages: 0, chars: 0 }, runReads: usage });
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(6);
    expect(runSourceReadUsage(finished).pages).toBe(2);
    expect(sourceReadUsage(finished.steps).pages).toBe(1);
  });

  it('keeps the run source page allowance exhausted after replanning reuses a node ID', async () => {
    let acceptFinish = false;
    const fixture = await setup({ maxNodeIterations: 2, maxRunSourcePages: 1 }, input => input.executionBudget.finalOnly && acceptFinish
      ? { type: 'finish', title: 'Partial', content: 'Run-wide evidence allowance remains exhausted.', evidenceRefs: [input.sourceCatalog[0].id] }
      : { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0].id, offset: 0, limit: 20 });
    const failed = await fixture.drain();
    expect(failed.status).toBe('failed');
    await fixture.engine.command(failed.id, 'replan', {}); await fixture.engine.advance(failed.id);
    await fixture.engine.command(failed.id, 'approve', { planHash: (await fixture.repository.get(failed.id)).plans.at(-1)!.hash, planVersion: (await fixture.repository.get(failed.id)).plans.at(-1)!.version });
    acceptFinish = true;
    const before = fixture.complete.mock.calls.length;
    const finished = await fixture.drain();
    expect((fixture.complete.mock.calls[before]![0].input as any).executionBudget).toMatchObject({ finalOnly: true, reason: 'Run source page limit reached', remainingModelCalls: 2 });
    expect(finished.status).toBe('succeeded');
    expect(runSourceReadUsage(finished).pages).toBe(1);
    expect(sourceReadUsage(finished.steps).pages).toBe(0);
    expect(finished.artifacts[0]!.limitations).toEqual(['Run source page limit reached']);
  });

  it('preserves the run model call budget when replanning resets node iterations', async () => {
    const fixture = await setup({ maxNodeIterations: 2 }, input => ({ type: 'tool', tool: 'sources.search', argument: 'blocked' }));
    const failed = await fixture.drain();
    await fixture.repository.mutate(failed.id, current => { current.maxModelCalls = 7; });
    await fixture.engine.command(failed.id, 'replan', {}); await fixture.engine.advance(failed.id);
    await fixture.engine.command(failed.id, 'approve', { planHash: (await fixture.repository.get(failed.id)).plans.at(-1)!.hash, planVersion: (await fixture.repository.get(failed.id)).plans.at(-1)!.version });
    const exhausted = await fixture.drain();
    expect(exhausted.status).toBe('failed');
    expect(exhausted.error).toContain('Model call budget exhausted');
    expect(exhausted.calls).toHaveLength(7); // Both planners and all executor revisions still count.
    expect(fixture.complete).toHaveBeenCalledTimes(7);
  });

  it('reconciles a pre-offset unknown request that counted a reused ID across all revisions', async () => {
    const fixture = await setup({ maxNodeIterations: 4 });
    fixture.complete.mockRejectedValueOnce(new Error('Definite first executor failure'));
    expect(await fixture.engine.advance(fixture.run.id)).toBe('failed');
    await fixture.engine.command(fixture.run.id, 'replan', {}); await fixture.engine.advance(fixture.run.id);
    await fixture.engine.command(fixture.run.id, 'approve', { planHash: (await fixture.repository.get(fixture.run.id)).plans.at(-1)!.hash, planVersion: (await fixture.repository.get(fixture.run.id)).plans.at(-1)!.version });
    fixture.complete.mockRejectedValueOnce(new ModelOutcomeUnknown('Unknown after replanning'));
    expect(await fixture.engine.advance(fixture.run.id)).toBe('unknown');
    const unknown = await fixture.repository.get(fixture.run.id), call = unknown.calls.at(-1)!;
    const original = structuredClone(call.modelRequest)!;
    // The pre-offset builder included the old revision's failed executor call.
    (original.input as any).executionBudget.remainingModelCalls = 3;
    delete (original.input as any).clock; // pre-offset requests predate clock injection
    original.system = original.system.replace(evidenceWritingGuidance, '').replace(sourceFidelityGuidance, '').replace(/\nFor questions, include missing[^\n]*/, ''); // ...and the newer evidence/question rules
    const originalHash = digest(original);
    await fixture.repository.mutate(unknown.id, current => {
      for (const plan of current.plans) delete plan.modelCallOffset;
      current.calls.at(-1)!.inputHash = originalHash;
      delete current.calls.at(-1)!.modelRequest;
    });
    const providerCalls = fixture.complete.mock.calls.length;
    await fixture.engine.reconcileModelCall(unknown.id, { callId: call.id, inputHash: originalHash, idempotencyKey: call.idempotencyKey, outcome: 'completed', reason: 'Provider confirmed the pre-offset request', output: { type: 'finish', title: 'Report', content: 'The source summary reports blocked records.', evidenceRefs: [unknown.context.sources[0]!.id] } });
    expect(await fixture.engine.advance(unknown.id)).toBe('running');
    const recovered = await fixture.repository.get(unknown.id);
    expect(recovered.calls.at(-1)).toMatchObject({ id: call.id, inputHash: originalHash, state: 'completed', modelRequest: original });
    expect(fixture.complete).toHaveBeenCalledTimes(providerCalls);
  });

  it('counts artifact repairs within the same model iteration allowance', async () => {
    const fixture = await setup({ maxNodeIterations: 2 }, input => ({ type: 'finish', title: 'Candidate', content: 'Partial', evidenceRefs: [input.sourceCatalog[0].id], ...(input.executionBudget.finalOnly ? {} : { artifactType: 'project-pulse/1' }) }));
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(finished.calls.filter(call => call.phase === 'executor')).toHaveLength(2);
    expect(finished.artifacts[0]!.partial).toBe(true);
  });

  it.each(['snapshot', 'hash only'])('reconciles an unknown final call with %s using its original input without another provider request', async format => {
    const fixture = await setup({ maxNodeIterations: 2 });
    await fixture.engine.advance(fixture.run.id); // first read
    fixture.complete.mockRejectedValueOnce(new ModelOutcomeUnknown('idle timeout'));
    expect(await fixture.engine.advance(fixture.run.id)).toBe('unknown');
    const unknown = await fixture.repository.get(fixture.run.id), call = unknown.calls.at(-1)!;
    if (format === 'hash only') await fixture.repository.mutate(unknown.id, current => { delete current.calls.at(-1)!.modelRequest; });
    expect(unknown.steps[0]!.finalCallId).toBe(call.id);
    expect(await fixture.engine.advance(unknown.id)).toBe('unknown');
    expect(fixture.complete).toHaveBeenCalledTimes(3);
    await fixture.engine.reconcileModelCall(unknown.id, { callId: call.id, inputHash: call.inputHash, idempotencyKey: call.idempotencyKey, outcome: 'completed', reason: 'Provider confirmed the exact original request', output: { type: 'finish', title: 'Partial', content: 'Observed source summary.', evidenceRefs: [unknown.context.sources[0]!.id] } });
    expect(await fixture.engine.advance(unknown.id)).toBe('running');
    const resumed = await fixture.repository.get(unknown.id);
    expect(resumed.calls.at(-1)).toMatchObject({ id: call.id, inputHash: call.inputHash, idempotencyKey: call.idempotencyKey, state: 'completed' });
    expect(resumed.artifacts[0]!.partial).toBe(true);
    expect(fixture.complete).toHaveBeenCalledTimes(3);
  });

  it('withholds the next page once cumulative characters exceed the remaining allowance', async () => {
    const fixture = await setup();
    await fixture.engine.advance(fixture.run.id);
    const first = await fixture.repository.get(fixture.run.id), used = sourceReadUsage(first.steps);
    await fixture.repository.mutate(first.id, current => { current.executionLimits!.maxRunSourceChars = used.chars + 100; });
    const finished = await fixture.drain();
    expect(finished.status).toBe('succeeded');
    expect(sourceReadUsage(finished.steps)).toEqual(used);
    expect(finished.sourceReadUsage).toEqual(used);
    expect(finished.steps[0]!.observations.at(-1)!.tool).toBe('sources.read.limit');
    expect(finished.artifacts[0]!.partial).toBe(true);
  });

  it('reserves a final call durably before a rejected provider response and never repeats it on retry', async () => {
    const fixture = await setup({ maxNodeSourcePages: 1 });
    await fixture.engine.advance(fixture.run.id);
    fixture.complete.mockRejectedValueOnce(new Error('Provider rejected the finish'));
    expect(await fixture.engine.advance(fixture.run.id)).toBe('failed');
    const failed = await fixture.repository.get(fixture.run.id);
    expect(failed.steps[0]!.finalCallId).toBe(failed.calls.at(-1)!.id);
    await fixture.engine.command(failed.id, 'retry');
    expect(await fixture.engine.advance(failed.id)).toBe('failed');
    expect((await fixture.repository.get(failed.id)).error).toContain('final finish call exhausted');
    expect(fixture.complete).toHaveBeenCalledTimes(3);
  });

  it('validates configuration and defaults', () => {
    expect(executionLimitsConfig({}).maxNodeIterations).toBe(8);
    expect(executionLimitsConfig({ AEEIS_MAX_NODE_ITERATIONS: '3' }).maxNodeIterations).toBe(3);
    expect(() => executionLimitsConfig({ AEEIS_MAX_NODE_ITERATIONS: '1' })).toThrow();
    for (const value of ['NaN', '0', '-1', '1.5']) expect(() => executionLimitsConfig({ AEEIS_MAX_RUN_SOURCE_CHARS: value })).toThrow();
  });
});
