import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelTimeout, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const oneTask = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Write report', dependsOn: [] }] };
const stall = () => new ModelTimeout('Model response timed out after 90000ms (stall timeout). Provider billing requires reconciliation.');
const firstByte = () => new ModelTimeout('Model response timed out after 120000ms (first-byte timeout). Provider billing requires reconciliation.');
const overall = () => new ModelTimeout('Model response timed out after 420000ms (overall timeout). Provider billing requires reconciliation.');

function engineWith(onPlanner: (attempt: number) => void) {
  const repository = new InMemoryRunRepository();
  let plannerCalls = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) { onPlanner(++plannerCalls); return { value: oneTask }; }
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    const input = request.input as any;
    return { value: { type: 'finish', title: 'Report', content: 'The notes say the milestone is complete.', evidenceRefs: [input.sourceCatalog[0].id] } };
  } } satisfies ModelAdapter });
  return { repository, engine, plannerCalls: () => plannerCalls };
}

async function drive(engine: AgentEngine, repository: InMemoryRunRepository, ticks = 20) {
  const created = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'Milestone complete.', source: 'upload' }] } as never);
  for (let i = 0; i < ticks; i++) {
    const current = await repository.get(created.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    if (current.status === 'needs_approval') {
      const plan = current.plans.at(-1)!;
      await engine.command(created.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
      continue;
    }
    await engine.advance(created.id).catch(() => undefined);
  }
  return repository.get(created.id);
}

it.each([['stall', stall], ['first-byte', firstByte]] as const)('r81 pdf2/pdf3: a first planner %s timeout retries the planner once and the Run can fully succeed', async (_kind, error) => {
  const { repository, engine, plannerCalls } = engineWith(attempt => { if (attempt === 1) throw error(); });
  const run = await drive(engine, repository);
  const retries = run.events.filter(item => item.type === 'model.timeout_retry');
  expect(retries).toHaveLength(1);
  expect(retries[0]!.data).toMatchObject({ phase: 'planner', taskId: null, reason: expect.stringContaining('planner call') });
  expect(run.events.map(item => item.type)).not.toContain('run.failed');
  expect(plannerCalls()).toBe(2);
  expect(run.calls.filter(call => call.phase === 'planner').map(call => call.state)).toEqual(['unknown', 'completed']);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial ?? false).toBe(false);
  expect(run.plans).toHaveLength(1);
});

it('r81: a repeated planner stall is bounded to one retry and then fails with the planner timeout reason', async () => {
  const { repository, engine, plannerCalls } = engineWith(() => { throw stall(); });
  const run = await drive(engine, repository);
  expect(run.events.filter(item => item.type === 'model.timeout_retry')).toHaveLength(1);
  expect(plannerCalls()).toBe(2);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('planner call, stall timeout');
  expect(run.events.at(-1)!.type).toBe('run.failed');
});

it('r81: a planner overall timeout is a deadline and still fails without retry', async () => {
  const { repository, engine, plannerCalls } = engineWith(() => { throw overall(); });
  const run = await drive(engine, repository);
  expect(run.events.some(item => item.type === 'model.timeout_retry')).toBe(false);
  expect(plannerCalls()).toBe(1);
  expect(run.status).toBe('failed');
  expect(run.error).toContain('planner call, overall timeout');
});

it('r81: no planner retry when the Run model budget cannot afford another minimum call', async () => {
  vi.stubEnv('AEEIS_RUN_MODEL_BUDGET_MS', '300000');
  vi.stubEnv('AEEIS_REVIEW_RESERVE_MS', '290000');
  try {
    const { repository, engine, plannerCalls } = engineWith(() => { throw stall(); });
    const run = await drive(engine, repository);
    expect(run.events.some(item => item.type === 'model.timeout_retry')).toBe(false);
    expect(plannerCalls()).toBe(1);
    expect(run.status).toBe('failed');
  } finally { vi.unstubAllEnvs(); }
});
