import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, allocateModelCallTimeout, modelStopLimitation, modelTimeUsedMs } from '../src/runtime/engine.js';
import { HttpModelAdapter, ModelOutcomeUnknown, ModelRateLimited, ModelTimeout, type ModelRequest, type RateLimitDetails } from '../src/runtime/model.js';
import { normalizeArtifactLists } from '../src/runtime/artifact-lists.js';
import { deriveProseInferences } from '../src/runtime/sourceFidelityRules.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
const limited = (retryAfter?: string) => new Response('{"error":{"code":"RateLimitExceeded"}}', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
const adapter = (options = {}) => new HttpModelAdapter('https://ark.cn-beijing.volces.com/api/v3', 'ark-code-latest', '', undefined, 1000, undefined, false, undefined,
  { maxAttempts: 1, retryBaseMs: 0, retryMaxMs: 1000, rateLimitBaseMs: 2000, rateLimitMaxMs: 60000, rateLimitMaxAttempts: 4, ...options });

// Issue 1 (pdf3/pdf5): 429 must back off with its own bounded counter and be visible.
it('r48 pdf3: retries 429 independently of transport maxAttempts, honoring Retry-After, and reports each retry', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(Math, 'random').mockReturnValue(0.99999);
  const fetch = vi.fn().mockResolvedValueOnce(limited('30')).mockResolvedValueOnce(limited()).mockResolvedValueOnce(success());
  vi.stubGlobal('fetch', fetch);
  const seen: RateLimitDetails[] = [];
  const done = adapter().complete({ system: 's', input: {}, idempotencyKey: 'k', onRateLimited: details => { seen.push(details); } });
  await vi.advanceTimersByTimeAsync(29_999); expect(fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4_000); await expect(done).resolves.toMatchObject({ value: { ok: true } });
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(seen.map(item => [item.attempt, item.willRetry, item.decision, item.retryAfterMs])).toEqual([[1, true, 'rate-limit-retry', 30_000], [2, true, 'rate-limit-retry', null]]);
  expect(seen[0]!.delayMs).toBe(30_000);
  expect(seen[1]!.delayMs).toBeGreaterThanOrEqual(3_999);
});

it('r48 pdf5: persistent 429 stops after the rate-limit cap with a definite ModelRateLimited error and an exhausted event', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.fn(async () => limited()); vi.stubGlobal('fetch', fetch);
  const seen: RateLimitDetails[] = [];
  const done = expect(adapter().complete({ system: 's', input: {}, onRateLimited: details => { seen.push(details); } })).rejects.toSatisfy(error =>
    error instanceof ModelRateLimited && /persisted after 4 attempt/.test(error.message) && error.attempts === 4);
  await vi.runAllTimersAsync(); await done;
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(seen.map(item => item.willRetry)).toEqual([true, true, true, false]);
  expect(seen.at(-1)!.decision).toBe('rate-limit-exhausted');
  expect(vi.getTimerCount()).toBe(0);
});

it('r48: a Retry-After beyond the call budget fails at once with a recorded, definite rate-limit error', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => limited('900')));
  const seen: RateLimitDetails[] = [];
  await expect(adapter({ callBudgetMs: 600_000 }).complete({ system: 's', input: {}, onRateLimited: details => { seen.push(details); } })).rejects.toBeInstanceOf(ModelRateLimited);
  expect(seen).toMatchObject([{ willRetry: false, decision: 'retry-after-exceeds-budget', retryAfterMs: 900_000 }]);
});

it('r48: the engine writes rate-limit retry and exhaustion events into the Run', async () => {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) {
      await request.onRateLimited?.({ status: 429, attempt: 1, maxAttempts: 5, delayMs: 2000, retryAfterMs: null, willRetry: true, decision: 'rate-limit-retry' });
      return { value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] } };
    }
    await request.onRateLimited?.({ status: 429, attempt: 5, maxAttempts: 5, delayMs: 0, retryAfterMs: null, willRetry: false, decision: 'rate-limit-exhausted' });
    throw new ModelRateLimited('Model provider rate limit (HTTP 429) persisted after 5 attempt(s) with backoff', 5);
  } } });
  const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 3; i++) await engine.advance(run.id).catch(() => undefined);
  const finished = await repository.get(run.id);
  const types = finished.events.map(item => item.type);
  expect(types).toContain('model.rate_limit_retry');
  expect(types).toContain('model.rate_limit_exhausted');
  expect(finished.events.find(item => item.type === 'model.rate_limit_retry')!.data).toMatchObject({ phase: 'planner', attempt: 1, delayMs: 2000 });
  expect(finished.status).toBe('failed');
  expect(finished.error).toContain('persisted after 5 attempt');
});

// Issue 2 (chifeng): a timed-out repair call is a definite timeout, not an unknown outcome.
it('r48 chifeng: describes a model timeout as a timeout, never as an unknown outcome', () => {
  const timeout = modelStopLimitation('executor', new ModelTimeout('Model response timed out after 180000ms (overall timeout). Provider billing requires reconciliation.'));
  expect(timeout).toBe('Model response timed out after 180000ms (executor call, overall timeout). Independent review was not completed; provider billing still requires reconciliation.');
  expect(timeout).not.toMatch(/outcome is unknown/i);
  expect(modelStopLimitation('executor', new ModelOutcomeUnknown('Connection interrupted.'))).toContain('outcome is unknown');
});

// Issue 3 (json): runtime-derived clause entries ending in "；" were re-checked on repair and
// reported as "truncated list items", which the reviewer correctly rejected.
it('r48 json: derived prose entries are not counted as truncated list items', () => {
  const structured = { schemaVersion: 'project-pulse/1', risks: [
    { text: '推断：密钥到位时间未知，意味着支付集成的启动/完成时点不可控；', derived: true, evidenceRefs: ['s'] },
    { text: '推断：今天距发布还有 4 天。', evidenceRefs: ['s'] },
  ] };
  expect(normalizeArtifactLists(structured as Record<string, unknown>)).toEqual({ duplicates: 0, truncated: 0 });
  expect(structured.risks).toHaveLength(2);
  // A genuinely cut-off model item is still dropped.
  const cut = { risks: [{ text: 'Launch is at risk because', evidenceRefs: ['s'] }] };
  expect(normalizeArtifactLists(cut).truncated).toBe(1);
});

it('r48 json: derived risks end as complete sentences and stay stable across a repair pass', () => {
  const structured = { schemaVersion: 'project-pulse/1' as const, progress: [], completedChanges: [], blockers: [], risks: [] as Array<{ text: string; evidenceRefs: string[]; derived?: boolean }>, decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };
  const content = '- 推断：密钥到位时间未知，意味着支付集成的启动/完成时点不可控；集成支付与负载测试仍需在发布前完成。';
  expect(deriveProseInferences(content, structured as never, ['s']).derived).toBe(1);
  expect(structured.risks[0]!.text).toBe('推断：密钥到位时间未知，意味着支付集成的启动/完成时点不可控。');
  expect(deriveProseInferences(content, structured as never, ['s']).derived).toBe(0);
  expect(normalizeArtifactLists(structured as unknown as Record<string, unknown>).truncated).toBe(0);
});

// Issue 4 (pdf2/csv/lt): one call may not consume the whole budget; review keeps a reserve.
it('r48 pdf2/csv/lt: allocates run model time with a per-call cap and a review reserve', () => {
  const budget = { runBudgetMs: 1_800_000, reviewReserveMs: 240_000, callMaxMs: 420_000, minCallMs: 60_000 };
  expect(allocateModelCallTimeout({ phase: 'planner', usedMs: 0, ...budget })).toBe(420_000);
  expect(allocateModelCallTimeout({ phase: 'executor', usedMs: 1_400_000, ...budget })).toBe(160_000);
  expect(allocateModelCallTimeout({ phase: 'executor', usedMs: 1_790_000, ...budget })).toBe(60_000);
  expect(allocateModelCallTimeout({ phase: 'reviewer', usedMs: 1_790_000, ...budget })).toBe(240_000);
  expect(allocateModelCallTimeout({ phase: 'reviewer', usedMs: 0, ...budget })).toBe(420_000);
  expect(allocateModelCallTimeout({ phase: 'executor', usedMs: 0, ...budget, requestedMs: 180_000 })).toBe(180_000);
  const t = Date.parse('2026-10-16T00:00:00Z');
  expect(modelTimeUsedMs({ calls: [
    { startedAt: new Date(t).toISOString(), endedAt: new Date(t + 5_000).toISOString() },
    { startedAt: new Date(t + 60_000).toISOString() },
  ] } as never, t + 70_000)).toBe(15_000);
});

it('r48: the engine passes the allocated timeout to every new planner, executor and reviewer call', async () => {
  vi.stubEnv('AEEIS_MODEL_CALL_MAX_MS', '300000'); vi.stubEnv('AEEIS_REVIEW_RESERVE_MS', '200000');
  const timeouts: Array<[string, number | undefined]> = [];
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) { timeouts.push(['planner', request.timeoutMs]); return { value: { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] } }; }
    if (request.system.includes('Independently review')) { timeouts.push(['reviewer', request.timeoutMs]); return { value: { verdict: 'accepted', summary: 'ok', issues: [] } }; }
    timeouts.push(['executor', request.timeoutMs]);
    return { value: { type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } } });
  const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 4; i++) await engine.advance(run.id).catch(() => undefined);
  expect(timeouts.map(([phase]) => phase)).toEqual(expect.arrayContaining(['planner', 'executor', 'reviewer']));
  for (const [, timeout] of timeouts) { expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(300_000); }
});
