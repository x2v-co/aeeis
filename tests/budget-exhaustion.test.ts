import { expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { boundedObservations } from '../src/runtime/prompt-context.js';
import type { ModelRequest } from '../src/runtime/model.js';

it('pdf2/pdf5: keeps the full field schema after a later observation instead of provoking another read', () => {
  const fields = Array.from({ length: 8 }, (_, i) => ({ name: `field_${i}`, type: 'text', value: '', required: true, readOnly: false, options: ['one', 'two'], details: 'x'.repeat(40) }));
  const result = { id: 'source_pdf', fieldCount: 8, fields, page: { offset: 0, nextRead: null } };
  expect(JSON.stringify(result).length).toBeGreaterThan(1000);
  const projected = boundedObservations([{ tool: 'pdf.formFields', argument: 'source_pdf', result }, { tool: 'pdf.fill', argument: 'source_pdf', result: { error: { recoverable: true, message: 'Omit the placeholder' } } }], () => ['source_pdf']);
  expect(projected[0]!.result).toMatchObject({ fields, fieldCount: 8 });
});

async function setup() {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Inspect evidence', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Partial evidence retained' } };
    if (input.executionBudget.finalOnly) return { value: { type: 'finish', title: 'Report', content: 'Partial: the source says complete; further details remain unverified.', evidenceRefs: [input.sourceCatalog[0].id] } };
    return { value: { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0].id, offset: 0, limit: 1 } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  return { repository, engine, run, complete };
}

it('stops repeated identical reads early and presents the original result on a duplicate', async () => {
  const f = await setup();
  for (let i = 0; i < 9; i++) await f.engine.advance(f.run.id);
  const run = await f.repository.get(f.run.id);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.calls).toHaveLength(6); // Planner + read + two duplicates + finish + review.
  expect(run.steps[0]!.observations[1]!.result).toHaveProperty('originalResult');
  expect(run.artifacts[0]?.limitations).toContain('Repeated tool calls made no progress');
});

it('enforces the run allowance in the prompt and reserves a finish before review', async () => {
  const f = await setup();
  await f.repository.mutate(f.run.id, run => { run.maxModelCalls = 4; });
  for (let i = 0; i < 6; i++) await f.engine.advance(f.run.id);
  const run = await f.repository.get(f.run.id);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.calls).toHaveLength(4);
  expect((f.complete.mock.calls[2]![0].input as any).executionBudget).toMatchObject({ finalOnly: true, remainingModelCalls: 2 });
  expect(run.artifacts[0]?.limitations).toContain('Run model call budget nearly exhausted');
});

it('exhaustion without another model call still builds an observation-based partial artifact', async () => {
  const f = await setup();
  await f.engine.advance(f.run.id);
  await f.repository.mutate(f.run.id, run => { run.maxModelCalls = run.calls.length; });
  const calls = f.complete.mock.calls.length;
  expect(await f.engine.advance(f.run.id)).toBe('succeeded');
  const run = await f.repository.get(f.run.id);
  expect(f.complete).toHaveBeenCalledTimes(calls);
  expect(run.partial).toBe(true);
  expect(run.artifacts[0]?.content).toContain('complete');
  expect(run.artifacts[0]?.evidenceRefs).toContain(run.context.sources[0]?.id);
  expect(run.limitations?.join(' ')).toContain('Model call budget exhausted');
});
