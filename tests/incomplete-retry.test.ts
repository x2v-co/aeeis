// Eval baseline 2026-11-18 pulse-csv-followup (deepseek-v4.1-flash): the pulse reply ran past the output limit even after
// the adapter's larger-limit retry, and "Model response is incomplete" failed the whole Run. A cut-off executor reply now
// gets one task retry told to keep the reply short; a second cut-off keeps completed work or fails as before.
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { HttpModelAdapter, ModelResponseIncomplete, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const quiet = () => { for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined); };
const finish = (request: ModelRequest) => ({ value: { type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } });

async function drive(plan: { summary: string; nodes: unknown[] }, executor: (request: ModelRequest, call: number) => { value: unknown }, options: { executionLimits?: Record<string, number>; maxModelCalls?: number } = {}) {
  quiet();
  const repository = new InMemoryRunRepository();
  const systems: string[] = [];
  const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: plan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    systems.push(request.system);
    return executor(request, systems.length);
  } };
  const engine = new AgentEngine(repository, { model, ...(options.executionLimits ? { executionLimits: options.executionLimits as never } : {}) });
  const created = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }], ...(options.maxModelCalls ? { maxModelCalls: options.maxModelCalls } : {}) } as never);
  await engine.advance(created.id);
  const first = (await repository.get(created.id)).plans[0]!;
  await engine.command(created.id, 'approve', { planHash: first.hash, planVersion: first.version });
  for (let i = 0; i < 12; i++) {
    const current = await repository.get(created.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    await engine.advance(created.id).catch(() => undefined);
  }
  return { run: await repository.get(created.id), systems };
}
const onePlan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] };

it('retries a task once after a cut-off reply, telling it the reply ran too long', async () => {
  const { run, systems } = await drive(onePlan, (request, call) => {
    if (call === 1) throw new ModelResponseIncomplete('length', { inputTokens: 10, outputTokens: 32_768 });
    return finish(request);
  });
  const types = run.events.map(item => item.type);
  expect(run.status, run.error).toBe('succeeded');
  expect(types).toContain('model.incomplete_retry');
  expect(types).not.toContain('run.failed');
  expect(systems).toHaveLength(2);
  expect(systems[0]).not.toContain('previous reply for this task was cut off');
  expect(systems[1]).toContain('previous reply for this task was cut off because it ran past the output length limit');
  expect(run.steps[0]!.incompleteRetried).toEqual({ finishReason: 'length' });
  expect(run.calls.filter(call => call.phase === 'executor').map(call => call.state)).toEqual(['failed', 'completed']);
});

it('fails the Run when the retry is cut off too and nothing was completed', async () => {
  const { run, systems } = await drive(onePlan, () => { throw new ModelResponseIncomplete('length'); });
  expect(systems).toHaveLength(2);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('Model response is incomplete (finish_reason: length)');
  expect(run.events.filter(item => item.type === 'model.incomplete_retry')).toHaveLength(1);
});

it('keeps completed tasks as partial output when the retry is cut off too', async () => {
  const twoPlan = { summary: 'Report', nodes: [
    { id: 'facts', title: 'Facts', instruction: 'Collect facts', dependsOn: [] },
    { id: 'report', title: 'Report', instruction: 'Write the report', dependsOn: ['facts'] },
  ] };
  const { run, systems } = await drive(twoPlan, (request, call) => {
    if (call === 1) return finish(request);
    throw new ModelResponseIncomplete(null);
  });
  expect(systems).toHaveLength(3);
  expect(systems[2]).toContain('stopped before it finished (finish_reason none)');
  expect(run.status, run.error).toBe('succeeded');
  expect(run.events.map(item => item.type)).toContain('run.partial');
  expect(run.artifacts.some(artifact => artifact.taskId === 'facts')).toBe(true);
});

// Review on #236: a final-only reply (source-page limit reached) cut off with no retry left must still turn the
// task's observations into a limited artifact, as before, instead of failing the Run.
const readThenCutOff = (request: ModelRequest) => {
  const input = request.input as any;
  if (!input.executionBudget?.finalOnly && !input.observations?.length) return { value: { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0].id, offset: 0, limit: 1 } };
  throw new ModelResponseIncomplete('length');
};
const finalOnlyCalls = (systems: string[]) => systems.filter(system => system.includes('FINAL CALL')).length;

it('keeps the observations of a final-only task cut off twice as a limited artifact', async () => {
  const { run, systems } = await drive(onePlan, readThenCutOff, { executionLimits: { maxNodeSourcePages: 1 } });
  expect(finalOnlyCalls(systems)).toBe(2);
  expect(run.events.filter(item => item.type === 'model.incomplete_retry')).toHaveLength(1);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.events.map(item => item.type)).not.toContain('run.failed');
  expect(run.artifacts.find(artifact => artifact.taskId === 'report')).toMatchObject({ partial: true });
});

it('keeps the observations of a final-only task cut off with no retry budget left', async () => {
  // The Run model-time budget left (60s) is below the minimum for another call (10 min), so no retry is granted.
  vi.stubEnv('AEEIS_RUN_MODEL_BUDGET_MS', '60000'); vi.stubEnv('AEEIS_REVIEW_RESERVE_MS', '0'); vi.stubEnv('AEEIS_MODEL_CALL_MIN_MS', '600000');
  const { run, systems } = await drive(onePlan, readThenCutOff, { executionLimits: { maxNodeSourcePages: 1 } });
  expect(finalOnlyCalls(systems)).toBe(1);
  expect(run.events.map(item => item.type)).not.toContain('model.incomplete_retry');
  expect(run.status, run.error).toBe('succeeded');
  expect(run.artifacts.find(artifact => artifact.taskId === 'report')).toMatchObject({ partial: true });
});

it('reports the provider finish reason when a reply stays cut off after the larger-limit retry', async () => {
  quiet();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"partial":' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })));
  vi.stubGlobal('fetch', fetch);
  const model = new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 10_000, undefined, false, undefined, { maxAttempts: 1 });
  const error = await model.complete({ system: 's', input: {} }).catch(e => e);
  expect(error).toBeInstanceOf(ModelResponseIncomplete);
  expect(error).toMatchObject({ finishReason: 'length', message: 'Model response is incomplete (finish_reason: length)' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
