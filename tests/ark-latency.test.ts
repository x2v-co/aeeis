import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { HttpModelAdapter, modelTransportConfig, type ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
const plan = { summary: 'Inspect', nodes: [{ id: 'inspect', title: 'Inspect', instruction: 'Use bounded readers', dependsOn: [] }] };
const jsonReply = (value: unknown, reason = 'stop') => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: reason }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
const httpModel = (env: NodeJS.ProcessEnv = {}) => new HttpModelAdapter('https://provider.example/v1', 'fixture', '', undefined, 180_000, undefined, false, undefined, { ...modelTransportConfig(env), retryBaseMs: 0 });

it('allows a streaming Run with several three-minute calls to continue beyond 600s total', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'info').mockImplementation(() => {});
  const repository = new InMemoryRunRepository();
  const fetch = vi.fn(async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const value = !input.task ? input.artifacts ? { verdict: 'accepted', summary: 'Verified', issues: [] } : plan
      : !input.observations.length ? { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0].id }
      : { type: 'finish', title: 'Done', content: 'Evidence verified', evidenceRefs: [input.sourceCatalog[0].id] };
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
      const interval = setInterval(() => c.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 60_000);
      setTimeout(() => {
        clearInterval(interval);
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`));
        c.close();
      }, 180_000);
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', fetch);
  const engine = new AgentEngine(repository, httpModel({ AEEIS_MODEL_STREAM: '1' }));
  const run = await engine.create({ goal: 'Inspect', materials: [{ title: 'brief.txt', content: 'Release evidence', source: 'upload' }] });
  const started = Date.now();
  const planning = engine.advance(run.id); await vi.advanceTimersByTimeAsync(180_001); expect(await planning).toBe('needs_approval');
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
  for (const status of ['running', 'running', 'reviewing', 'succeeded']) {
    const advance = engine.advance(run.id); await vi.advanceTimersByTimeAsync(status === 'reviewing' ? 0 : 180_001); expect(await advance).toBe(status);
  }
  expect(Date.now() - started).toBeGreaterThan(600_000); expect(fetch).toHaveBeenCalledTimes(4);
});

it('freezes thinking, effort and tokens so reconciliation after an env change sends the identical body/key', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {});
  const repository = new InMemoryRunRepository();
  const original = httpModel({ AEEIS_MODEL_FIRST_BYTE_TIMEOUT_MS: '100', AEEIS_MODEL_MAX_ATTEMPTS: '1', AEEIS_MODEL_MAX_TOKENS: '6000', AEEIS_MODEL_THINKING: 'enabled', AEEIS_MODEL_REASONING_EFFORT: 'low' });
  const fetch = vi.fn().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })))
    .mockResolvedValueOnce(jsonReply(plan)).mockResolvedValueOnce(jsonReply({ type: 'finish', title: 'Done', content: 'Done', evidenceRefs: [] }));
  vi.stubGlobal('fetch', fetch);
  const engine = new AgentEngine(repository, original), run = await engine.create({ goal: 'Inspect' });
  const advance = engine.advance(run.id);
  await vi.advanceTimersByTimeAsync(101);
  expect(await advance).toBe('unknown');
  const call = (await repository.get(run.id)).calls[0]!;
  expect(call.modelRequest).toMatchObject({ maxTokens: 4096, thinking: 'enabled', reasoningEffort: 'low' });
  expect(call.inputHash).toBe(digest(call.modelRequest));
  const restarted = new AgentEngine(repository, httpModel({ AEEIS_MODEL_MAX_TOKENS: '9000', AEEIS_MODEL_THINKING: 'disabled', AEEIS_MODEL_REASONING_EFFORT: 'high' }));
  await restarted.command(run.id, 'reconcile', { reason: 'Provider checked, same-request retry authorized' });
  expect(await restarted.advance(run.id)).toBe('needs_approval');
  expect(fetch.mock.calls[1]![1].body).toBe(fetch.mock.calls[0]![1].body);
  expect(fetch.mock.calls[1]![1].headers['idempotency-key']).toBe(fetch.mock.calls[0]![1].headers['idempotency-key']);
  await restarted.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
  expect(await restarted.advance(run.id)).toBe('running');
  expect(JSON.parse(fetch.mock.calls[2]![1].body)).toMatchObject({ max_tokens: 9000, thinking: { type: 'disabled' }, reasoning_effort: 'high' });
});

it.each(['saved request', 'legacy hash'])('preserves omitted provider controls and legacy tokens for a pre-upgrade %s', async format => {
  const repository = new InMemoryRunRepository();
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError('disconnected')).mockResolvedValueOnce(jsonReply(plan));
  vi.stubGlobal('fetch', fetch); vi.spyOn(console, 'error').mockImplementation(() => {});
  const model = httpModel({ AEEIS_MODEL_MAX_ATTEMPTS: '1' }), engine = new AgentEngine(repository, model);
  const run = await engine.create({ goal: 'Inspect' });
  expect(await engine.advance(run.id)).toBe('unknown');
  await repository.mutate(run.id, current => {
    const call = current.calls[0]!;
    delete call.modelRequest!.thinking; delete call.modelRequest!.reasoningEffort; delete call.modelRequest!.maxTokens;
    if (format === 'legacy hash') call.modelRequest!.system = call.modelRequest!.system.replace(/\nPlan a small number of useful tasks[^\n]+/, '');
    if (format === 'legacy hash') delete (call.modelRequest!.input as Record<string, unknown>).clock; // legacy requests predate clock injection
    call.inputHash = digest(call.modelRequest);
    if (format === 'legacy hash') delete call.modelRequest;
  });
  const restarted = new AgentEngine(repository, httpModel({ AEEIS_MODEL_MAX_TOKENS: '2000', AEEIS_MODEL_THINKING: 'enabled', AEEIS_MODEL_REASONING_EFFORT: 'high' }));
  await restarted.command(run.id, 'reconcile', { reason: 'Provider checked' });
  expect(await restarted.advance(run.id)).toBe('needs_approval');
  const body = JSON.parse(fetch.mock.calls[1]![1].body);
  expect(body.max_tokens).toBe(16384);
  expect(body).not.toHaveProperty('thinking'); expect(body).not.toHaveProperty('reasoning_effort');
  if (format === 'legacy hash') expect(body.messages[0].content).not.toContain('Plan a small number');
});

it('starts planner length retries at 4096 and respects a smaller env ceiling', async () => {
  const repository = new InMemoryRunRepository();
  const fetch = vi.fn().mockResolvedValueOnce(jsonReply({}, 'length')).mockResolvedValueOnce(jsonReply(plan))
    .mockResolvedValueOnce(jsonReply(plan)); vi.stubGlobal('fetch', fetch);
  const engine = new AgentEngine(repository, httpModel()), run = await engine.create({ goal: 'Inspect' });
  expect(await engine.advance(run.id)).toBe('needs_approval');
  const smaller = new AgentEngine(repository, httpModel({ AEEIS_MODEL_MAX_TOKENS: '2000' })), small = await smaller.create({ goal: 'Inspect' });
  expect(await smaller.advance(small.id)).toBe('needs_approval');
  expect(fetch.mock.calls.map(([, options]) => JSON.parse(options.body).max_tokens)).toEqual([4096, 8192, 2000]);
});

it.each(['csv', 'md', 'json'] as const)('plans from bounded %s summaries without the full source', async format => {
  const csv = readFileSync(new URL('./fixtures/project-pulse-large.csv', import.meta.url), 'utf8').trimEnd();
  const content = format === 'csv' ? csv : format === 'md' ? '# Overview\n' + 'PRIVATE_ROW_DETAIL '.repeat(1000)
    : JSON.stringify({ tasks: Array.from({ length: 200 }, (_, i) => ({ id: i, detail: 'PRIVATE_ROW_DETAIL' })) });
  const requests: ModelRequest[] = [], repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'fixture/1' }, complete: async request => { requests.push(request); return { value: plan }; } });
  const run = await engine.create({ goal: 'Inspect', materials: [{ title: `tasks.${format}`, content, source: 'upload' }] });
  expect(await engine.advance(run.id)).toBe('needs_approval');
  const request = requests[0]!;
  expect(request.system).toContain('sources.csvQuery'); expect(request.system).toContain('bounded readers');
  expect(request.system.length + JSON.stringify(request.input).length).toBeLessThan(7000);
  const input = JSON.stringify(request.input);
  expect(input).not.toContain(content);
  if (format === 'csv') expect(input).toContain('csv-summary/1');
  else expect(input).not.toContain('PRIVATE_ROW_DETAIL');
});
