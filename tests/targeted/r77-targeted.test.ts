// r77 targeted retest: the three #77 paths the live r77 run never reached.
// Wire-level injection: real AgentEngine + real HttpModelAdapter, provider replaced by a scripted SSE fetch.
// Run alone:  npm run retest:r77-targeted
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../../src/runtime/engine.js';
import { HttpModelAdapter } from '../../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const quiet = () => { const lines: string[] = []; for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); }); return lines; };
const enc = new TextEncoder();
const frame = (content: string) => enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
const done = enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
const reply = (value: unknown) => new Response(new ReadableStream({ start(c) { c.enqueue(frame(JSON.stringify(value))); c.enqueue(done); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
/** Keeps sending real content (never a stall) until the overall deadline aborts it. */
const trickle = (init: { signal?: AbortSignal }) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Response(new ReadableStream({ start(c) {
    c.enqueue(frame('{"type":"finish","content":"'));
    timer = setInterval(() => { try { c.enqueue(frame('x')); } catch { clearInterval(timer); } }, 10);
    init.signal?.addEventListener('abort', () => { clearInterval(timer); try { c.error(init.signal!.reason); } catch { /* closed */ } }, { once: true });
  }, cancel() { clearInterval(timer); } }), { headers: { 'content-type': 'text/event-stream' } });
};
type Call = { system: string; input: any };
function provider(script: (call: Call, init: any) => Response | unknown) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    const call = { system: String(body.messages[0].content), input: JSON.parse(body.messages[1].content) };
    calls.push(call);
    const out = script(call, init);
    return out instanceof Response ? out : reply(out);
  });
  vi.stubGlobal('fetch', fetch);
  return calls;
}
const isPlanner = (c: Call) => c.system.includes('Plan a real deliverable');
const isReviewer = (c: Call) => c.system.includes('Independently review');
const adapter = (overallMs = 30_000) => new HttpModelAdapter('http://localhost:9/v1', 'fixture', '', undefined, 30_000, undefined, false, undefined,
  { maxAttempts: 2, stream: true, firstByteTimeoutMs: 5_000, idleTimeoutMs: 5_000, stallTimeoutMs: 5_000, midstreamRetries: 1, streamOverallTimeoutMs: overallMs, callBudgetMs: 30_000 });
async function drive(engine: AgentEngine, repository: InMemoryRunRepository, input: Record<string, unknown>) {
  const run = await engine.create(input as never);
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 20; i++) {
    const current = await repository.get(run.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    await engine.advance(run.id).catch(() => undefined);
  }
  return repository.get(run.id);
}
const onePlan = (instruction: string) => ({ summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction, dependsOn: [] }] });

describe('r77 targeted retest', () => {
  // lt: the model sends csvQuery with object-shaped filters and in/nin; the tool must run and return the right rows.
  it('lt: csvQuery object filters + in/nin reach the tool and return the correct rows', async () => {
    quiet();
    const csv = ['id,status,owner', '1,open,A', '2,done,B', '3,blocked,A', '4,open,C', '5,cancelled,B'].join('\n');
    const queries = [
      { filters: { owner: 'A' }, expect: [['1'], ['3']] },
      { filters: { column: 'status', op: 'nin', value: ['done', 'cancelled'] }, expect: [['1'], ['3'], ['4']] },
      { filters: [{ column: 'owner', op: 'in', value: ['B', 'C'] }, { column: 'status', op: 'notIn', value: ['done'] }], expect: [['4'], ['5']] },
    ];
    provider(c => {
      if (isPlanner(c)) return onePlan('List open items from the CSV');
      if (isReviewer(c)) return { verdict: 'accepted', summary: 'ok', issues: [] };
      const source = c.input.sourceCatalog[0].id;
      const used = (c.input.observations ?? []).filter((o: any) => o.tool === 'sources.csvQuery').length;
      if (used < queries.length) return { type: 'tool', tool: 'sources.csvQuery', argument: source, select: ['id'], filters: queries[used]!.filters };
      return { type: 'finish', title: 'Open items', content: 'Items 1, 3 and 4 are not done.', evidenceRefs: [source] };
    });
    const repository = new InMemoryRunRepository();
    const run = await drive(new AgentEngine(repository, { model: adapter() }), repository, { goal: 'List open items', materials: [{ title: 'items.csv', source: 'upload', content: csv }] });
    const results = run.steps.flatMap(step => step.observations).filter(o => o.tool === 'sources.csvQuery').map(o => (o.result as any).rows);
    expect(results).toEqual(queries.map(q => q.expect));
    expect(run.events.some(e => e.type === 'run.failed' || e.type === 'tool.failed_recoverable')).toBe(false);
    expect(run.status, run.error).toBe('succeeded');
  });

  // csv: an executor call that keeps streaming past the overall deadline must not be retried (one provider request).
  it('csv: overall timeout is not retried at transport or task level and ends partial with Unknown:', async () => {
    const lines = quiet();
    let executorRequests = 0;
    provider((c, init) => {
      if (isPlanner(c)) return onePlan('Aggregate the CSV');
      if (isReviewer(c)) return { verdict: 'accepted', summary: 'ok', issues: [] };
      executorRequests++;
      return trickle(init);
    });
    const repository = new InMemoryRunRepository();
    const run = await drive(new AgentEngine(repository, { model: adapter(400) }), repository, { goal: 'Aggregate', materials: [{ title: 'data.csv', source: 'upload', content: 'team,amount\nA,1\nB,2' }] });
    const types = run.events.map(e => e.type);
    expect(executorRequests).toBe(1);
    expect(types).not.toContain('model.timeout_retry');
    expect(types).not.toContain('model.midstream_retry');
    expect(lines.some(line => line.includes('"retryDecision":"overall-timeout"'))).toBe(true);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
    expect(String(run.events.find(e => e.type === 'run.partial')!.data.reason)).toContain('Unknown:');
  });

  // chifeng: a structured finish needing repair, whose repair call hits the overall deadline, emits artifact.structured_dropped.
  it('chifeng: repair overall timeout drops the unverified structured object (artifact.structured_dropped)', async () => {
    quiet();
    vi.stubEnv('AEEIS_REVIEW_AFTER_STOP', '0');
    const pulse = { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };
    const plan = { summary: 'Trip', nodes: [
      { id: 'route', title: 'Route', instruction: 'Summarize route', dependsOn: [] },
      { id: 'budget', title: 'Budget and contingency', instruction: 'Summarize contingency', dependsOn: ['route'] },
    ] };
    let repairs = 0;
    provider((c, init) => {
      if (isPlanner(c)) return plan;
      if (isReviewer(c)) return { verdict: 'accepted', summary: 'ok', issues: [] };
      const ref = c.input.sourceCatalog[0].id;
      if (c.input.task.id === 'route') return { type: 'finish', title: 'Route', content: 'Route is confirmed.', evidenceRefs: [ref] };
      if (c.input.finishRepair) { repairs++; return trickle(init); }
      return { type: 'finish', title: 'Contingency', content: 'Unverified claim [source_missing]', evidenceRefs: ['source_missing'], artifactType: 'project-pulse/1', structured: pulse };
    });
    const repository = new InMemoryRunRepository();
    const run = await drive(new AgentEngine(repository, { model: adapter(400) }), repository, { goal: '规划赤峰 3 天行程', materials: [{ title: 'Notes', source: 'upload', content: 'Route is confirmed.' }] });
    const dropped = run.events.filter(e => e.type === 'artifact.structured_dropped');
    expect(repairs).toBe(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.data).toMatchObject({ taskId: 'budget' });
    expect(run.artifacts.every(a => a.structured === undefined)).toBe(true);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
  });
});
