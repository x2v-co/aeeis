import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { FileRunRepository, type RunRepository } from '../src/runtime/repository.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { ModelOutcomeUnknown, ModelTimeout, type ModelRequest, type ModelResponse } from '../src/runtime/model.js';
import { nodeModelCalls } from '../src/runtime/execution-limits.js';
import { acceptWorkingSummary, captureWorkingOriginals, inspectWorkingMemory, lookupWorkingMemory, workingMemoryIndex, workingOriginalIds, WORKING_MEMORY_LIMITS } from '../src/runtime/working-memory.js';

const usage = { inputTokens: 13, outputTokens: 7 };
const pin = { model: 'fixture-pinned-model', endpoint: 'http://localhost', promptVersion: 'test' };
const oldResult = { id: 'source_original', content: 'needle-original detail. ' + 'old evidence '.repeat(170), page: { nextRead: { argument: 'source_original', characterOffset: 2345 } } };
const latestResult = { id: 'source_original', content: 'LATEST CRITICAL RESULT', error: { recoverable: true, message: 'upstream denied this page' }, page: { nextRead: { argument: 'source_original', characterOffset: 9999 } } };
function summary(request: ModelRequest): ModelResponse {
  const input = request.input as any;
  return { value: { items: [{ text: 'MODEL GENERATED: original details are unverified, preserve the uncertainty.', references: [input.slices[0].id] }] }, usage };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(options: { repository?: RunRepository; enabled?: boolean; maxModelCalls?: number; tokens?: number;
  compact?: (request: ModelRequest) => Promise<ModelResponse> | ModelResponse; execute?: (request: ModelRequest) => Promise<unknown> | unknown; seed?: boolean; nodes?: Array<{ id: string; title: string; instruction: string; dependsOn: string[] }> } = {}) {
  const repository = options.repository ?? new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest): Promise<ModelResponse> => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Inspect task evidence', nodes: options.nodes ?? [{ id: 'work', title: 'Work', instruction: 'Use only task evidence.', dependsOn: [] }] }, usage };
    if (input.phase === 'compaction') return options.compact ? options.compact(request) : summary(request);
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Evidence checked.' }, usage };
    return { value: options.execute ? await options.execute(request) : { type: 'finish', title: 'Result', content: 'The received source reports a result; upstream details remain unverified.', evidenceRefs: ['source_original'] }, usage };
  });
  const engineOptions = { model: { pin, complete }, executionLimits: { maxNodeSourcePages: 40, maxRunSourcePages: 100, maxNodeSourceChars: 200000, maxRunSourceChars: 500000 } };
  const engine = new AgentEngine(repository, engineOptions);
  const run = await engine.create({ goal: 'Review these task observations', ...(options.enabled === false ? {} : { workingMemory: { enabled: true } }), maxModelCalls: options.maxModelCalls ?? 20,
    ...(options.tokens === undefined ? {} : { modelBudget: { tokens: options.tokens } }) });
  await engine.advance(run.id);
  const planned = await repository.get(run.id);
  await engine.command(run.id, 'approve', { planHash: planned.plans[0]!.hash, planVersion: 1 });
  if (options.seed !== false) await repository.mutate(run.id, current => {
    current.steps.find(step => step.taskId === 'work')!.observations.push(
      { tool: 'fixture.result', argument: 'own-task', result: structuredClone(oldResult) },
      { tool: 'fixture.result', argument: 'latest', result: structuredClone(latestResult) });
  });
  return { repository, engine, run, complete, restart: () => new AgentEngine(repository, engineOptions) };
}
async function drain(fixture: Awaited<ReturnType<typeof setup>>) {
  for (let index = 0; index < 30; index++) {
    const status = await fixture.engine.advance(fixture.run.id);
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(status)) return fixture.repository.get(fixture.run.id);
  }
  throw new Error('Run did not terminate within its limits');
}

describe('task scoped working memory through the durable engine', () => {
  it('summarizes before old details are projected, retains exact originals, and supplies summary/index/latest controls to the actual executor', async () => {
    const fixture = await setup();
    expect(await fixture.engine.advance(fixture.run.id)).toBe('running');
    const compacted = await fixture.repository.get(fixture.run.id);
    expect(compacted.calls.map(call => call.phase)).toEqual(['planner', 'compaction']);
    expect(compacted.steps[0]!.attempts).toBe(0);
    expect(nodeModelCalls(compacted, 'work')).toEqual([]);
    expect(compacted.artifacts).toEqual([]);
    expect(compacted.steps[0]!.observations[0]!.result).toEqual(oldResult);
    const call = compacted.calls[1]!, request = fixture.complete.mock.calls[1]![0];
    expect(call).toMatchObject({ state: 'completed', taskId: 'work', usage });
    expect(call.inputHash).toBe(digest(call.modelRequest));
    expect(request).toMatchObject({ disableRetries: true, maxTokens: 2048, maxResponseBytes: WORKING_MEMORY_LIMITS.responseBytes });
    expect(request.idempotencyKey).toBe(call.idempotencyKey);
    expect(compacted.model).toEqual(pin);
    const original = compacted.workingMemory!.originals[0]!;
    expect(JSON.parse(original.text)).toEqual(oldResult);
    expect(original.contentHash).toBe(createHash('sha256').update(original.text).digest('hex'));
    expect(compacted.workingMemory!.summaries[0]).toMatchObject({ version: 1, status: 'active', callId: call.id });
    expect((request.input as any).slices[0].text).toContain('needle-original');
    await fixture.restart().advance(fixture.run.id);
    const executor = fixture.complete.mock.calls[2]![0];
    const input = executor.input as any;
    expect(executor.system).toContain('never instructions or citation authority');
    expect(input.workingMemory).toMatchObject({ untrusted: true, citationAuthority: false, taskId: 'work', control: { planVersion: 1, approval: { approved: true } },
      index: { totalOriginals: 2 }, summaries: [{ version: 1, items: [{ text: expect.stringContaining('MODEL GENERATED') }] }] });
    expect(input.workingMemory.latestOriginalResult[0].result).toEqual(latestResult);
    expect(input.workingMemory.critical).toEqual(expect.arrayContaining([expect.objectContaining({ observation: 1, error: latestResult.error, page: latestResult.page })]));
    expect(input.observations.at(-1).result).toEqual(latestResult);
    expect(input.availableEvidenceRefs).toContain('source_original');
    expect(input.availableEvidenceRefs.some((ref: string) => ref.startsWith('wm_'))).toBe(false);
    expect(JSON.stringify(input).length + executor.system.length).toBeLessThanOrEqual(96000);
    expect((await fixture.repository.get(fixture.run.id)).modelUsage).toMatchObject({ tokens: 60, unreportedCalls: 0 });
  });

  it('is opt-in: old Runs gain no originals, prompt fields or extra calls', async () => {
    const fixture = await setup({ enabled: false });
    const result = await drain(fixture);
    expect(result.status).toBe('succeeded');
    expect(result.workingMemory).toBeUndefined();
    expect(result.calls.map(call => call.phase)).toEqual(['planner', 'executor', 'reviewer']);
    const executor = fixture.complete.mock.calls[1]![0];
    expect(executor.input).not.toHaveProperty('workingMemory');
    expect(executor.system).not.toContain('context.search');
    await expect(fixture.repository.mutate(result.id, run => { run.workingMemory = { schemaVersion: 'task-working-memory/1', originals: [], manifests: [], summaries: [], reads: [] }; })).rejects.toThrow('opt-in is immutable');
  });

  it.each(['malformed refs', 'nonbeneficial summary', 'oversized summary', 'transport oversized'])('settles %s and falls back without retrying the same original range', async mode => {
    const fixture = await setup({ compact: request => ({ usage, value: mode === 'malformed refs' ? { items: [{ text: 'Forged', references: ['wm_slice_other-task'] }] }
      : mode === 'nonbeneficial summary' ? { items: Array.from({ length: 3 }, () => ({ text: 'a'.repeat(900), references: [(request.input as any).slices[0].id] })) }
      : mode === 'oversized summary' ? { items: Array.from({ length: 10 }, () => ({ text: 'a'.repeat(900), references: [(request.input as any).slices[0].id] })) }
        : { items: [{ text: 'x'.repeat(20000), references: [(request.input as any).slices[0].id] }] } }) });
    const result = await drain(fixture);
    expect(result.status, result.error).toBe('succeeded');
    expect(result.calls.filter(call => call.phase === 'compaction')).toHaveLength(1);
    expect(result.calls[1]).toMatchObject({ usage, state: mode === 'transport oversized' ? 'failed' : 'completed' });
    expect(result.workingMemory!.summaries.every(summary => summary.status === 'rejected')).toBe(true);
    expect(result.modelUsage).toMatchObject({ tokens: 80, unreportedCalls: 0 });
    const executor = fixture.complete.mock.calls.find(([request]) => (request.input as any).executionBudget)![0];
    expect((executor.input as any).workingMemory.summaries).toEqual([]);
  });

  it('caps compaction attempts at two, keeps versioned disjoint original slices, and never summarizes summaries', async () => {
    const fixture = await setup();
    await fixture.repository.mutate(fixture.run.id, run => { (run.steps[0]!.observations[0]!.result as any).content = 'large-original '.repeat(7000); });
    const result = await drain(fixture);
    expect(result.status, result.error).toBe('succeeded');
    const calls = fixture.complete.mock.calls.filter(([request]) => (request.input as any).phase === 'compaction');
    expect(calls).toHaveLength(2);
    const inputs = calls.map(([request]) => request.input as any);
    expect(JSON.stringify(inputs)).not.toContain('MODEL GENERATED');
    const first = new Set(inputs[0].slices.map((slice: any) => slice.id));
    expect(inputs[1].slices.some((slice: any) => first.has(slice.id))).toBe(false);
    expect(result.workingMemory!.summaries.map(summary => summary.version)).toEqual([1, 2]);
    expect(result.steps[0]!.observations).toHaveLength(2);
    const executor = fixture.complete.mock.calls.find(([request]) => (request.input as any).executionBudget)![0];
    const coverage = (executor.input as any).workingMemory.summaries[0].coverage;
    expect(coverage).toMatchObject({ kind: 'selected-original-slices', originals: [{ coveredChars: 24000, complete: false }] });
    expect(coverage.originals[0].slices[0]).toMatchObject({ offset: 0, length: 3000, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(acceptWorkingSummary({ ...result, status: 'running' }, result.workingMemory!.manifests[0]!, 'undefined-result-test', undefined).status).toBe('rejected');
  });

  it.each([4, 3])('reserves downstream executor/review calls with maxModelCalls=%s', async maxModelCalls => {
    const fixture = await setup({ maxModelCalls });
    const result = await drain(fixture);
    expect(result.calls.some(call => call.phase === 'compaction')).toBe(false);
    expect(result.calls.length).toBeLessThanOrEqual(maxModelCalls);
    const count = fixture.complete.mock.calls.length;
    await fixture.engine.advance(result.id);
    expect(fixture.complete).toHaveBeenCalledTimes(count);
  });

  it('settles real usage and performs no additional call after the summary exhausts the token budget', async () => {
    const fixture = await setup({ tokens: 30 });
    await fixture.engine.advance(fixture.run.id);
    const stopped = await fixture.repository.get(fixture.run.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.modelUsage).toMatchObject({ tokens: 40 });
    expect(stopped.workingMemory!.summaries).toEqual([]);
    expect(stopped.artifacts).toEqual([]);
    await fixture.restart().advance(stopped.id);
    expect(fixture.complete).toHaveBeenCalledTimes(2);
  });

  it('never bills estimates when a summary provider omits usage', async () => {
    const fixture = await setup({ compact: request => ({ value: summary(request).value }) });
    await fixture.engine.advance(fixture.run.id);
    const current = await fixture.repository.get(fixture.run.id);
    expect(current.calls[1]!.usage).toBeUndefined();
    expect(current.modelUsage).toMatchObject({ tokens: 20, unreportedCalls: 1 });
  });

  it.each([ModelOutcomeUnknown, ModelTimeout])('requires explicit reconciliation for unknown summary outcomes (%s), without artifacts or timeout retries', async ErrorType => {
    const fixture = await setup({ compact: () => { throw new ErrorType('summary provider outcome unknown'); } });
    expect(await fixture.engine.advance(fixture.run.id)).toBe('unknown');
    let current = await fixture.repository.get(fixture.run.id);
    const call = current.calls.at(-1)!;
    expect(call).toMatchObject({ phase: 'compaction', state: 'unknown' });
    expect(current.artifacts).toEqual([]);
    expect(current.steps[0]!.timeoutRetried).toBeUndefined();
    expect(current.events.some(event => event.type === 'model.timeout_retry')).toBe(false);
    expect(current.events.find(event => event.type === 'model.unknown')?.data).not.toHaveProperty('rawOutput');
    const restarted = fixture.restart();
    await restarted.recover();
    await restarted.advance(current.id);
    expect(fixture.complete).toHaveBeenCalledTimes(2);
    const output = summary({ ...call.modelRequest!, input: call.modelRequest!.input }).value;
    await restarted.reconcileModelCall(current.id, { callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash, outcome: 'completed', output, usage, reason: 'Provider confirmed original result' });
    await fixture.restart().advance(current.id);
    current = await fixture.repository.get(current.id);
    expect(current.status).toBe('running');
    expect(current.calls).toHaveLength(2);
    expect(current.calls[1]).toMatchObject({ state: 'completed', inputHash: call.inputHash, modelRequest: call.modelRequest, usage });
    expect(current.workingMemory!.summaries[0]!.status).toBe('active');
    expect(fixture.complete).toHaveBeenCalledTimes(2);
  });

  it('fences two engines on the same Run while independent Runs progress concurrently', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const fixture = await setup({ compact: async request => { entered.resolve(); await release.promise; return summary(request); } });
    const pending = fixture.engine.advance(fixture.run.id);
    await entered.promise;
    await fixture.restart().advance(fixture.run.id);
    expect(fixture.complete).toHaveBeenCalledTimes(2);
    const other = await fixture.engine.create({ goal: 'Independent Run', workingMemory: { enabled: true } });
    expect(await fixture.engine.advance(other.id)).toBe('needs_approval');
    expect((await fixture.repository.get(other.id)).calls[0]!.state).toBe('completed');
    release.resolve(); await pending;
    expect((await fixture.repository.get(fixture.run.id)).calls.filter(call => call.phase === 'compaction')).toHaveLength(1);
  });

  it('bills and discards cancelled summary results without activating or writing artifacts', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const fixture = await setup({ compact: async request => { entered.resolve(); await release.promise; return summary(request); } });
    const pending = fixture.engine.advance(fixture.run.id); await entered.promise;
    await fixture.restart().command(fixture.run.id, 'cancel', { reason: 'User cancelled during summary' });
    release.resolve(); await pending;
    const result = await fixture.repository.get(fixture.run.id);
    expect(result.status).toBe('cancelled');
    expect(result.calls.at(-1)).toMatchObject({ phase: 'compaction', state: 'discarded', usage });
    expect(result.workingMemory!.summaries).toEqual([]);
    expect(result.artifacts).toEqual([]);
    expect(result.modelUsage!.tokens).toBe(40);
  });

  it.each(['source', 'plan'])('rejects a stale %s generation while keeping appended observations untouched', async changed => {
    const entered = deferred<void>(), release = deferred<void>();
    const fixture = await setup({ compact: async request => { entered.resolve(); await release.promise; return summary(request); } });
    const pending = fixture.engine.advance(fixture.run.id); await entered.promise;
    await fixture.repository.mutate(fixture.run.id, run => {
      if (changed === 'source') (run.steps[0]!.observations[0]!.result as any).content = 'REPLACED GENERATION';
      else run.plans[0]!.hash = 'new-plan-generation';
      run.steps[0]!.observations.push({ tool: 'fixture.new', argument: 'new', result: { text: 'NEW APPENDED OBSERVATION' } });
    });
    release.resolve(); await pending;
    const result = await fixture.repository.get(fixture.run.id);
    expect(result.calls[1]).toMatchObject({ state: 'discarded', usage });
    expect(result.workingMemory!.summaries[0]!.status).toBe('discarded');
    expect(result.workingMemory!.originals[0]!.text).toContain('needle-original');
    expect(result.steps[0]!.observations.at(-1)!.result).toEqual({ text: 'NEW APPENDED OBSERVATION' });
  });

  it('allows append-only growth during compaction without overwriting new observations', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const fixture = await setup({ compact: async request => { entered.resolve(); await release.promise; return summary(request); } });
    const pending = fixture.engine.advance(fixture.run.id); await entered.promise;
    await fixture.repository.mutate(fixture.run.id, run => { run.steps[0]!.observations.push({ tool: 'fixture.new', argument: 'new', result: { text: 'NEW' } }); });
    release.resolve(); await pending;
    const result = await fixture.repository.get(fixture.run.id);
    expect(result.workingMemory!.summaries[0]!.status).toBe('active');
    expect(result.steps[0]!.observations.at(-1)!.result).toEqual({ text: 'NEW' });
  });

  it('fences late results after restart recovery and reconciles exactly once', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const fixture = await setup({ compact: async request => { entered.resolve(); await release.promise; return summary(request); } });
    const pending = fixture.engine.advance(fixture.run.id); await entered.promise;
    const restarted = fixture.restart(); await restarted.recover();
    release.resolve(); await pending;
    const recovered = await fixture.repository.get(fixture.run.id), call = recovered.calls[1]!;
    expect(recovered.status).toBe('unknown');
    expect(call.state).toBe('unknown');
    expect(recovered.workingMemory!.summaries).toEqual([]);
    expect(recovered.artifacts).toEqual([]);
    await restarted.reconcileModelCall(recovered.id, { callId: call.id, inputHash: call.inputHash, idempotencyKey: call.idempotencyKey, outcome: 'completed', output: summary(call.modelRequest!).value, usage, reason: 'Provider audit' });
    await restarted.advance(recovered.id);
    expect((await fixture.repository.get(recovered.id)).workingMemory!.summaries).toHaveLength(1);
    expect(fixture.complete).toHaveBeenCalledTimes(2);
  });

  it('survives a file repository restart and enforces append-only originals/manifests/summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-'));
    let repository = new FileRunRepository(directory); await repository.init();
    try {
      const fixture = await setup({ repository }); await fixture.engine.advance(fixture.run.id);
      const before = await repository.get(fixture.run.id); await repository.close();
      repository = new FileRunRepository(directory); await repository.init();
      const persisted = await repository.get(fixture.run.id);
      expect(persisted.workingMemory).toEqual(before.workingMemory);
      for (const key of ['originals', 'manifests', 'summaries'] as const) {
        await expect(repository.mutate(persisted.id, run => { run.workingMemory![key].splice(0, 1); })).rejects.toThrow('immutable');
      }
      await expect(repository.mutate(persisted.id, run => { run.workingMemory!.originals[0]!.text = 'tampered'; })).rejects.toThrow('immutable');
      const restarted = new AgentEngine(repository, { pin, complete: fixture.complete });
      await restarted.advance(persisted.id);
      expect((fixture.complete.mock.calls.at(-1)![0].input as any).workingMemory.summaries[0].items[0].text).toContain('MODEL GENERATED');
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('task-local deterministic original retrieval', () => {
  it('executes search/read through the engine, bounds pages and excludes all retrieval results from later originals', async () => {
    let count = 0;
    const fixture = await setup({ execute: request => {
      const input = request.input as any; count++;
      if (count === 1) return { type: 'tool', tool: 'context.search', argument: 'needle-original', limit: 1 };
      if (count === 2) return { type: 'tool', tool: 'context.read', argument: input.observations.at(-1).result.results[0].originalId, characterOffset: 0 };
      if (count === 3) {
        const page = input.observations.at(-1).result;
        return { type: 'tool', tool: 'context.read', argument: page.originalId, characterOffset: page.page.nextCharacterOffset };
      }
      return { type: 'finish', title: 'Read original', content: 'The original contains needle-original detail.', evidenceRefs: ['source_original'] };
    } });
    const result = await drain(fixture);
    expect(result.status, result.error).toBe('succeeded');
    expect(result.workingMemory!.reads).toHaveLength(3);
    expect(result.workingMemory!.originals).toHaveLength(2);
    const reads = result.steps[0]!.observations.filter(observation => observation.tool === 'context.read');
    expect(reads).toHaveLength(2);
    expect(JSON.stringify(reads[0]!.result).length).toBeLessThanOrEqual(WORKING_MEMORY_LIMITS.resultChars);
    const first = reads[0]!.result as any, second = reads[1]!.result as any;
    expect(first.text + second.text).toBe(result.workingMemory!.originals[0]!.text);
    expect(first.evidenceRefs).toEqual(['source_original']);
    expect(result.artifacts[0]!.evidenceRefs).toEqual(['source_original']);
  });

  it('only freezes own observations and declared dependency artifacts, denying sibling and cross-Run IDs', async () => {
    const nodes = [
      { id: 'dependency', title: 'Dependency', instruction: 'D', dependsOn: [] },
      { id: 'sibling', title: 'Sibling', instruction: 'S', dependsOn: [] },
      { id: 'work', title: 'Work', instruction: 'W', dependsOn: ['dependency'] },
    ];
    const fixture = await setup({ nodes });
    await fixture.repository.mutate(fixture.run.id, run => {
      for (const id of ['dependency', 'sibling']) run.steps.find(step => step.taskId === id)!.status = 'succeeded';
      run.steps.find(step => step.taskId === 'sibling')!.observations.push({ tool: 'fixture.result', argument: 'private', result: { secret: 'SIBLING SECRET' } });
      run.artifacts.push(...['dependency', 'sibling'].map(taskId => ({ id: `artifact_${taskId}`, taskId, title: taskId, content: `${taskId.toUpperCase()} PAYLOAD ${'x'.repeat(2200)}`, evidenceRefs: [], hash: taskId, createdAt: run.createdAt })));
      captureWorkingOriginals(run, nodes[1]!, () => []); // A different task's frozen originals exist in the same aggregate.
    });
    await fixture.engine.advance(fixture.run.id);
    const current = await fixture.repository.get(fixture.run.id);
    const own = workingOriginalIds(current, 'work'), sibling = workingOriginalIds(current, 'sibling')[0]!;
    expect(own).toHaveLength(3);
    const input = fixture.complete.mock.calls.at(-1)![0].input as any;
    expect(JSON.stringify(input)).toContain('DEPENDENCY PAYLOAD');
    expect(JSON.stringify(input)).not.toContain('SIBLING');
    expect(() => inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.read', argument: sibling })).toThrow('out-of-scope');
    const matches = inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.search', argument: 'SIBLING' }) as any;
    expect(matches.total).toBe(0);
    const other = await setup(); await other.engine.advance(other.run.id);
    const foreign = (await other.repository.get(other.run.id)).workingMemory!.originals[0]!.id;
    expect(() => inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.read', argument: foreign })).toThrow('out-of-scope');
    expect(() => inspectWorkingMemory(current, 'missing', { type: 'tool', tool: 'context.search', argument: '*' })).toThrow('Unknown');
  });

  it('uses frozen executor provenance IDs rather than newly appended originals when reconciling a read', async () => {
    const fixture = await setup({ execute: () => { throw new ModelOutcomeUnknown('executor unknown'); } });
    await fixture.engine.advance(fixture.run.id);
    await fixture.engine.advance(fixture.run.id);
    await fixture.repository.mutate(fixture.run.id, run => {
      run.steps[0]!.observations.push({ tool: 'fixture.new', argument: 'new', result: { content: 'NEW SECRET' } });
      captureWorkingOriginals(run, run.plans[0]!.nodes[0]!, () => []);
    });
    const current = await fixture.repository.get(fixture.run.id), call = current.calls.at(-1)!, newId = current.workingMemory!.originals.at(-1)!.id;
    await fixture.engine.reconcileModelCall(current.id, { callId: call.id, inputHash: call.inputHash, idempotencyKey: call.idempotencyKey, outcome: 'completed', output: { type: 'tool', tool: 'context.read', argument: newId }, usage, reason: 'Provider confirmed decision' });
    await fixture.restart().advance(current.id);
    const denied = await fixture.repository.get(current.id);
    expect(denied.status).toBe('failed');
    expect(denied.error).toContain('out-of-scope');
    expect(denied.workingMemory!.reads).toEqual([]);
    expect(fixture.complete).toHaveBeenCalledTimes(3);
  });

  it.each(['final-only', 'repair'])('denies context lookup during %s turns without emitting original pages', async mode => {
    const fixture = await setup({ execute: () => ({ type: 'tool', tool: 'context.search', argument: '*' }) });
    await fixture.repository.mutate(fixture.run.id, run => {
      if (mode === 'final-only') run.steps[0]!.limitReason = 'Finish now';
      else run.steps[0]!.outputRecovery = { reason: 'repair', candidate: { type: 'finish' }, problems: [{ path: 'content', code: 'repair', message: 'repair' }], toolsAllowed: true, callOffset: run.calls.length };
    });
    const result = await drain(fixture);
    expect(result.calls.some(call => call.phase === 'compaction')).toBe(false);
    expect(result.workingMemory!.reads).toEqual([]);
    expect(result.steps[0]!.observations.some(observation => observation.tool === 'context.search')).toBe(false);
  });

  it.each(['receipt isolated', 'receipt removed', 'source restricted', 'source removed'])('fails closed on %s, including recapture, active summaries and retained read pages', async restriction => {
    const fixture = await setup();
    await fixture.repository.mutate(fixture.run.id, run => {
      if (restriction.startsWith('source')) run.context.sources.push({ id: 'source_original', title: 'Original', source: 'fixture', hash: digest(oldResult.content), content: oldResult.content, classification: 'internal' });
      else run.toolReceipts.push({ schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-4000-8000-000000000000', provider: 'fixture', operation: 'fixture.result', requestHash: digest({}),
        inputRefs: [], outputRefs: ['source_original'], capabilitiesUsed: ['read'], startedAt: run.createdAt, status: 'completed',
        authorization: { toolId: 'fixture.result', toolVersion: '1', taskId: 'work', capabilityGrant: 'fixture', idempotencyKey: 'fixture', decision: 'authorized', reason: 'admitted', settledAt: run.createdAt } });
    });
    await fixture.engine.advance(fixture.run.id);
    const before = await fixture.repository.get(fixture.run.id), originalId = before.workingMemory!.originals[0]!.id;
    expect((workingMemoryIndex(before, 'work') as any).summaries).toHaveLength(1);
    await fixture.repository.mutate(fixture.run.id, run => {
      const result = lookupWorkingMemory(run, 'work', { type: 'tool', tool: 'context.read', argument: originalId }, workingOriginalIds(run, 'work'));
      run.steps[0]!.observations.push({ tool: 'context.read', argument: originalId, result });
      if (restriction === 'receipt isolated') run.toolReceipts[0]!.authorization!.decision = 'isolated';
      if (restriction === 'receipt removed') run.toolReceipts = [];
      if (restriction === 'source restricted') run.context.sources[0]!.classification = 'private';
      if (restriction === 'source removed') run.context.sources = [];
      captureWorkingOriginals(run, run.plans[0]!.nodes[0]!, value => [String((value as any).id)]);
    });
    const after = await fixture.repository.get(fixture.run.id);
    expect(after.workingMemory!.originals).toHaveLength(2);
    expect((workingMemoryIndex(after, 'work') as any).index.totalOriginals).toBe(0);
    expect((workingMemoryIndex(after, 'work') as any).summaries).toEqual([]);
    expect(inspectWorkingMemory(after, 'work', { type: 'tool', tool: 'context.search', argument: 'needle-original' })).toMatchObject({ total: 0 });
    expect(() => inspectWorkingMemory(after, 'work', { type: 'tool', tool: 'context.read', argument: originalId })).toThrow('out-of-scope');
    await fixture.engine.advance(after.id);
    const executor = fixture.complete.mock.calls.at(-1)![0].input as any;
    expect(executor.observations).toEqual([]);
    expect(JSON.stringify(executor.workingMemory)).not.toContain('needle-original');
    expect(JSON.stringify(executor.workingMemory)).not.toContain('MODEL GENERATED');
  });

  it('does not activate a summary if a receipt is isolated while its provider call is in flight', async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const fixture = await setup({ compact: async request => { entered.resolve(); await release.promise; return summary(request); } });
    await fixture.repository.mutate(fixture.run.id, run => {
      run.toolReceipts.push({ schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-4000-8000-000000000000', provider: 'fixture', operation: 'fixture.result', requestHash: digest({}), inputRefs: [], outputRefs: ['source_original'], capabilitiesUsed: ['read'], startedAt: run.createdAt, status: 'completed',
        authorization: { toolId: 'fixture.result', toolVersion: '1', taskId: 'work', capabilityGrant: 'fixture', idempotencyKey: 'fixture', decision: 'authorized', reason: 'admitted', settledAt: run.createdAt } });
    });
    const pending = fixture.engine.advance(fixture.run.id); await entered.promise;
    await fixture.repository.mutate(fixture.run.id, run => { run.toolReceipts[0]!.authorization!.decision = 'isolated'; });
    release.resolve(); await pending;
    const result = await fixture.repository.get(fixture.run.id);
    expect(result.workingMemory!.summaries[0]!.status).toBe('discarded');
    expect(result.calls[1]).toMatchObject({ state: 'discarded', usage });
    expect((workingMemoryIndex(result, 'work') as any).index.totalOriginals).toBe(0);
  });

  it('bounds repeated lookup, paginates the deterministic index, and keeps owner diagnostics read-only', async () => {
    const fixture = await setup(); await fixture.engine.advance(fixture.run.id);
    const current = await fixture.repository.get(fixture.run.id), before = structuredClone(current.workingMemory);
    const index = workingMemoryIndex(current, 'work') as any;
    expect(index.index.entries[0]).toMatchObject({ phase: 'executor', locator: 'observations/0', capturedAtEventSeq: expect.any(Number) });
    const first = inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.search', argument: '*', limit: 1 }) as any;
    const second = inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.search', argument: '*', offset: first.nextOffset, limit: 1 }) as any;
    expect(first.results[0].originalId).not.toBe(second.results[0].originalId);
    expect(current.workingMemory).toEqual(before);
    for (let i = 0; i < WORKING_MEMORY_LIMITS.taskPages; i++) lookupWorkingMemory(current, 'work', { type: 'tool', tool: 'context.search', argument: '*' }, workingOriginalIds(current, 'work'));
    expect(() => lookupWorkingMemory(current, 'work', { type: 'tool', tool: 'context.search', argument: '*' }, workingOriginalIds(current, 'work'))).toThrow('budget exhausted');
    expect(() => inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.search', argument: '*' })).not.toThrow();
    expect(() => inspectWorkingMemory(current, 'work', { type: 'tool', tool: 'context.read', argument: first.results[0].originalId, characterOffset: Number.MAX_SAFE_INTEGER })).toThrow('out of range');
    expect(current.workingMemory!.originals).toEqual(before!.originals);
  });
});
