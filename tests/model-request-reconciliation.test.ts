import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { ModelOutcomeUnknown, type ModelRequest } from '../src/runtime/model.js';

// Captured by the actual abde784 engine after a successful CSV read, followed
// by an unknown executor/reviewer outcome. Keep the original hashes and prompts.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/model-reconciliation-abde784.json', import.meta.url), 'utf8')) as {
  cases: Record<'executor' | 'reviewer', { run: AgentRun; request: ModelRequest; output: unknown }>;
};

describe('model request compatibility across upgrades', () => {
  it.each(['executor', 'reviewer'] as const)('applies a confirmed abde784 %s result without calling the provider', async phase => {
    const fixture = fixtures.cases[phase], repository = new InMemoryRunRepository();
    await repository.create(structuredClone(fixture.run));
    const complete = vi.fn(async () => { throw new Error('A confirmed call must not be replayed'); });
    const engine = new AgentEngine(repository, { model: { pin: fixture.run.model, complete }, executionLimits: { maxNodeIterations: 2 } });
    const call = fixture.run.calls.at(-1)!;
    expect(digest(fixture.request)).toBe(call.inputHash);
    await engine.reconcileModelCall(fixture.run.id, { callId: call.id, inputHash: call.inputHash, idempotencyKey: call.idempotencyKey, outcome: 'completed', reason: 'Provider confirmed the pre-upgrade request', output: fixture.output, usage: { inputTokens: 10, outputTokens: 5 } });
    // Also cover upgrading after the confirmed result has already been staged.
    const upgraded = new AgentEngine(repository, { model: { pin: fixture.run.model, complete }, executionLimits: { maxNodeIterations: 2 } });
    expect(await upgraded.advance(fixture.run.id)).toBe(phase === 'executor' ? 'running' : 'succeeded');
    const current = await repository.get(fixture.run.id);
    expect(current.calls).toHaveLength(fixture.run.calls.length);
    expect(current.calls.at(-1)).toMatchObject({ id: call.id, inputHash: call.inputHash, idempotencyKey: call.idempotencyKey, state: 'completed', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(current.reconciledModelCall).toBeUndefined();
    expect(current.partial).toBeUndefined();
    if (phase === 'executor') expect(current.steps[0]!.observations).toHaveLength(2); // Legacy tool decision stays valid.
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(['executor', 'reviewer'] as const)('replays the exact abde784 %s request and original idempotency key only when authorized', async phase => {
    const fixture = fixtures.cases[phase], repository = new InMemoryRunRepository();
    await repository.create(structuredClone(fixture.run));
    const complete = vi.fn(async (request: ModelRequest) => {
      expect({ system: request.system, input: request.input }).toEqual(fixture.request);
      expect(request.idempotencyKey).toBe(fixture.run.calls.at(-1)!.idempotencyKey);
      return { value: fixture.output };
    });
    const engine = new AgentEngine(repository, { model: { pin: fixture.run.model, complete }, executionLimits: { maxNodeIterations: 2 } });
    expect(await engine.advance(fixture.run.id)).toBe('unknown');
    expect(complete).not.toHaveBeenCalled();
    await engine.command(fixture.run.id, 'reconcile', { reason: 'Provider checked; replay authorized' });
    expect(await engine.advance(fixture.run.id)).toBe(phase === 'executor' ? 'running' : 'succeeded');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await repository.get(fixture.run.id)).calls).toHaveLength(fixture.run.calls.length);
  });

  it('persists and reuses a new outstanding request despite changed reconstruction inputs', async () => {
    const repository = new InMemoryRunRepository(), original: ModelRequest[] = [];
    const complete = vi.fn(async (request: ModelRequest) => {
      original.push(request);
      if (original.length === 1) throw new ModelOutcomeUnknown('Unknown planner outcome');
      return { value: { summary: 'Plan', nodes: [{ id: 'work', title: 'Work', instruction: 'Work', dependsOn: [] }] } };
    });
    const model = { pin: fixtures.cases.executor.run.model, complete };
    const engine = new AgentEngine(repository, model), run = await engine.create({ goal: 'Preserve exact inputs' });
    expect(await engine.advance(run.id)).toBe('unknown');
    const unknown = await repository.get(run.id), call = unknown.calls[0]!;
    expect(call.modelRequest).toEqual({ system: original[0]!.system, input: original[0]!.input, maxTokens: original[0]!.maxTokens });
    expect(digest(call.modelRequest)).toBe(call.inputHash);
    await repository.mutate(run.id, current => { current.goal = 'Changed reconstruction input'; });
    const upgraded = new AgentEngine(repository, model);
    await upgraded.command(run.id, 'reconcile', { reason: 'Provider checked; exact replay authorized' });
    expect(await upgraded.advance(run.id)).toBe('needs_approval');
    expect({ system: original[1]!.system, input: original[1]!.input, maxTokens: original[1]!.maxTokens }).toEqual(call.modelRequest);
    expect(original[1]!.idempotencyKey).toBe(call.idempotencyKey);
    expect((await repository.get(run.id)).calls).toHaveLength(1);
  });

  it.each(['legacy hash', 'persisted request'])('keeps a call with an unmatched %s unknown and never calls the provider', async format => {
    const fixture = fixtures.cases.executor, repository = new InMemoryRunRepository();
    const run = structuredClone(fixture.run);
    if (format === 'legacy hash') run.calls.at(-1)!.inputHash = 'a'.repeat(64);
    else run.calls.at(-1)!.modelRequest = { system: 'Changed request', input: {} };
    await repository.create(run);
    const complete = vi.fn(async () => ({ value: fixture.output }));
    const engine = new AgentEngine(repository, { pin: run.model, complete });
    await engine.command(run.id, 'reconcile', { reason: 'Provider checked' });
    expect(await engine.advance(run.id)).toBe('failed');
    expect((await repository.get(run.id)).calls.at(-1)!.state).toBe('unknown');
    expect(complete).not.toHaveBeenCalled();
  });
});
