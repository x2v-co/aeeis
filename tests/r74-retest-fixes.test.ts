import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, event, modelStopLimitation, modelTimeoutReason } from '../src/runtime/engine.js';
import { HttpModelAdapter, ModelTimeout, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { dedupeDerivedRisks, similarListText } from '../src/runtime/sourceFidelityRules.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const onePlan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] };
async function drive(engine: AgentEngine, repository: InMemoryRunRepository, input: Record<string, unknown>, ticks = 10) {
  const run = await engine.create(input as never);
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
const quiet = () => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); };
const hanging = (init: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
const sse = (frames: string[], hangAfter = false) => (init: { signal?: AbortSignal }) => {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (hangAfter) timer = setInterval(() => { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { clearInterval(timer); } }, 20);
      else controller.close();
      init.signal?.addEventListener('abort', () => { clearInterval(timer); try { controller.error(init.signal!.reason); } catch { /* closed */ } }, { once: true });
    },
    cancel() { clearInterval(timer); },
  });
  return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
};
const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
const done = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;

// 1) pdf1/txt: retries share the per-call timeoutMs as one total budget (no leftover 600 s cap).
it('r74 pdf1: transport retries stay inside the per-call timeoutMs budget', async () => {
  quiet();
  const fetchMock = vi.fn((_url: string, init: { signal?: AbortSignal }) => hanging(init));
  vi.stubGlobal('fetch', fetchMock);
  const model = new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 10_000, undefined, false, undefined,
    { maxAttempts: 5, retryBaseMs: 0, retryMaxMs: 0, stream: false, firstByteTimeoutMs: 120, callBudgetMs: 600_000 });
  const started = Date.now();
  const error = await model.complete({ system: 's', input: {}, timeoutMs: 300, idempotencyKey: 'k' }).catch(e => e);
  const elapsed = Date.now() - started;
  expect(error).toBeInstanceOf(ModelTimeout);
  expect(String(error.message)).toMatch(/^Model response timed out after \d+ms/);
  expect(elapsed).toBeLessThan(450);
  expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
});

// 6) stall: keep-alive frames are not progress; the attempt aborts as a stall and retries within budget.
it('r74 stall: an SSE stream with no new content for stallTimeoutMs aborts as a stall timeout', async () => {
  quiet();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => sse([delta('{"a"')], true)(init)));
  const model = new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 10_000, undefined, false, undefined,
    { maxAttempts: 1, stream: true, firstByteTimeoutMs: 5_000, idleTimeoutMs: 5_000, stallTimeoutMs: 150, midstreamRetries: 0 });
  const started = Date.now();
  const error = await model.complete({ system: 's', input: {}, timeoutMs: 5_000 }).catch(e => e);
  expect(error).toBeInstanceOf(ModelTimeout);
  expect(String(error.message)).toContain('stall timeout');
  expect(Date.now() - started).toBeLessThan(1_500);
});

it('r74 stall: a stalled attempt is retried once within the call budget and can still succeed', async () => {
  quiet();
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal?: AbortSignal }) => ++calls === 1 ? sse([delta('{"a"')], true)(init) : sse([delta('{"ok":true}'), done])(init)));
  const model = new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 10_000, undefined, false, undefined,
    { maxAttempts: 1, stream: true, firstByteTimeoutMs: 500, idleTimeoutMs: 5_000, stallTimeoutMs: 150, midstreamRetries: 1 });
  const result = await model.complete({ system: 's', input: {}, timeoutMs: 5_000, idempotencyKey: 'k' });
  expect(result.value).toEqual({ ok: true });
  expect(calls).toBe(2);
});

// 2) chifeng/json: a first executor timeout with nothing retained is retried once, then ends partial (never run.failed).
it('r74 json: a first executor timeout with no output retries once and can still succeed', async () => {
  const repository = new InMemoryRunRepository();
  let executor = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: onePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    if (++executor === 1) throw new ModelTimeout('Model response timed out after 420000ms (overall timeout). Provider billing requires reconciliation.');
    return { value: { type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  const types = run.events.map(item => item.type);
  expect(types).toContain('model.timeout_retry');
  expect(types).not.toContain('run.failed');
  expect(executor).toBe(2);
  expect(run.status, run.error).toBe('succeeded');
});

it('r74 chifeng: two executor timeouts with no output end succeeded(partial) with an explicit unknowns note', async () => {
  const repository = new InMemoryRunRepository();
  let executor = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: onePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    executor++;
    throw new ModelTimeout('Model response timed out after 306595ms (overall timeout). Provider billing requires reconciliation.');
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: '规划赤峰 3 天行程' });
  const types = run.events.map(item => item.type);
  expect(executor).toBe(2);
  expect(types).not.toContain('run.failed');
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.artifacts[0]!.content).toContain('Unknown:');
  const limitations = run.artifacts.flatMap(artifact => artifact.limitations ?? []).join('\n');
  expect(limitations).toContain('Model response timed out after 306595ms (executor call, overall timeout)');
  expect(limitations).not.toMatch(/call timed out: Model/);
});

// 3) csv: no review.requested without a terminal review event.
it('r74 csv: when the call budget is exhausted the review is skipped, not left dangling', async () => {
  const repository = new InMemoryRunRepository();
  let reviews = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: { summary: 'Two', nodes: [{ id: 'a', title: 'A', instruction: 'A', dependsOn: [] }, { id: 'b', title: 'B', instruction: 'B', dependsOn: ['a'] }] } };
    if (isReviewer(request)) { reviews++; return { value: { verdict: 'accepted', summary: 'ok', issues: [] } }; }
    return { value: { type: 'finish', title: 'X', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: 'Summarize', maxModelCalls: 3, materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  const types = run.events.map(item => item.type);
  expect(reviews).toBe(0);
  const requested = types.lastIndexOf('review.requested');
  if (requested >= 0) expect(types.slice(requested + 1).some(type => ['review.completed', 'review.skipped', 'review.cancelled'].includes(type))).toBe(true);
  expect(types).toContain('review.skipped');
  expect(run.status).toBe('succeeded');
});

it('r74 csv: a terminal run event closes any open review.requested with review.skipped', () => {
  const run = { events: [] as Array<{ type: string; data: Record<string, unknown> }> } as never as Parameters<typeof event>[0];
  event(run, 'review.requested');
  event(run, 'run.partial', { reason: 'Model call budget exhausted' });
  expect(run.events.map(item => item.type)).toEqual(['review.requested', 'review.skipped', 'run.partial']);
  event(run, 'run.failed', { reason: 'x' });
  expect(run.events.filter(item => item.type === 'review.skipped')).toHaveLength(1);
});

// 4) wording.
it('r74 chifeng: timeout wording is a single "Model response timed out after Xms" phrase', () => {
  const error = new ModelTimeout('Model response timed out after 306595ms (overall timeout). Provider billing requires reconciliation.');
  expect(modelTimeoutReason('executor', error)).toBe('Model response timed out after 306595ms (executor call, overall timeout)');
  expect(modelStopLimitation('executor', error)).not.toMatch(/call timed out: Model|Model response timed out.*Model response timed out/);
  expect(modelTimeoutReason('executor', new ModelTimeout('Model response timed out after 180000ms'))).toBe('Model response timed out after 180000ms (executor call)');
});

// 5) txt: near-duplicate derived risks, one joined with another inference and missing its subject.
it('r74 txt: near-duplicate "10-20 may slip" risks collapse to one, keeping the full sentence', () => {
  const a = '推断：的发布可能延期（launch 10-20 may slip）。推断：可能与支付 API 密钥阻塞有关，但资料未明确陈述该因果关系。';
  const b = '推断：风险：原定 10-20 的发布可能延期（launch 10-20 may slip）。';
  expect(similarListText(a, b)).toBe(true);
  expect(similarListText('登录页已上线。', '支付 API key 待供应商提供。')).toBe(false);
  const risks = [{ text: a, derived: true }, { text: b, derived: true }, { text: '推断：负载测试尚未开始。', derived: true }];
  dedupeDerivedRisks(risks);
  const slips = risks.filter(risk => /may slip/.test(risk.text));
  expect(slips).toHaveLength(1);
  expect(slips[0]!.text).toContain('原定 10-20 的发布可能延期');
  expect(risks.some(risk => /^推断：的发布/.test(risk.text))).toBe(false);
  expect(risks.some(risk => /支付 API 密钥阻塞/.test(risk.text))).toBe(true);
  expect(risks).toHaveLength(2);
});
