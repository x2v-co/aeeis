// r79 sg retest regressions (685f4ea): csv / md / pdf2 / chifeng.
// csv, md, chifeng and input replay the model outputs recorded in the r79 debug.json exports
// (tests/fixtures/r79/*.json, extracted verbatim from /workspace/aeeis-dryrun/r79/<case>/debug.json).
// Run alone:  npm run retest:r79-targeted
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelTimeout, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { queryCsvSource } from '../src/runtime/csv-query.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { formContent } from './fillable-pdf-fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const quiet = () => { for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined); };
const runtimeUnknown = /\n\nUnknown:\n- Remaining work:/;

interface FixtureCall { phase: 'planner' | 'executor' | 'reviewer'; taskId?: string; state: string; rawOutput?: string; error?: string }
interface Fixture { case: string; artifacts: { taskId: string; id: string }[]; goal: string; builtinSkill?: string; maxModelCalls: number; materials: { id: string; title: string; source: string; content: string }[]; calls: FixtureCall[] }
const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/r79/${name}.json`, import.meta.url), 'utf8'));

/** Replays the recorded r79 outputs per phase/task. A recorded timeout is a provider that needed `slowMs`:
 * it times out (overall) when the engine allots less, and otherwise returns `slowFinish`. */
function replayModel(fx: Fixture, options: { slowMs?: number; slowFinish?: (taskId: string, request: ModelRequest) => unknown; reviewer?: (request: ModelRequest) => unknown; after?: (taskId: string, request: ModelRequest) => unknown } = {}) {
  const queues = new Map<string, FixtureCall[]>();
  for (const call of fx.calls) {
    const key = call.phase === 'executor' ? `executor:${call.taskId}` : call.phase;
    queues.set(key, [...(queues.get(key) ?? []), call]);
  }
  const seen: { phase: string; taskId?: string; timeoutMs?: number; request: ModelRequest }[] = [];
  let ids: string[] = [];
  let deps: { id: string; taskId: string }[] = [];
  // Source and dependency-artifact ids are new in the replayed Run: map the recorded r79 ids onto them.
  const remap = (text: string) => fx.artifacts.reduce((value, artifact) => {
    const current = deps.find(dep => dep.taskId === artifact.taskId);
    return current ? value.split(artifact.id).join(current.id) : value;
  }, fx.materials.reduce((value, material, index) => ids[index] ? value.split(material.id).join(ids[index]!) : value, text));
  const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
    const input = request.input as any;
    if (input?.sourceCatalog) ids = input.sourceCatalog.map((source: { id: string }) => source.id);
    if (Array.isArray(input?.dependencies)) deps = input.dependencies;
    const phase = isPlanner(request) ? 'planner' : isReviewer(request) ? 'reviewer' : 'executor';
    const taskId = phase === 'executor' ? input.task.id as string : undefined;
    seen.push({ phase, ...(taskId ? { taskId } : {}), ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), request });
    if (phase === 'reviewer' && options.reviewer) return { value: options.reviewer(request) };
    const next = queues.get(phase === 'executor' ? `executor:${taskId}` : phase)?.shift();
    if (!next) {
      if (phase === 'executor' && options.after) return { value: options.after(taskId!, request) };
      if (phase === 'reviewer') return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
      throw new Error(`replay exhausted for ${phase}:${taskId}`);
    }
    if (next.rawOutput === undefined) {
      if ((request.timeoutMs ?? Infinity) < (options.slowMs ?? Infinity)) throw new ModelTimeout(`Model response timed out after ${request.timeoutMs}ms (overall timeout). Provider billing requires reconciliation.`);
      return { value: options.slowFinish!(taskId!, request) };
    }
    // The debug export caps rawOutput (~6 KB); a truncated recorded finish is replaced by `slowFinish`.
    try { return { value: JSON.parse(remap(next.rawOutput)) }; }
    catch (error) { if (!options.slowFinish) throw error; return { value: options.slowFinish(taskId!, request) }; }
  } };
  return { model, seen };
}
async function drive(engine: AgentEngine, repository: InMemoryRunRepository, input: Record<string, unknown>, steps = 60): Promise<AgentRun> {
  const run = await engine.create(input as never);
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < steps; i++) {
    const current = await repository.get(run.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    await engine.advance(run.id).catch(() => undefined);
  }
  return repository.get(run.id);
}
const createInput = (fx: Fixture) => ({ goal: fx.goal, maxModelCalls: fx.maxModelCalls, ...(fx.builtinSkill ? { builtinSkill: fx.builtinSkill } : {}),
  ...(fx.materials.length ? { materials: fx.materials.map(({ title, source, content }) => ({ title, source, content })) } : {}) });

describe('r79 csv (replay of r79/csv/debug.json)', () => {
  const fx = fixture('csv');
  // The two calls that timed out in r79 have no recorded output; reuse r79's complete Project Pulse finish
  // from analyze_status_progress (the analyze_blockers_risks one was truncated by the debug export).
  const pulse = JSON.parse(fx.calls.find(call => call.taskId === 'analyze_status_progress' && call.rawOutput?.includes('"finish"'))!.rawOutput!);
  const slowFinish = (taskId: string, request: ModelRequest) => {
    const ref = (request.input as any).sourceCatalog[0].id as string;
    const text = JSON.stringify(pulse).split(fx.materials[0]!.id).join(ref);
    const value = JSON.parse(text);
    return taskId === 'synthesize_project_pulse' ? value : { type: 'finish', title: taskId, content: `${taskId} 分析见 CSV 统计。[${ref}]`, evidenceRefs: [ref] };
  };
  it('the reserved final calls get the Run share instead of a fixed 180 s, so a slow synthesis completes', async () => {
    quiet();
    const repository = new InMemoryRunRepository();
    const { model, seen } = replayModel(fx, { slowMs: 200_000, slowFinish });
    const final = await drive(new AgentEngine(repository, { model }), repository, createInput(fx));
    const types = final.events.map(item => item.type);
    expect(final.error ?? '').not.toContain('Node final finish call exhausted');
    expect(final.status, final.error).toBe('succeeded');
    expect(final.artifacts.some(artifact => artifact.taskId === 'synthesize_project_pulse')).toBe(true);
    // The call reserve still forces the last two tasks to a single final call each (as in r78/r79).
    expect(types.filter(type => type === 'execution.limited')).toHaveLength(2);
    const finals = seen.filter(call => call.phase === 'executor' && ['analyze_owners_deadlines', 'synthesize_project_pulse'].includes(call.taskId!) && (call.request.input as any).executionBudget?.finalOnly);
    expect(finals.length).toBe(2);
    for (const call of finals) expect(call.timeoutMs!).toBeGreaterThan(180_000);
  });
  it('grouped csvQuery errors name the output columns instead of a bare "unknown column"', () => {
    const source = { id: 'source_csv', hash: 'h', kind: 'material', title: 'alpha-tracker.csv', source: 'browser-file:alpha-tracker.csv', content: fx.materials[0]!.content, untrusted: true } as never;
    const select = JSON.parse(fx.calls[2]!.rawOutput!);
    const { type: _t, tool: _tool, argument: _a, ...query } = select;
    expect(() => queryCsvSource(source, query)).toThrow(/unknown column "id" \(a source column, not one of the output columns of this grouped query: status, rows\)/);
    const due = JSON.parse(fx.calls.find(call => call.rawOutput?.includes('"groupBy":["owner","status"]') && call.rawOutput.includes('"orderBy":[{"column":"due"'))!.rawOutput!);
    const { type: _t2, tool: _tool2, argument: _a2, ...dueQuery } = due;
    expect(() => queryCsvSource(source, dueQuery)).toThrow(/unknown column "due" \(a source column, not one of the output columns of this grouped query: owner, status, tasks\)/);
  });
});

describe('r79 csv: a share-limited timeout of a final-only call is really retried', () => {
  it('clears the spent final call so the boosted retry runs instead of "Node final finish call exhausted"', async () => {
    quiet();
    vi.stubEnv('AEEIS_RUN_MODEL_BUDGET_MS', '900000');
    const repository = new InMemoryRunRepository();
    // Like r79 synthesize_project_pulse: the call reserve makes b's first call final-only, while c is still pending.
    const nodes = [{ id: 'a', title: 'A', instruction: 'Analyse', dependsOn: [] }, { id: 'b', title: 'B', instruction: 'Synthesize', dependsOn: ['a'] }, { id: 'c', title: 'C', instruction: 'Summarize', dependsOn: ['b'] }];
    const timeouts: number[] = [];
    let finals = 0;
    const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
      if (isPlanner(request)) return { value: { summary: 'Report', nodes } };
      if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
      const input = request.input as any;
      if (input.task.id === 'b') {
        expect(input.executionBudget.finalOnly).toBe(true);
        timeouts.push(request.timeoutMs!);
        if (++finals === 1) throw new ModelTimeout(`Model response timed out after ${request.timeoutMs}ms (overall timeout). Provider billing requires reconciliation.`);
      }
      return { value: { type: 'finish', title: input.task.title, content: `${input.task.title} 完成。`, evidenceRefs: [] } };
    } };
    const final = await drive(new AgentEngine(repository, { model }), repository, { goal: 'Write a short report', maxModelCalls: 5 });
    const retry = final.events.find(item => item.type === 'model.timeout_retry');
    expect(retry?.data).toMatchObject({ shareLimited: true });
    expect(finals).toBe(2);
    expect(timeouts[1]!).toBeGreaterThan(timeouts[0]!);
    expect(final.error ?? '').not.toContain('Node final finish call exhausted');
    expect(final.status, final.error).toBe('succeeded');
    expect(final.artifacts.map(artifact => artifact.taskId).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('r79 md (replay of r79/md/debug.json)', () => {
  const fx = fixture('md');
  it('source-gap "limitations" do not make the Run partial, and no runtime Unknown: block reaches later tasks or the reviewer', async () => {
    quiet();
    const repository = new InMemoryRunRepository();
    const { model, seen } = replayModel(fx, { reviewer: () => ({ verdict: 'accepted', summary: 'ok', issues: [] }) });
    const final = await drive(new AgentEngine(repository, { model }), repository, createInput(fx));
    const synth = seen.find(call => call.taskId === 'synthesize_project_pulse')!;
    expect(JSON.stringify((synth.request.input as any).dependencies)).not.toMatch(/Unknown:\\n- Remaining work/);
    const review = seen.find(call => call.phase === 'reviewer')!;
    expect(JSON.stringify((review.request.input as any).artifacts)).not.toMatch(/Unknown:\\n- Remaining work/);
    expect((review.request.input as any).partial).toBe(false);
    expect(final.status, final.error).toBe('succeeded');
    expect(final.partial ?? false).toBe(false);
    for (const artifact of final.artifacts) {
      expect(artifact.content).not.toMatch(runtimeUnknown);
      expect(artifact.content.startsWith('Partial answer')).toBe(false);
    }
    expect(final.events.some(item => item.type === 'artifact.source_gaps_reclassified')).toBe(true);
  });
  it('a genuinely partial Run still gets exactly one Unknown: block on its final output', async () => {
    quiet();
    const repository = new InMemoryRunRepository();
    const nodes = [{ id: 'a', title: 'A', instruction: 'Extract', dependsOn: [] }, { id: 'b', title: 'B', instruction: 'Synthesize', dependsOn: ['a'] }];
    const deps: string[] = [];
    const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
      if (isPlanner(request)) return { value: { summary: 'Report', nodes } };
      if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
      const input = request.input as any;
      if (input.task.id === 'b') deps.push(JSON.stringify(input.dependencies));
      return { value: { type: 'finish', title: input.task.title, content: `${input.task.title} 完成。`, evidenceRefs: [], ...(input.task.id === 'a' ? { limitations: ['Model call budget exhausted before every row was scanned'] } : {}) } };
    } };
    const final = await drive(new AgentEngine(repository, { model }), repository, { goal: 'Write a short report' });
    expect(deps[0]).not.toMatch(/Unknown:\\n- Remaining work/);
    expect(final.status, final.error).toBe('succeeded');
    expect(final.partial).toBe(true);
    const b = final.artifacts.find(artifact => artifact.taskId === 'b')!;
    expect(b.content.match(/\n\nUnknown:\n- Remaining work:/g)).toHaveLength(1);
  });
});

describe('r79 pdf2: placeholder delegate', () => {
  // Verbatim r79 map_supported_facts output (allowedAgents was empty).
  const delegate = '{"type":"delegate","agentId":"[REDACTED]-agent-id","goal":"bounded delegated goal","expectedOutput":"result-envelope/1","mode":"sync"}';
  it('an unapproved/placeholder delegate is a recoverable tool failure, not run.failed', async () => {
    quiet();
    const repository = new InMemoryRunRepository();
    const nodes = [{ id: 'map_supported_facts', title: 'Map supported facts', instruction: 'Map facts from partial.md to fields', dependsOn: [] }];
    let calls = 0;
    const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
      if (isPlanner(request)) return { value: { summary: 'Fill', nodes } };
      if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
      const input = request.input as any, caseRef = input.sourceCatalog[1].id;
      if (++calls === 1) return { value: JSON.parse(delegate) };
      expect(JSON.stringify(input.observations)).toContain('agent_not_allowed');
      return { value: { type: 'finish', title: 'Field map', content: `name=Maya Chen, email=maya@example.test [${caseRef}]`, evidenceRefs: [caseRef] } };
    } };
    const final = await drive(new AgentEngine(repository, { model }), repository, { goal: 'Map the facts for the registration PDF', materials: [
      { title: 'registration.pdf', source: 'upload:registration.pdf', content: formContent },
      { title: 'partial.md', source: 'upload:partial.md', content: 'Name: Maya Chen\nEmail: maya@example.test' },
    ] });
    expect(final.error ?? '').not.toContain('allowedAgents');
    const failure = final.events.find(item => item.type === 'tool.failed_recoverable');
    expect(failure?.data).toMatchObject({ toolId: 'delegate', errorCode: 'agent_not_allowed' });
    expect(String(failure?.data.message)).toContain('placeholder');
    expect(final.status, final.error).toBe('succeeded');
  });
});

describe('r79 chifeng (replay of r79/chifeng/debug.json)', () => {
  const fx = fixture('chifeng');
  it('a sourceless guide does not stop at needs_input: the question is deferred and the task proceeds on labelled assumptions', async () => {
    quiet();
    const repository = new InMemoryRunRepository();
    const prompts: string[] = [];
    const { model } = replayModel(fx, { after: (taskId, request) => {
      if (taskId === 'trip_framework_and_route') { prompts.push(request.system); expect(JSON.stringify((request.input as any).observations)).toContain('question.deferred'); }
      return { type: 'finish', title: taskId, content: `推断：按从赤峰市区出发、8月中旬、轿车自驾假设安排 ${taskId}。可按实际出发地调整。`, evidenceRefs: [] };
    } });
    const final = await drive(new AgentEngine(repository, { model }), repository, createInput(fx));
    expect(final.events.some(item => item.type === 'input.deferred')).toBe(true);
    expect(final.status, final.error).toBe('succeeded');
    expect(final.question).toBeUndefined();
    expect(prompts[0]).toContain('推断：');
    expect(final.artifacts.some(artifact => artifact.taskId === 'final_guide_synthesis')).toBe(true);
  });
  it('a goal that explicitly says "缺什么就先问我" (r79 input) still stops at needs_input', async () => {
    quiet();
    const input = fixture('input');
    const repository = new InMemoryRunRepository();
    const { model } = replayModel(input);
    const final = await drive(new AgentEngine(repository, { model }), repository, createInput(input));
    expect(final.status).toBe('needs_input');
    expect(final.events.some(item => item.type === 'input.deferred')).toBe(false);
  });
});
