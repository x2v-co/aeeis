import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, normalizeReviewOptionals } from '../src/runtime/engine.js';
import type { ModelRequest } from '../src/runtime/model.js';

async function run(reviews: unknown[]) {
  const repository = new InMemoryRunRepository();
  let reviewCalls = 0;
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Plan', nodes: [{ id: 't', title: 'T', instruction: 'Summarize', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) {
      const value = reviews[Math.min(reviewCalls, reviews.length - 1)]; reviewCalls++;
      if (reviewCalls > 1) expect((request.input as { reviewRepair?: unknown }).reviewRepair).toBeDefined();
      return { value };
    }
    return { value: { type: 'finish', title: 'Done', content: 'Summary of notes.', evidenceRefs: (request.input as { availableEvidenceRefs?: string[] }).availableEvidenceRefs?.slice(0, 1) ?? [] } };
  });
  const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete } });
  const created = await engine.create({ goal: 'Summarize notes', materials: [{ title: 'n.txt', source: 'upload', content: 'notes' }] }, 'owner', 'local');
  await engine.advance(created.id);
  await engine.command(created.id, 'approve', { planHash: (await repository.get(created.id)).plans[0]!.hash, planVersion: (await repository.get(created.id)).plans[0]!.version });
  for (let i = 0; i < 16; i++) {
    const status = await engine.advance(created.id);
    if (['succeeded', 'failed'].includes(status)) break;
  }
  return { result: await repository.get(created.id), reviewCalls: () => reviewCalls };
}

describe('lenient reviewer optionals', () => {
  it.each([['string', 'improve the prompt'], ['array', ['a', 'b']], ['null', null], ['number', 3]])('drops a mistyped improvement (%s)', (_label, improvement) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeReviewOptionals({ verdict: 'accepted', summary: 'ok', improvement });
    expect(out).not.toHaveProperty('improvement');
    if (improvement !== null) expect(warn).toHaveBeenCalledWith(expect.stringContaining('improvement'));
    warn.mockRestore();
  });

  it('coerces text fields: arrays joined, objects stringified; bad confidence dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeReviewOptionals({ summary: ['a', 'b'], issues: [{ x: 1 }, null, 'y'], confidence: 'high', improvement: { change: ['c1', 'c2'], reason: { why: 1 } } });
    expect(out.summary).toBe('a\nb');
    expect(out.issues).toEqual(['{"x":1}', 'y']);
    expect(out).not.toHaveProperty('confidence');
    expect(out.improvement).toMatchObject({ change: 'c1\nc2', reason: '{"why":1}' });
    expect(normalizeReviewOptionals({ confidence: '80%' }).confidence).toBe(0.8);
    warn.mockRestore();
  });

  it('accepts a review whose improvement is a string (run_3766cab8 shape)', async () => {
    const { result } = await run([{ verdict: 'accepted', summary: 'Good', issues: [], improvement: 'Use fewer tasks' }]);
    expect(result.status, result.error).toBe('succeeded');
  });

  it('retries the reviewer once with schema issues, then succeeds', async () => {
    const { result, reviewCalls } = await run([{ verdict: 'accepted' }, { verdict: 'accepted', summary: 'Fixed' }]);
    expect(result.status, result.error).toBe('succeeded');
    expect(reviewCalls()).toBe(2);
    expect(result.events.filter(item => item.type === 'review.repair_requested')).toHaveLength(1);
    expect(result.reviewRepair).toBeUndefined();
  });

  it('fails after the single reviewer retry is used', async () => {
    const { result, reviewCalls } = await run([{ verdict: 'accepted' }]);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('schema validation');
    expect(reviewCalls()).toBe(2);
  });
});
