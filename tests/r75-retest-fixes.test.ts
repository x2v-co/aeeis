import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, degradeExhaustedRepair } from '../src/runtime/engine.js';
import { HttpModelAdapter, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { pruneFailedFields } from '../src/runtime/finish-repair.js';
import { deriveProseInferences, inferenceFidelityProblems, labelInferences } from '../src/runtime/sourceFidelityRules.js';
import type { AgentRun, ProjectPulseArtifact } from '../src/runtime/contracts.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const threePlan = { summary: '赤峰行程', nodes: [
  { id: 'trip_positioning', title: '行程定位', instruction: '定位', dependsOn: [] },
  { id: 'route_and_schedule', title: '路线与日程', instruction: '路线', dependsOn: ['trip_positioning'] },
  { id: 'family_friendly_activities', title: '亲子活动', instruction: '活动', dependsOn: ['route_and_schedule'] },
] };
const onePlan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Report', dependsOn: [] }] };
async function drive(engine: AgentEngine, repository: InMemoryRunRepository, input: Record<string, unknown>, ticks = 14) {
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
const quiet = () => {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'error').mockImplementation(capture); vi.spyOn(console, 'info').mockImplementation(capture); vi.spyOn(console, 'warn').mockImplementation(capture);
  return lines;
};
const pulse = (overrides: Partial<ProjectPulseArtifact> = {}): ProjectPulseArtifact => ({ schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], ...overrides } as ProjectPulseArtifact);

// 1) chifeng: repair exhausted after two tasks produced output -> succeeded(partial) with Unknown + remaining problems.
it('r75 chifeng: repair exhausted after earlier task output degrades to succeeded(partial), never run.failed', async () => {
  quiet();
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: threePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    const task = (request.input as { task: { id: string } }).task.id;
    if (task !== 'family_friendly_activities') return { value: { type: 'finish', title: task, content: `推断：${task} 以轻松为主。`, evidenceRefs: [] } };
    // Always cites evidence the task never received; the repair does not fix it.
    return { value: { type: 'finish', title: '亲子活动', content: '活动清单 [source_missing]', evidenceRefs: ['source_missing'] } };
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: '规划赤峰 3 天亲子自驾' });
  const types = run.events.map(item => item.type);
  expect(types).not.toContain('run.failed');
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.artifacts.map(artifact => artifact.taskId)).toEqual(['trip_positioning', 'route_and_schedule', 'family_friendly_activities']);
  const last = run.artifacts.at(-1)!;
  expect(last.content).toContain('Unknown:');
  expect(last.content).toContain('Remaining problems:');
  expect(last.content).not.toContain('活动清单');
  expect(run.events.find(item => item.type === 'run.partial')?.data).toMatchObject({ repairExhausted: true, taskId: 'family_friendly_activities' });
});

it('r75 chifeng: without earlier output a repair failure still fails the Run', async () => {
  quiet();
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: onePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    return { value: { type: 'finish', title: 'R', content: 'x [source_missing]', evidenceRefs: ['source_missing'] } };
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: 'Plan' });
  expect(run.status).toBe('failed');
});

// 2) chifeng: no source catalog — labelled assumptions are allowed; structured without artifactType is dropped.
it('r75 chifeng: a sourceless plain-text task with labelled assumptions and stray structured succeeds without repair', async () => {
  quiet();
  const repository = new InMemoryRunRepository();
  let executor = 0;
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: onePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    executor++;
    return { value: { type: 'finish', title: '活动', content: '# 活动清单\n\n推断：草原景区通常在 8 月开放骑马体验，出行前需核实。', evidenceRefs: [], structured: { activities: ['草原漫步'] } } };
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: '规划赤峰亲子活动' });
  const types = run.events.map(item => item.type);
  expect(run.status, run.error).toBe('succeeded');
  expect(executor).toBe(1);
  expect(types).not.toContain('artifact.repair_requested');
  expect(types).toContain('artifact.structured_dropped');
  expect(run.artifacts[0]!.structured).toBeUndefined();
});

it('r75 chifeng: general assumption rule — labelled allowed only when sourceless; unlabelled still flagged', () => {
  const text = '推断：草原景区通常在 8 月开放。';
  expect(inferenceFidelityProblems(text, undefined, () => '', [], { sourceless: true })).toEqual([]);
  expect(inferenceFidelityProblems(text, undefined, () => '', [])).toEqual(['content: unsourced general assumption is forbidden']);
  expect(inferenceFidelityProblems('草原景区通常在 8 月开放。', undefined, () => '', [], { sourceless: true })).toContain('content: unsourced general assumption is forbidden');
});

it('r75 chifeng: the repair fallback drops structured without artifactType', () => {
  const pruned = pruneFailedFields({ type: 'finish', title: 't', content: 'c', evidenceRefs: [], structured: { a: 1 } }, [{ path: 'structured', code: 'artifact_contract', message: 'finish.structured requires a recognized artifactType' }]) as Record<string, unknown>;
  expect(pruned.structured).toBeUndefined();
  expect(pruned.content).toBe('c');
});

// 1) pdf2: output recovery exhausted after a PDF was written -> unverified partial, country marked Unknown.
it('r75 pdf2: recovery exhausted keeps the written PDF as an unverified partial with Unknown: country', () => {
  const output = { ref: 'pdfout_1', filename: 'filled-form.pdf', sha256: 'a'.repeat(64), sizeBytes: 10, sourceRef: 'source_pdf', createdAt: new Date().toISOString() };
  const run = {
    id: 'run_1', status: 'running', events: [], artifacts: [], context: { id: 'ctx', sources: [] },
    plans: [{ nodes: [{ id: 'fill', title: 'Fill form', instruction: 'Fill', dependsOn: [] }] }],
    steps: [{ taskId: 'fill', status: 'running', observations: [], outputRecovery: { reason: 'x', candidate: {}, toolsAllowed: false, callOffset: 0, problems: [] } }],
    pdfOutputs: [output],
    toolReceipts: [{ receiptId: 'receipt_1', operation: 'pdf.fill', status: 'completed', outputRefs: ['pdfout_1'], authorization: { decision: 'authorized', taskId: 'fill' } }],
  } as unknown as AgentRun;
  const problems = [{ path: 'structured.filledFields.2.evidenceRefs', code: 'fillable_pdf:structured.filledFields.2.evidenceRefs', message: 'Filled field must cite received source evidence: country' }];
  expect(degradeExhaustedRepair(run, 'fill', 'call_1', 'Output recovery retries exhausted: Filled field must cite received source evidence: country; no valid artifact candidate remains.', problems)).toBe(true);
  expect(run.status).toBe('succeeded');
  expect(run.partial).toBe(true);
  const artifact = run.artifacts[0]!;
  expect(artifact.content).toContain('Unknown: country');
  expect(artifact.content).toContain('Unverified PDF draft retained: filled-form.pdf [pdfout_1]');
  expect(artifact.content).toContain('Filled field must cite received source evidence: country');
  expect(artifact.retainedPdfOutput).toMatchObject({ ref: 'pdfout_1', sourceRef: 'source_pdf' });
  expect(run.events.map(item => item.type)).toEqual(expect.arrayContaining(['artifact.created', 'run.partial']));
});

// 3) csv: auto-labelling must not swallow a leading quantity.
it('r75 csv: inference labelling keeps leading numbers ("48/60（80%）", "11 条")', () => {
  const structured = pulse({ risks: [
    { text: '48/60（80%）任务的 due 早于 2026-10-17，可能影响交付可预测性。', evidenceRefs: ['s'] },
    { text: '11 条 blocked 任务已逾期，可能是最高优先级风险。', evidenceRefs: ['s'] },
  ] } as never);
  labelInferences({ content: '' }, structured, () => 'raw csv rows', ['s']);
  expect(structured.risks.map(risk => risk.text)).toEqual([
    '推断：48/60（80%）任务的 due 早于 2026-10-17，可能影响交付可预测性。',
    '推断：11 条 blocked 任务已逾期，可能是最高优先级风险。',
  ]);
  const derived = pulse();
  deriveProseInferences('- 推断：48/60（80%）任务已逾期。\n1. 推断：11 条 blocked 任务可能延误发布。', derived, ['s']);
  expect(derived.risks.map(risk => risk.text)).toEqual(['推断：48/60（80%）任务已逾期。', '推断：11 条 blocked 任务可能延误发布。']);
});

// 4) txt: no vacuous "no further inference" risk.
it('r75 txt: "除上述明确表述外未作额外推断" never becomes a risk', () => {
  const structured = pulse({ risks: [{ text: '推断：未作其他推断。', evidenceRefs: ['s'], derived: true }] } as never);
  deriveProseInferences('推断：计划于 10-20 的发布可能延期。\n推断：除上述明确表述外未作额外推断。', structured, ['s']);
  expect(structured.risks.map(risk => risk.text)).toEqual(['推断：计划于 10-20 的发布可能延期。']);
});

// 5) Injected slow / stalled provider through the real HTTP adapter and engine.
const sseResponse = (content: string, init: { signal?: AbortSignal }, hang = false) => {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`));
      if (hang) timer = setInterval(() => { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { clearInterval(timer); } }, 20);
      else { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`)); controller.close(); }
      init.signal?.addEventListener('abort', () => { clearInterval(timer); try { controller.error(init.signal!.reason); } catch { /* closed */ } }, { once: true });
    },
    cancel() { clearInterval(timer); },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const hangingFetch = (init: { signal?: AbortSignal }) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
type Behaviour = 'ok' | 'stall' | 'slow';
function providerFixture(executorBehaviour: Behaviour[]) {
  let executor = 0;
  return vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body), system = String(body.messages[0].content), input = JSON.parse(body.messages[1].content);
    if (system.includes('Plan a real deliverable')) return sseResponse(JSON.stringify(onePlan), init);
    if (system.includes('Independently review')) return sseResponse(JSON.stringify({ verdict: 'accepted', summary: 'ok', issues: [] }), init);
    const behaviour = executorBehaviour[executor++] ?? 'ok';
    if (behaviour === 'slow') return hangingFetch(init);
    const finish = JSON.stringify({ type: 'finish', title: 'Report', content: 'The source says complete.', evidenceRefs: [input.sourceCatalog[0].id] });
    return behaviour === 'stall' ? sseResponse(finish.slice(0, 20), init, true) : sseResponse(finish, init);
  });
}
const adapter = () => new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 10_000, undefined, false, undefined,
  { maxAttempts: 1, stream: true, firstByteTimeoutMs: 150, idleTimeoutMs: 5_000, stallTimeoutMs: 150, midstreamRetries: 0, callBudgetMs: 2_000 });
const errorLogs = (lines: string[]) => lines.filter(line => line.includes('aeeis-model-error/1')).map(line => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);

it('r75 stall injection: a stalled executor stream logs timeoutKind=stall, emits model.timeout_retry and recovers', async () => {
  const lines = quiet();
  vi.stubGlobal('fetch', providerFixture(['stall', 'ok']));
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: adapter() });
  const run = await drive(engine, repository, { goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  const types = run.events.map(item => item.type);
  expect(errorLogs(lines).some(log => log.timeoutKind === 'stall')).toBe(true);
  expect(types).toContain('model.timeout_retry');
  expect(types).not.toContain('run.failed');
  expect(run.status, run.error).toBe('succeeded');
});

it('r75 slow injection: no first byte logs timeoutKind=first-byte; two timeouts end succeeded(partial) with Unknown', async () => {
  const lines = quiet();
  vi.stubGlobal('fetch', providerFixture(['slow', 'slow']));
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: adapter() });
  const run = await drive(engine, repository, { goal: 'Summarize', materials: [{ title: 'Notes', content: 'complete', source: 'upload' }] });
  const types = run.events.map(item => item.type);
  expect(errorLogs(lines).filter(log => log.timeoutKind === 'first-byte').length).toBeGreaterThanOrEqual(2);
  expect(types).toContain('model.timeout_retry');
  expect(types).not.toContain('run.failed');
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.artifacts[0]!.content).toContain('Unknown:');
});

it('r75 repair_fallback: a repair that answers without fixing keeps the pruned artifact and emits artifact.repair_fallback', async () => {
  quiet();
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
    if (isPlanner(request)) return { value: onePlan };
    if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    const ref = (request.input as any).sourceCatalog[0].id as string;
    return { value: { type: 'finish', title: 'Pulse', content: 'Release blocked [' + ref + ']', evidenceRefs: [ref], artifactType: 'project-pulse/1',
      structured: pulse({ blockers: [{ text: 'Release blocked by migration.', evidenceRefs: [ref] }], risks: [{ text: '负载测试通常在集成之后。', evidenceRefs: [ref] }] } as never) } };
  } } satisfies ModelAdapter });
  const run = await drive(engine, repository, { goal: 'Summarize blockers', materials: [{ title: 'Notes', content: 'Release blocked by migration.', source: 'upload' }] });
  const types = run.events.map(item => item.type);
  expect(types).toContain('artifact.repair_requested');
  expect(types).toContain('artifact.repair_fallback');
  expect(types).not.toContain('run.failed');
  expect(run.partial).toBe(true);
  expect(JSON.stringify(run.artifacts[0]!.structured)).not.toContain('通常');
});
