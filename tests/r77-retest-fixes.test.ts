import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelTimeout, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const twoTasks = { summary: 'Report', nodes: [
  { id: 'extract', title: 'Extract', instruction: 'Extract facts', dependsOn: [] },
  { id: 'report', title: 'Report', instruction: 'Write report', dependsOn: ['extract'] },
] };
async function drive(engine: AgentEngine, repository: InMemoryRunRepository, ticks = 20) {
  const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'Milestone complete.', source: 'upload' }] } as never);
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < ticks; i++) {
    const current = await repository.get(run.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    await engine.advance(run.id).catch(() => undefined);
  }
  return repository.get(run.id);
}
const stall = () => new ModelTimeout('Model response timed out after 90000ms (stall timeout). Provider billing requires reconciliation.');
const overall = () => new ModelTimeout('Model response timed out after 303190ms (overall timeout). Provider billing requires reconciliation.');
function engineWith(onReport: (attempt: number) => void) {
  const repository = new InMemoryRunRepository();
  let reportCalls = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: twoTasks };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    const input = request.input as any;
    const source = input.sourceCatalog[0].id;
    if (JSON.stringify(input).includes('Write report')) onReport(++reportCalls);
    return { value: { type: 'finish', title: 'Part', content: 'The notes say the milestone is complete.', evidenceRefs: [source] } };
  } } satisfies ModelAdapter });
  return { repository, engine, calls: () => reportCalls };
}

it('r77: a stall on a later task retries once even when earlier output is retained, and can fully succeed', async () => {
  const { repository, engine, calls } = engineWith(attempt => { if (attempt === 1) throw stall(); });
  const run = await drive(engine, repository);
  const types = run.events.map(item => item.type);
  expect(types).toContain('model.timeout_retry');
  expect(types).not.toContain('run.partial');
  expect(calls()).toBe(2);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial ?? false).toBe(false);
});

it('r77: a repeated stall is bounded to one retry and then keeps retained output as partial', async () => {
  const { repository, engine, calls } = engineWith(() => { throw stall(); });
  const run = await drive(engine, repository);
  const types = run.events.map(item => item.type);
  expect(types.filter(type => type === 'model.timeout_retry')).toHaveLength(1);
  expect(calls()).toBe(2);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.artifacts.some(artifact => artifact.taskId === 'extract')).toBe(true);
});

it('r77: an overall timeout with retained output still stops immediately without retry', async () => {
  const { repository, engine, calls } = engineWith(() => { throw overall(); });
  const run = await drive(engine, repository);
  const types = run.events.map(item => item.type);
  expect(types).not.toContain('model.timeout_retry');
  expect(calls()).toBe(1);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
});
