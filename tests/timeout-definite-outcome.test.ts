import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelTimeout, HttpModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { terminalizeRun } from '../src/runtime/terminalize-run.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(['planner', 'executor', 'reviewer'] as const)('closes a %s timeout while retaining its unresolved billing receipt', async phase => {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) {
      if (phase === 'planner') throw new ModelTimeout('Model request timed out after 240000ms (first-byte timeout)');
      return { value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] } };
    }
    if (phase === 'executor' || request.system.includes('Independently review')) throw new ModelTimeout('Model response timed out after 180000ms (idle timeout)');
    return { value: { type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } } });
  const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  await engine.advance(run.id);
  if (phase !== 'planner') {
    const plan = (await repository.get(run.id)).plans[0]!;
    await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
    for (let i = 0; i < 4; i++) await engine.advance(run.id);
  }
  const finished = await repository.get(run.id);
  expect(finished.status).toBe(phase === 'reviewer' ? 'succeeded' : 'failed');
  expect(finished.calls.at(-1)?.state).toBe('unknown');
  expect(finished.resumeStatus).toBeUndefined();
  if (phase === 'reviewer') {
    expect(finished.partial).toBe(true);
    expect(finished.artifacts[0]?.limitations?.join(' ')).toContain('idle timeout');
  } else expect(finished.error).toContain(phase === 'planner' ? 'first-byte timeout' : 'idle timeout');
  const call = finished.calls.at(-1)!;
  const reconciled = await engine.reconcileModelCall(run.id, { callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash, outcome: 'completed', reason: 'Billing checked', output: {}, usage: { inputTokens: 1, outputTokens: 1 } });
  expect(reconciled.status).toBe(finished.status);
  expect(reconciled.calls.at(-1)?.state).toBe('discarded');
});

it('keeps the specific timeout reason when terminalizing a historical unknown run', async () => {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async () => ({ value: {} }) });
  const run = await engine.create({ goal: 'Summarize' });
  await repository.mutate(run.id, current => {
    current.status = 'unknown';
    current.calls.push({ id: 'timeout', phase: 'planner', state: 'unknown', inputHash: 'hash', startedAt: run.createdAt,
      validationErrors: [{ path: '$', code: 'model_error', message: 'Model response timed out after 180000ms (idle timeout)' }] });
  });
  const finished = await terminalizeRun(repository, run.id, 'Model or activity outcome is unknown');
  expect(finished.status).toBe('failed');
  expect(finished.error).toContain('idle timeout');
  expect(finished.error).not.toContain('outcome is unknown');
});

it('uses the overall deadline for JSON fallback instead of the SSE idle deadline', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"choices":'));
  } }), { headers: { 'content-type': 'application/json' } })));
  const adapter = new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'fixture', '', undefined, 1000, undefined, false, undefined,
    { stream: true, idleTimeoutMs: 100, firstByteTimeoutMs: 500, streamOverallTimeoutMs: 1000, maxAttempts: 1 });
  const done = expect(adapter.complete({ system: 's', input: {} })).rejects.toThrow('1000ms (overall timeout)');
  await vi.advanceTimersByTimeAsync(1001);
  await done;
});
