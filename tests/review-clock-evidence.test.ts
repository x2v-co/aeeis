import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, finishContentProblems } from '../src/runtime/engine.js';
import { queryCsvSource } from '../src/runtime/csv-query.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const csv = { id: 's.csv', title: 't.csv', source: 'upload', hash: 'h', content: 'team,v\nA,1\nB,2' };

describe('csvQuery empty optional arrays', () => {
  it.each(['groupBy', 'aggregates', 'orderBy', 'select', 'filters'])('treats %s: [] as omitted', field => {
    const result = queryCsvSource(csv, { [field]: [] }) as { rows: unknown[]; query: Record<string, unknown> };
    expect(result.rows).toHaveLength(2);
    if (field !== 'filters') expect(JSON.parse(JSON.stringify(result.query))).not.toHaveProperty(field);
  });
});

describe('finish content checks', () => {
  const observed = new Set(['source_0a12b038-980c-43dc-8f32-5ee1f3687fa5']);
  it.each(['进度正常 [证据]', 'Done [evidence]', '见【证据】', 'x [source ID]'])('flags placeholder %s', content => {
    expect(finishContentProblems(content, observed)[0]).toContain('placeholder');
  });
  it('flags inline IDs that were never received and accepts real ones', () => {
    expect(finishContentProblems('ok [source_0a12b038-980c-43dc-8f32-5ee1f3687fa5]', observed)).toEqual([]);
    expect(finishContentProblems('bad source_11111111-2222-3333-4444-555555555555', observed)[0]).toContain('not received');
  });
});

describe('executor placeholder repair and reviewer clock', () => {
  it('returns a placeholder finish to the executor, then accepts the corrected one; reviewer sees clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repository = new InMemoryRunRepository();
    let executorCalls = 0, reviewerInput: Record<string, unknown> | undefined, reviewerSystem = '';
    const complete = vi.fn(async (request: ModelRequest) => {
      const input = request.input as Record<string, any>;
      if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'P', nodes: [{ id: 't', title: 'T', instruction: 'Summarize', dependsOn: [] }] } };
      if (request.system.includes('Independently review')) { reviewerInput = input; reviewerSystem = request.system; return { value: { verdict: 'accepted', summary: 'ok' } }; }
      executorCalls++;
      expect(request.system).toContain('推断');
      const ref = input.availableEvidenceRefs[0];
      return { value: { type: 'finish', title: 'R', content: executorCalls === 1 ? '进度正常 [证据]' : `进度正常 [${ref}]\n\n## 推断\n推断：可能按期完成`, evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [{ text: '推断：可能按期完成', evidenceRefs: [ref] }], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] } } };
    });
    const engine = new AgentEngine(repository, { model: { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete } });
    const run = await engine.create({ goal: 'Summarize', materials: [{ title: 'n.md', source: 'upload', content: '# Notes\nOn track.' }] }, 'owner', 'local');
    await engine.advance(run.id);
    await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
    let status = '';
    for (let i = 0; i < 16 && !['succeeded', 'failed'].includes(status); i++) status = await engine.advance(run.id);
    const done = await repository.get(run.id);
    expect(status, done.error).toBe('succeeded');
    expect(executorCalls).toBe(2);
    expect(done.artifacts[0]!.content).not.toContain('[证据]');
    expect((reviewerInput!.clock as { currentDate: string }).currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reviewerSystem).toContain('never flag a missing finish wrapper');
  });
});
