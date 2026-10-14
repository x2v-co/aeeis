import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { decisionSchema } from '../src/runtime/contracts.js';
import { materialContentHash } from '../src/runtime/materials.js';
import { sourceReadUsage, runSourceReadUsage, type ExecutionLimits } from '../src/runtime/execution-limits.js';
import type { ModelRequest } from '../src/runtime/model.js';
import type { ThreadHistory } from '../src/runtime/thread-history.js';

type Input = {
  sourceCatalog: Array<{ id: string }>;
  observations: Array<{ tool: string; argument: string; result: any }>;
  executionBudget: { finalOnly: boolean; nodeReads: { pages: number; chars: number }; runReads: { pages: number; chars: number } };
};
const content = ['team,amount', ...Array.from({ length: 200 }, (_, i) => `${i % 2 ? 'A' : 'B'},"1,000"`)].join('\n');
const finish = (input: Input) => ({ type: 'finish', title: 'Totals', content: 'Calculated totals from the received query evidence.', evidenceRefs: input.sourceCatalog.map(source => source.id) });
const query = (input: Input) => ({ type: 'tool', tool: 'sources.csvQuery', argument: input.sourceCatalog[0]!.id, groupBy: ['team'], aggregates: [{ op: 'sum', column: 'amount', as: 'total' }], orderBy: [{ column: 'total', direction: 'desc' }] });

async function setup(decide: (input: Input) => unknown = input => input.observations.length || input.executionBudget.finalOnly ? finish(input) : query(input), options: {
  legacy?: boolean; limits?: Partial<ExecutionLimits>; materials?: Array<{ title: string; source: string; content: string }>; history?: ThreadHistory;
} = {}) {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Totals', nodes: [{ id: 'totals', title: 'Totals', instruction: 'Calculate team totals', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Totals match evidence' } };
    expect(request.system).toContain('sources.csvQuery');
    expect(request.system).toContain('countDistinct');
    return { value: decide(request.input as Input) };
  });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  let engine = new AgentEngine(repository, { model, executionLimits: options.limits });
  const run = await engine.create({ goal: 'Calculate team totals', materials: options.materials ?? [{ title: 'totals.csv', source: 'upload', content }] }, 'owner', 'local', options.history ? async current => {
    current.context.threadHistory = options.history;
    await repository.create(current); return current;
  } : undefined);
  if (options.legacy) await repository.mutate(run.id, current => { delete current.capabilityCatalogVersion; });
  await engine.advance(run.id);
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
  return { repository, run, complete, get engine() { return engine; }, restart() { engine = new AgentEngine(repository, { model }); },
    async drain() {
      for (let i = 0; i < 16; i++) {
        const status = await engine.advance(run.id);
        if (['succeeded', 'failed'].includes(status)) return repository.get(run.id);
      }
      throw new Error('Run did not terminate');
    },
  };
}

describe('executor CSV query tool', () => {
  it.each(['<', 'less_than', 'BEFORE', ' LT ', '<=', 'LTE', 'less-than-or-equal'])('run_313c8bce: normalizes %s and retains date comparisons', async op => {
    const fixture = await setup(input => input.observations.length ? finish(input) : {
      type: 'tool', tool: 'sources.csvQuery', argument: input.sourceCatalog[0]!.id,
      filters: [{ column: 'status', op: 'NE', value: 'done' }, { column: 'due', op, value: '2026-10-14' }], select: ['id'],
    }, { materials: [{ title: 'tasks.csv', source: 'upload', content: 'id,status,due\n1,open,2026-10-04\n2,done,2026-10-09\n3,open,2026-10-21\n4,open,2026-10-13\n5,open,2026-10-14' }] });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.events.some(event => event.type === 'model.schema_retry')).toBe(false);
    const inclusive = ['<=', 'LTE', 'less-than-or-equal'].includes(op);
    expect((run.steps[0]!.observations[0]!.result as any).rows).toEqual(inclusive ? [['1'], ['4'], ['5']] : [['1'], ['4']]);
  });
  it('run_313c8bce: retry explains filters.1.op and lists valid operators', async () => {
    const fixture = await setup(input => {
      if (input.observations.some(item => item.tool === 'sources.csvQuery')) return finish(input);
      const retry = input.observations.find(item => item.tool === 'output.schema');
      if (retry) {
        expect(retry.result.error.message).toContain('eq, ne, gt, gte, lt, lte, contains, in, isEmpty');
        expect(retry.result.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'filters.1.op', message: expect.stringContaining('Valid ops:') })]));
      }
      return { ...query(input), filters: [{ column: 'team', op: 'eq', value: 'A' }, { column: 'amount', op: retry ? 'less_than' : 'unsupported', value: 2000 }] };
    });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.events.filter(event => event.type === 'model.schema_retry')).toHaveLength(1);
  });

  it.each([false, true])('executes a built-in query without an external tool allowlist (legacy=%s)', async legacy => {
    const fixture = await setup(undefined, { legacy });
    const completed = await fixture.drain();
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.allowedTools).toEqual([]);
    expect(completed.toolReceipts).toEqual([]);
    const observation = completed.steps[0]!.observations[0]!;
    expect(observation.tool).toBe('sources.csvQuery');
    expect(observation.result).toMatchObject({ id: completed.context.sources[0]!.id, rows: [['B', 100000], ['A', 100000]], matchedRowCount: 200, sourceContentHash: materialContentHash(content), truncated: false });
    expect(sourceReadUsage(completed.steps)).toEqual({ pages: 1, chars: JSON.stringify(observation.result).length });
    const executor = fixture.complete.mock.calls.map(([request]) => request).filter(request => !request.system.includes('Plan a real deliverable') && !request.system.includes('Independently review'));
    expect((executor[1]!.input as Input).observations[0]).toEqual(observation);
    expect(completed.events.find(event => event.type === 'tool.completed')!.data.inputHash).toBe(digest(decisionSchema.parse(query(executor[0]!.input as Input))));
    const review = fixture.complete.mock.calls.at(-1)![0].input as { sourceObservations: unknown[] };
    expect(review.sourceObservations).toEqual([observation]);
    expect(completed.artifacts[0]!.evidenceRefs).toEqual([completed.context.sources[0]!.id]);
    expect(completed.context.sources[0]!.content).toBe(content);
  });

  it('normalizes the missing type field like sources.read', async () => {
    const fixture = await setup(input => {
      if (input.observations.length) return finish(input);
      const { type: _type, ...decision } = query(input); return decision;
    });
    expect((await fixture.drain()).status).toBe('succeeded');
  });

  it.each(['missing-source', '../sources/other.csv'])('denies an unknown source id: %s', async argument => {
    const fixture = await setup(input => ({ ...query(input), argument }));
    const completed = await fixture.drain();
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('Source tool denied an unknown resource');
    expect(completed.steps[0]!.observations).toEqual([]);
    expect(completed.pendingTool).toBeUndefined();
  });

  it('rejects a non-CSV stored source as a recoverable executor error', async () => {
    const fixture = await setup(undefined, { materials: [{ title: 'notes.txt', source: 'upload', content: 'Plain notes' }] });
    const completed = await fixture.drain();
    expect(completed.status).toBe('succeeded');
    expect(JSON.stringify(completed.steps[0]!.observations)).toContain('requires a CSV source');
    // Invalid query arguments are first returned to the executor as recoverable errors.
    expect(completed.events.filter(item => item.type === 'tool.failed_recoverable').length).toBeGreaterThan(0);
  });

  it('returns invalid comparison operands to the executor and lets it correct the query', async () => {
    const fixture = await setup(input => {
      const errors = input.observations.filter((item: { result?: { error?: unknown } }) => item.result?.error);
      if (input.observations.length > errors.length) return finish(input);
      if (errors.length) return { ...query(input), filters: [{ column: 'amount', op: 'lt', value: 1000 }] };
      return { ...query(input), filters: [{ column: 'team', op: 'lt', value: 'not-a-number' }] };
    });
    const completed = await fixture.drain();
    expect(completed.status).toBe('succeeded');
    expect(completed.events.filter(item => item.type === 'tool.failed_recoverable')).toHaveLength(1);
  });

  it.each([{ limit: 201 }, { unexpected: 'field' }, { filters: [{ column: 'team', op: 'regex', value: '.*' }] }, { type: 'invalid' }])('rejects malformed query decisions without external capability fallback: %j', async fields => {
    const fixture = await setup(input => ({ ...query(input), ...fields }));
    const completed = await fixture.drain();
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('schema validation');
    expect(completed.calls.at(-1)!.validationErrors).toBeDefined();
    // One corrective schema retry is offered before the Run fails.
    expect(completed.steps[0]!.observations.map(item => item.tool)).toEqual(['output.schema']);
    expect(completed.events.filter(item => item.type === 'model.schema_retry')).toHaveLength(1);
    expect(completed.pendingTool).toBeUndefined();
    expect(completed.toolReceipts).toEqual([]);
  });

  it('counts reads and queries against shared durable source allowances across restart', async () => {
    const fixture = await setup(input => input.executionBudget.finalOnly ? finish(input) : input.observations.length ? query(input) : { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0]!.id, offset: 0, limit: 1 }, { limits: { maxNodeSourcePages: 2 } });
    await fixture.engine.advance(fixture.run.id);
    fixture.restart();
    const completed = await fixture.drain();
    expect(completed.status).toBe('succeeded');
    expect(completed.steps[0]!.observations.map(observation => observation.tool)).toEqual(['sources.read', 'sources.csvQuery']);
    expect(sourceReadUsage(completed.steps).pages).toBe(2);
    expect(runSourceReadUsage(completed)).toEqual(sourceReadUsage(completed.steps));
    expect(completed.artifacts[0]).toMatchObject({ partial: true, limitations: ['Node source page limit reached'] });
    expect(completed.calls.filter(call => call.phase === 'executor')).toHaveLength(3);
  });

  it.each(['maxNodeSourceChars', 'maxRunSourceChars'] as const)('withholds queries exceeding remaining %s', async field => {
    const fixture = await setup(undefined, { limits: { [field]: 100 } });
    const completed = await fixture.drain();
    expect(completed.status).toBe('succeeded');
    expect(completed.steps[0]!.observations[0]!.tool).toBe('sources.csvQuery.limit');
    expect(sourceReadUsage(completed.steps)).toEqual({ pages: 0, chars: 0 });
    expect(completed.artifacts[0]!.partial).toBe(true);
    expect(completed.calls.filter(call => call.phase === 'executor')).toHaveLength(2);
  });

  it('rejects query decisions during a final finish call', async () => {
    const fixture = await setup(query, { limits: { maxNodeSourcePages: 1 } });
    const completed = await fixture.drain();
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('tools are disallowed');
    expect(sourceReadUsage(completed.steps).pages).toBe(1);
  });

  it('queries only the frozen CSV history excerpt and preserves CSV quoting', async () => {
    const text = 'team,amount\n"A, Inc.","1,200"\n"A, Inc.",30';
    const history: ThreadHistory = {
      policyVersion: 'aeeis-thread-history/1', threadId: 'thread_fixture', budgetBytes: 4096, actualBytes: 1000,
      hash: 'frozen-history-hash', exclusions: [], visitedAncestors: 1, omitted: { excerpts: 0, artifacts: 0, ancestorContinuations: 0 }, truncated: 0, accessProvenance: [],
      entries: [{ runId: 'run_parent', revision: 1, threadSequence: 1, classification: 'internal', excerpts: [{ kind: 'artifact', ref: 'report.csv', hash: materialContentHash(text), text, truncated: false }] }],
    };
    const fixture = await setup(undefined, { materials: [], history });
    const completed = await fixture.drain();
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.steps[0]!.observations[0]!.result).toMatchObject({ id: 'history:run_parent:report.csv', rows: [['A, Inc.', 1230]], sourceContentHash: materialContentHash(text), origin: { runId: 'run_parent', ref: 'report.csv' } });
  });
});
