import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, allocateModelCallTimeout, modelTimeoutReason } from '../src/runtime/engine.js';
import { HttpModelAdapter, ModelTimeout, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { pruneFailedFields } from '../src/runtime/finish-repair.js';
import { deriveProseInferences, similarListText } from '../src/runtime/sourceFidelityRules.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const onePlan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] };
async function drive(engine: AgentEngine, repository: InMemoryRunRepository, goal: string, materials?: Array<{ title: string; content: string; source: string }>, ticks = 8) {
  const run = await engine.create({ goal, ...(materials ? { materials } : {}) } as never);
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

// 1) chifeng: repair timeout wording and partial result for a no-source Run.
it('r62 chifeng: words every model timeout once ("Model response timed out after Xms")', () => {
  const reason = modelTimeoutReason('executor', new ModelTimeout('Model response timed out after 180000ms (overall timeout). Provider billing requires reconciliation.'));
  expect(reason).toBe('Model response timed out after 180000ms (executor call, overall timeout)');
});

it('r62 chifeng: repair fallback drops only the general-assumption sentences', () => {
  const pruned = pruneFailedFields({ type: 'finish', title: 't', content: '第一天前往赤峰。8月草原通常凉爽。第二天看草原。', evidenceRefs: [] },
    [{ path: 'content', code: 'general_assumption', message: 'content: unsourced general assumption is forbidden' }]) as { content: string };
  expect(pruned.content).toBe('第一天前往赤峰。第二天看草原。');
});

it('r62 chifeng (r78 update): a no-source general assumption is labelled "推断：" instead of starting a repair that can time out', async () => {
  const repository = new InMemoryRunRepository();
  let executorCalls = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: onePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    if (++executorCalls === 1) return { value: { type: 'finish', title: '赤峰攻略', content: '第一天前往赤峰。8月草原通常凉爽。第二天看草原。', evidenceRefs: [] } };
    throw new ModelTimeout('Model response timed out after 180000ms (overall timeout). Provider billing requires reconciliation.');
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, '规划赤峰 3 天行程');
  const types = run.events.map(item => item.type);
  expect(types).not.toContain('artifact.repair_requested');
  expect(executorCalls).toBe(1);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial ?? false).toBe(false);
  expect(run.artifacts[0]!.content).toContain('推断：8月草原通常凉爽');
  expect(run.artifacts[0]!.content).toContain('第二天看草原');
});

// 2) pdf2/csv/lt: a definite executor timeout with retained work still gets an independent review.
it('r62 pdf2: an executor timeout after earlier work runs one review of the partial output', async () => {
  const repository = new InMemoryRunRepository();
  const plan = { summary: 'Two steps', nodes: [{ id: 'a', title: 'A', instruction: 'A', dependsOn: [] }, { id: 'b', title: 'B', instruction: 'B', dependsOn: ['a'] }] };
  let reviewInput: any, executor = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: plan };
    if (isReviewer(request)) { reviewInput = request.input; return { value: { verdict: 'accepted', summary: 'partial but supported', issues: [] } }; }
    if (++executor > 1) throw new ModelTimeout('Model response timed out after 420000ms (overall timeout). Provider billing requires reconciliation.');
    return { value: { type: 'finish', title: 'A', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } } });
  const run = await drive(engine, repository, 'Summarize', [{ title: 'Notes', content: 'complete', source: 'upload' }]);
  const types = run.events.map(item => item.type);
  expect(types).toEqual(expect.arrayContaining(['run.partial', 'review.requested', 'review.completed']));
  expect(types.indexOf('review.requested')).toBeGreaterThan(types.indexOf('run.partial'));
  expect(reviewInput?.partial).toBe(true);
  expect(run.status).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.stopReview).toBe('done');
  const limitations = run.artifacts.flatMap(artifact => artifact.limitations ?? []).join('\n');
  expect(limitations).toContain('Model response timed out after');
  expect(limitations).not.toContain('Independent review was not completed');
  expect(run.events.find(item => item.type === 'run.partial')!.data.reason).not.toMatch(/call timed out: Model/);
});

it('r62 pdf2: a needs_revision verdict on stopped output stays succeeded(partial) and records the issues', async () => {
  const repository = new InMemoryRunRepository();
  const plan = { summary: 'Two steps', nodes: [{ id: 'a', title: 'A', instruction: 'A', dependsOn: [] }, { id: 'b', title: 'B', instruction: 'B', dependsOn: ['a'] }] };
  let executor = 0, reviews = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: plan };
    if (isReviewer(request)) { reviews++; return { value: { verdict: 'needs_revision', summary: 'incomplete', issues: ['step B missing'] } }; }
    if (++executor > 1) throw new ModelTimeout('Model response timed out after 420000ms (overall timeout).');
    return { value: { type: 'finish', title: 'A', content: 'The source says complete.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  } } });
  const run = await drive(engine, repository, 'Summarize', [{ title: 'Notes', content: 'complete', source: 'upload' }]);
  expect(reviews).toBe(1);
  expect(run.status).toBe('succeeded');
  expect(run.events.some(item => item.type === 'review.revision_requested')).toBe(false);
  expect(run.artifacts.flatMap(artifact => artifact.limitations ?? []).join('\n')).toContain('requested revision: incomplete; step B missing');
});

// 3) pdf2 420 s cap: the per-call share shrinks with the number of plan tasks still to run.
it('r62 pdf2: the executor call cap is the remaining pre-review budget split over pending tasks', () => {
  const budget = { runBudgetMs: 1_800_000, reviewReserveMs: 240_000, callMaxMs: 420_000, minCallMs: 60_000 };
  expect(allocateModelCallTimeout({ phase: 'executor', usedMs: 808_000, ...budget, pendingTasks: 1 })).toBe(420_000);
  expect(allocateModelCallTimeout({ phase: 'executor', usedMs: 808_000, ...budget, pendingTasks: 3 })).toBe(250_666);
  expect(allocateModelCallTimeout({ phase: 'executor', usedMs: 1_500_000, ...budget, pendingTasks: 4 })).toBe(60_000);
  expect(allocateModelCallTimeout({ phase: 'reviewer', usedMs: 1_500_000, ...budget, pendingTasks: 4 })).toBe(300_000);
});

// 4) txt: derived inferences must not duplicate risks or turn source gaps into risks.
it('r62 txt: restated prose inferences do not become duplicate risks, and source gaps go to unknowns', () => {
  const structured = { schemaVersion: 'project-pulse/1' as const, progress: [], completedChanges: [], blockers: [], risks: [] as Array<{ text: string; evidenceRefs: string[]; derived?: boolean }>, decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] as Array<{ text: string; evidenceRefs: string[] }> };
  const content = [
    '- 推断：10-20 的发布（launch）可能延期（may slip）；资料表述为可能性，并非确定延期，且 10-20 未注明年份。',
    '- 推断：10-20 的发布（launch）可能延期（may slip）。',
    '- 推断：支付 API key 预计何时可从供应商处获得，资料未说明。',
  ].join('\n');
  deriveProseInferences(content, structured as never, ['s']);
  expect(structured.risks.filter(risk => /延期/.test(risk.text) && /10-20/.test(risk.text))).toHaveLength(1);
  expect(structured.risks.some(risk => /资料未说明/.test(risk.text))).toBe(false);
  expect(structured.unknowns.map(item => item.text)).toEqual(['支付 API key 预计何时可从供应商处获得，资料未说明。']);
  expect(similarListText('推断：10-20 的发布可能延期。', '推断：10-20 的发布（launch）可能延期（may slip）。')).toBe(true);
  expect(similarListText('登录页已上线。', '支付 API key 待供应商提供。')).toBe(false);
});

// 5) 429: the real HTTP adapter inside the engine records model.rate_limit_retry and the Run still succeeds.
it('r62: an HTTP 429 from the provider is retried and written to the Run as model.rate_limit_retry', async () => {
  const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  let limitedOnce = false;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const system = body.messages[0]!.content;
    if (system.includes('Plan a real deliverable')) {
      if (!limitedOnce) { limitedOnce = true; return new Response('{"error":{"code":"RateLimitExceeded"}}', { status: 429, headers: { 'Retry-After': '0' } }); }
      return ok(onePlan);
    }
    if (system.includes('Independently review')) return ok({ verdict: 'accepted', summary: 'ok', issues: [] });
    const sourceId = /source_[0-9a-f-]{36}/.exec(body.messages.map(message => message.content).join('\n'))?.[0];
    return ok({ type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [sourceId] });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
  const model = new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 10_000, undefined, false, undefined,
    { maxAttempts: 1, retryBaseMs: 0, retryMaxMs: 10, rateLimitBaseMs: 1, rateLimitMaxMs: 5, rateLimitMaxAttempts: 3, stream: false });
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model });
  const run = await drive(engine, repository, 'Summarize', [{ title: 'Notes', content: 'complete', source: 'upload' }]);
  const retry = run.events.find(item => item.type === 'model.rate_limit_retry');
  expect(retry?.data).toMatchObject({ phase: 'planner', status: 429, attempt: 1, willRetry: true, decision: 'rate-limit-retry' });
  expect(run.events.some(item => item.type === 'model.rate_limit_exhausted')).toBe(false);
  expect(run.status, run.error).toBe('succeeded');
});
