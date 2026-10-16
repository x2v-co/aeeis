import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { HttpModelAdapter, type ModelRequest } from '../src/runtime/model.js';

afterEach(() => vi.unstubAllGlobals());

it('run_d0d2ca25: retains plain-text inference notes and omits citations to source-free dependencies without repair', async () => {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Family itinerary', nodes: [
      { id: 'constraints', title: 'Constraints', instruction: 'State assumptions', dependsOn: [] },
      { id: 'itinerary', title: 'Itinerary', instruction: 'Propose itinerary', dependsOn: ['constraints'] },
    ] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Unverified assumptions disclosed' } };
    if (input.finishRepair) throw new Error('Unexpected repair');
    const ref = input.dependencies[0]?.id;
    return { value: { type: 'finish', title: 'Itinerary', content: ref ? `Tentative itinerary [${ref}]` : 'Departure city is unspecified.', evidenceRefs: ref ? [ref] : [],
      ...(ref ? { structured: { inferences: [{ field: 'route', text: 'This is a tentative route; travel times require confirmation.', evidenceRefs: [ref] }] } } : {}) } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const run = await engine.create({ goal: 'Plan a family itinerary' });
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 7; i++) await engine.advance(run.id);
  const finished = await repository.get(run.id);
  expect(finished.status, finished.error).toBe('succeeded');
  expect(complete).toHaveBeenCalledTimes(4);
  expect(finished.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
  expect(finished.artifacts[1]?.content).toContain('tentative route');
  expect(finished.artifacts[1]?.content).not.toContain('artifact_');
  expect(finished.artifacts[1]?.structured).toBeUndefined();
  expect(finished.artifacts[1]?.evidenceRefs).toEqual([]);
  expect(finished.artifacts[1]?.limitations?.join(' ')).toContain('no source evidence');
});

it('counts decoded completion bytes rather than SSE envelopes against the repair cap', async () => {
  const value = { content: '中'.repeat(1000) };
  const frames = [...JSON.stringify(value)].map(content => `data: ${JSON.stringify({ id: 'envelope'.repeat(20), choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  frames.push('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  expect(Buffer.byteLength(frames.join(''))).toBeGreaterThan(65536);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } })));
  const model = new HttpModelAdapter('https://provider.example/v1', 'fixture', '', undefined, 1000, undefined, false, undefined, { stream: true });
  await expect(model.complete({ system: 'repair', input: {}, maxResponseBytes: 65536, disableRetries: true })).resolves.toMatchObject({ value });
});

it.each([false, true])('rejects oversized decoded completion with an accurate reason (stream=%s)', async stream => {
  const content = JSON.stringify({ content: 'x'.repeat(70000) });
  const body = stream ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    : JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } })));
  const model = new HttpModelAdapter('https://provider.example/v1', 'fixture', '', undefined, 1000, undefined, false, undefined, { stream });
  await expect(model.complete({ system: 'repair', input: {}, maxResponseBytes: 65536, disableRetries: true })).rejects.toThrow('Model completion exceeds byte cap');
});
