import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { decisionSchema } from '../src/runtime/contracts.js';
import { materialContentHash } from '../src/runtime/materials.js';
import { runSourceReadUsage, sourceReadUsage, type ExecutionLimits } from '../src/runtime/execution-limits.js';
import type { ModelRequest } from '../src/runtime/model.js';
import type { ThreadHistory } from '../src/runtime/thread-history.js';

const cases = [
  { tool: 'sources.sample', title: 'notes.txt', content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'), options: {}, expected: { sampled: true, rowCount: 100 } },
  { tool: 'sources.markdownOutline', title: 'notes.md', content: '# Root\nbody\n## Child\nchild', options: {}, expected: { totalHeadings: 2 } },
  { tool: 'sources.markdownSection', title: 'notes.md', content: '# Root\nbody\n## Child\nchild', options: { heading: 'Child' }, expected: { content: '## Child\nchild' } },
  { tool: 'sources.jsonSummary', title: 'notes.json', content: '{"items":[1,2],"ready":true}', options: {}, expected: { shape: { type: 'object', keyCount: 2 } } },
  { tool: 'sources.jsonRead', title: 'notes.json', content: '{"items":[1,2],"ready":true}', options: { path: '$.items[1]' }, expected: { value: 2 } },
  { tool: 'sources.pdfRead', title: 'notes.pdf', content: '%PDF-1.7 fixture', options: { startPage: 2, endPage: 3 }, expected: { supported: false, startPage: 2, endPage: 3 } },
] as const;
type ReaderCase = typeof cases[number];
type Input = { sourceCatalog: Array<{ id: string }>; observations: Array<{ tool: string; argument: string; result: any }>; executionBudget: { finalOnly: boolean } };
const finish = (input: Input) => ({ type: 'finish', title: 'Source report', content: 'Report based on received bounded evidence.', evidenceRefs: input.sourceCatalog.map(source => source.id) });
const read = (reader: ReaderCase, input: Input) => ({ type: 'tool', tool: reader.tool, argument: input.sourceCatalog[0]!.id, ...reader.options });

async function setup(reader: ReaderCase, options: { decide?: (input: Input) => unknown; limits?: Partial<ExecutionLimits>; legacy?: boolean; history?: ThreadHistory } = {}) {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Read source', nodes: [{ id: 'inspect', title: 'Inspect', instruction: 'Inspect bounded source evidence', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Evidence received' } };
    expect(request.system).toContain(reader.tool);
    const input = request.input as Input;
    return { value: options.decide ? options.decide(input) : input.observations.length || input.executionBudget.finalOnly ? finish(input) : read(reader, input) };
  });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  let engine = new AgentEngine(repository, { model, executionLimits: options.limits });
  const run = await engine.create({ goal: 'Inspect source', materials: options.history ? [] : [{ title: reader.title, content: reader.content, source: 'upload' }] }, 'owner', 'local', options.history ? async current => {
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
        if (status === 'succeeded' || status === 'failed') return repository.get(run.id);
      }
      throw new Error('Run did not terminate');
    } };
}

describe.each(cases)('$tool executor integration', reader => {
  it.each([false, true])('works without an external allowlist and reaches reviewer evidence (legacy=%s)', async legacy => {
    const fixture = await setup(reader, { legacy });
    const completed = await fixture.drain();
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.allowedTools).toEqual([]);
    expect(completed.toolReceipts).toEqual([]);
    const observation = completed.steps[0]!.observations[0]!;
    expect(observation.tool).toBe(reader.tool);
    expect(observation.result).toMatchObject({ ...reader.expected, sourceContentHash: materialContentHash(reader.content) });
    expect(sourceReadUsage(completed.steps)).toEqual({ pages: 1, chars: JSON.stringify(observation.result).length });
    expect(runSourceReadUsage(completed)).toEqual(sourceReadUsage(completed.steps));
    expect((fixture.complete.mock.calls.at(-1)![0].input as { sourceObservations: unknown[] }).sourceObservations).toEqual([observation]);
    const input = { sourceCatalog: [{ id: completed.context.sources[0]!.id }] } as Input;
    expect(completed.events.find(event => event.type === 'tool.completed')!.data.inputHash).toBe(digest(decisionSchema.parse(read(reader, input))));
  });
  it('normalizes a missing type field', async () => {
    const fixture = await setup(reader, { decide: input => {
      if (input.observations.length) return finish(input);
      const { type: _type, ...decision } = read(reader, input); return decision;
    } });
    expect((await fixture.drain()).status).toBe('succeeded');
  });
  it('denies unknown IDs and file paths before reading', async () => {
    const fixture = await setup(reader, { decide: input => ({ ...read(reader, input), argument: '../other-source' }) });
    const completed = await fixture.drain();
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('Source tool denied an unknown resource');
    expect(completed.steps[0]!.observations).toEqual([]);
  });
  it('rejects invalid arguments without treating them as external tools', async () => {
    const fixture = await setup(reader, { decide: input => ({ ...read(reader, input), unexpected: true }) });
    const completed = await fixture.drain();
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('schema validation');
    expect(completed.pendingTool).toBeUndefined();
    expect(completed.toolReceipts).toEqual([]);
  });
  it.each(['maxNodeSourceChars', 'maxRunSourceChars'] as const)('withholds complete results exceeding %s', async field => {
    const fixture = await setup(reader, { limits: { [field]: 100 } });
    const completed = await fixture.drain();
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.steps[0]!.observations[0]!.tool).toBe(`${reader.tool}.limit`);
    expect(sourceReadUsage(completed.steps)).toEqual({ pages: 0, chars: 0 });
    expect(completed.artifacts[0]!.partial).toBe(true);
    expect(completed.calls.filter(call => call.phase === 'executor')).toHaveLength(2);
  });
  it('shares durable source allowances with raw reads across restart', async () => {
    const fixture = await setup(reader, { limits: { maxNodeSourcePages: 2 }, decide: input => input.executionBudget.finalOnly ? finish(input)
      : input.observations.length ? read(reader, input) : { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0]!.id } });
    await fixture.engine.advance(fixture.run.id); fixture.restart();
    const completed = await fixture.drain();
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.steps[0]!.observations.map(observation => observation.tool)).toEqual(['sources.read', reader.tool]);
    expect(runSourceReadUsage(completed)).toEqual(sourceReadUsage(completed.steps));
    expect(completed.artifacts[0]).toMatchObject({ partial: true, limitations: ['Node source page limit reached'] });
  });
  it('rejects another tool during the reserved final call', async () => {
    const fixture = await setup(reader, { limits: { maxNodeSourcePages: 1 }, decide: input => read(reader, input) });
    const completed = await fixture.drain();
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('tools are disallowed');
    expect(sourceReadUsage(completed.steps).pages).toBe(1);
  });
  it('only reads the frozen history excerpt, preserving origin and content hash', async () => {
    const history: ThreadHistory = {
      policyVersion: 'aeeis-thread-history/1', threadId: 'thread_fixture', budgetBytes: 4096, actualBytes: 1000,
      hash: 'frozen-history-hash', exclusions: [], visitedAncestors: 1, omitted: { excerpts: 0, artifacts: 0, ancestorContinuations: 0 }, truncated: 0, accessProvenance: [],
      entries: [{ runId: 'run_parent', revision: 1, threadSequence: 1, classification: 'internal', excerpts: [{ kind: 'artifact', ref: reader.title, hash: materialContentHash(reader.content), text: reader.content, truncated: false }] }],
    };
    const completed = await (await setup(reader, { history })).drain();
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.steps[0]!.observations[0]!.result).toMatchObject({ ...reader.expected, sourceContentHash: materialContentHash(reader.content), origin: { runId: 'run_parent', ref: reader.title } });
  });
});
