import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, normalizeFinishOutput, runClock } from '../src/runtime/engine.js';
import { decisionSchema } from '../src/runtime/contracts.js';
import { queryCsvSource } from '../src/runtime/csv-query.js';
import { threadHistoryGuidance } from '../src/runtime/thread-context.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('run clock', () => {
  it('renders the Run start in the configured zone with offset', () => {
    expect(runClock({ createdAt: '2026-10-13T20:30:00.000Z' }, 'Asia/Shanghai')).toMatchObject({ currentDate: '2026-10-14', localTime: '2026-10-14T04:30+08:00', timeZone: 'Asia/Shanghai', runStartedAt: '2026-10-13T20:30:00.000Z' });
    expect(runClock({ createdAt: '2026-10-13T20:30:00.000Z' }, 'Not/AZone')).toMatchObject({ timeZone: 'UTC', currentDate: '2026-10-13', localTime: '2026-10-13T20:30+00:00' });
  });
});

describe('csvQuery truncation', () => {
  it('marks truncated results with omitted row counts and a citation note', () => {
    const content = ['id,v', ...Array.from({ length: 30 }, (_, i) => `${i},${i}`)].join('\n');
    const result = queryCsvSource({ id: 's.csv', title: 't.csv', source: 'upload', hash: 'h', content }, { limit: 5 }) as Record<string, unknown>;
    expect(result).toMatchObject({ truncated: true, returnedRows: 5, totalResultRows: 30, omittedRows: 25 });
    expect(String(result.truncationNote)).toContain('5 of 30');
  });
});

describe('finish normalization without wrapper', () => {
  it('wraps a top-level structured artifact', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pulse = { schemaVersion: 'project-pulse/1', title: 'Pulse', risks: [{ text: 'r', evidenceRefs: ['s1'] }] };
    const out = normalizeFinishOutput(pulse) as Record<string, unknown>;
    expect(out).toMatchObject({ type: 'finish', title: 'Pulse', artifactType: 'project-pulse/1', evidenceRefs: ['s1'], structured: pulse });
    expect(decisionSchema.parse(out).type).toBe('finish');
  });
  it('stringifies object content and logs the shape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeFinishOutput({ title: 'J', content: { a: 1 }, evidenceRefs: [] }) as Record<string, unknown>;
    expect(out).toMatchObject({ type: 'finish', content: '{\n  "a": 1\n}' });
    expect(String(warn.mock.calls[0]![0])).toContain('object-content');
  });
});

describe('follow-up guidance', () => {
  it('requires evidence for recommendations and labels inferences', () => {
    expect(threadHistoryGuidance).toContain('推断');
    expect(threadHistoryGuidance).toContain('supported by cited evidence');
  });
});

// Fixed regression case: the task can only be answered with an ISO-date lt filter.
describe('regression: lt date filter', () => {
  it('answers "tasks due before 2026-10-14" via csvQuery lt on a date column, with clock injected', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const content = 'id,title,due,createdAt\n1,alpha,2026-10-01,2026-01-01\n2,beta,2026-11-20,2026-01-01\n3,gamma,2026-10-13,2026-01-01\n4,delta,tbd,2026-01-01';
    const repository = new InMemoryRunRepository();
    const seen: Array<Record<string, unknown>> = [];
    const complete = vi.fn(async (request: ModelRequest) => {
      const input = request.input as Record<string, any>;
      if (request.system.includes('Plan a real deliverable')) { expect(input.clock?.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); return { value: { summary: 'Due', nodes: [{ id: 'due', title: 'Overdue', instruction: 'List tasks due before 2026-10-14', dependsOn: [] }] } }; }
      if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'ok' } };
      seen.push(input);
      expect(input.clock?.timeZone).toBeTruthy();
      const csvId = input.sourceCatalog[0].id;
      if (!input.observations.length) return { value: { type: 'tool', tool: 'sources.csvQuery', argument: csvId, filters: [{ column: 'due', op: 'lt', value: '2026-10-14' }], select: ['id'] } };
      return { value: { type: 'finish', title: 'Overdue', content: 'alpha and gamma', evidenceRefs: [csvId] } };
    });
    const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete } });
    const run = await engine.create({ goal: 'Which tasks are due before 2026-10-14?', materials: [{ title: 'tasks.csv', source: 'upload', content }] }, 'owner', 'local');
    await engine.advance(run.id);
    await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
    let status = '';
    for (let i = 0; i < 16 && !['succeeded', 'failed'].includes(status); i++) status = await engine.advance(run.id);
    const done = await repository.get(run.id);
    expect(status, done.error).toBe('succeeded');
    const observation = done.steps[0]!.observations[0]!;
    expect((observation.result as { rows: unknown[][] }).rows).toEqual([['1'], ['3']]);
    const log = info.mock.calls.map(call => String(call[0])).find(line => line.includes('aeeis-csv-date-filter/1'))!;
    expect(JSON.parse(log).filters[0]).toMatchObject({ column: 'due', op: 'lt', passed: 2, nonDateCells: 1, effective: true });
    expect(seen.length).toBeGreaterThan(1);
  });
});
