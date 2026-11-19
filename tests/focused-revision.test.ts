// Eval pulse-csv-followup (2026-11-19, deepseek-v4.1-flash): two review rounds took ~500 of ~650s. Each revision rewrote the
// whole deliverable, longer every time, and each review started from scratch with new issues. A revision is told to fix
// only the listed issues, and a re-review receives the previous issues and checks them.
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const issues = ['「占比最高」与证据矛盾：open 占 50%，高于 blocked 的 25%。'];

it('asks a revision to fix only the listed issues, and gives the re-review those issues to check', async () => {
  for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  const executors: ModelRequest[] = [], reviewers: ModelRequest[] = [];
  const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] } };
    if (isReviewer(request)) {
      reviewers.push(request);
      return { value: reviewers.length === 1 ? { verdict: 'needs_revision', summary: '排序依据有误', issues } : { verdict: 'accepted', summary: 'ok', issues: [] } };
    }
    executors.push(request);
    return { value: { type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } };
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model });
  const created = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] } as never);
  await engine.advance(created.id);
  const plan = (await repository.get(created.id)).plans[0]!;
  await engine.command(created.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 12; i++) {
    const current = await repository.get(created.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    await engine.advance(created.id);
  }
  const run = await repository.get(created.id);
  expect(run.status, run.error).toBe('succeeded');
  expect(reviewers).toHaveLength(2);
  expect(executors).toHaveLength(2);
  expect(executors[0]!.system).not.toContain('This is a revision after independent review');
  expect(executors[1]!.system).toContain('This is a revision after independent review');
  expect(executors[1]!.system).toContain('Do not add new claims, sections, analysis or recommendations');
  expect(reviewers[0]!.system).not.toContain('This is a re-review');
  expect((reviewers[0]!.input as any).previousReview).toBeUndefined();
  expect(reviewers[1]!.system).toContain('This is a re-review after a revision');
  expect((reviewers[1]!.input as any).previousReview).toEqual({ round: 1, summary: '排序依据有误', issues });
});
