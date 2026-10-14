import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, baseEvidenceRef, pulseFidelityProblems, sourceLevelRefs, sourceFidelityGuidance } from '../src/runtime/engine.js';
import type { ModelRequest } from '../src/runtime/model.js';
import type { ExecutionLimits } from '../src/runtime/execution-limits.js';

const pulse = (items: Partial<Record<string, unknown[]>> = {}) => ({ schemaVersion: 'project-pulse/1' as const, progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], ...items }) as any;

describe('evidence ref normalization', () => {
  const observed = new Set(['source_a', 'artifact_1']);
  it('maps fragment refs to the observed base id', () => {
    expect(baseEvidenceRef('source_a#row3', observed)).toBe('source_a');
    expect(baseEvidenceRef('source_a:rows 1-4', observed)).toBe('source_a');
    expect(baseEvidenceRef('source_b#row3', observed)).toBe('source_b#row3');
  });
  it('expands intermediate artifacts into their source evidence', () => {
    expect(sourceLevelRefs(['artifact_1', 'source_a'], [{ id: 'artifact_1', evidenceRefs: ['source_a', 'source_c'] }])).toEqual(['source_a', 'source_c']);
  });
});

describe('pulse date fidelity', () => {
  const text = () => '发布截止 10-20，负责人待定';
  it('rejects a year the source never stated', () => {
    expect(pulseFidelityProblems(pulse({ deadlines: [{ text: '发布', date: '2026-10-20', evidenceRefs: ['s'] }] }), text)[0]).toContain('adds a year');
  });
  it('accepts the date as written or a year the source states', () => {
    expect(pulseFidelityProblems(pulse({ deadlines: [{ text: '发布', date: '10-20', evidenceRefs: ['s'] }] }), text)).toEqual([]);
    expect(pulseFidelityProblems(pulse({ deadlines: [{ text: '发布', date: '2026-10-20', evidenceRefs: ['s'] }] }), () => '截止 2026-10-20')).toEqual([]);
  });
  it('guidance requires labelled inference, verbatim dates and source-level refs', () => {
    expect(sourceFidelityGuidance).toContain('推断：');
    expect(sourceFidelityGuidance).toContain('never add a year');
    expect(sourceFidelityGuidance).toContain('do not cite intermediate artifacts');
    expect(sourceFidelityGuidance).toContain('truncated csvQuery result is still valid evidence');
  });
});

const csv = ['team,amount', ...Array.from({ length: 300 }, (_, i) => `${i % 3 ? 'A' : 'B'},${i}`)].join('\n');
async function run(decide: (input: any) => unknown, limits: Partial<ExecutionLimits>, goal = 'Project pulse of team totals') {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'P', nodes: [{ id: 't', title: 'T', instruction: 'Summarize team totals', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'ok' } };
    expect(request.system).toContain('Source fidelity rules');
    return { value: decide(request.input) };
  });
  const engine = new AgentEngine(repository, { model: { pin: { model: 'f', endpoint: 'http://localhost', promptVersion: 't' }, complete }, executionLimits: limits });
  const created = await engine.create({ goal, materials: [{ title: 'big.csv', source: 'upload', content: csv }] }, 'owner', 'local');
  await engine.advance(created.id);
  await engine.command(created.id, 'approve', { planHash: (await repository.get(created.id)).plans[0]!.hash });
  for (let i = 0; i < 16; i++) { const status = await engine.advance(created.id); if (['succeeded', 'failed'].includes(status)) break; }
  return repository.get(created.id);
}

describe('limited-evidence final finish', () => {
  it('drops claims citing unseen evidence, normalizes fragment refs and records the limitation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const completed = await run(input => {
      const id = input.sourceCatalog[0].id;
      if (!input.executionBudget.finalOnly) return { type: 'tool', tool: 'sources.csvQuery', argument: id, select: ['team', 'amount'], limit: 200 };
      return { type: 'finish', title: 'Project Pulse', content: 'Partial pulse.', evidenceRefs: [`${id}#rows`, 'csvQuery_result_1'], artifactType: 'project-pulse/1',
        structured: pulse({ progress: [{ text: 'A leads', evidenceRefs: [`${id}#row3`] }], risks: [{ text: 'made up', evidenceRefs: ['csvQuery_result_1'] }] }) };
    }, { maxNodeSourcePages: 1 });
    expect(completed.status, completed.error).toBe('succeeded');
    const artifact = completed.artifacts[0]!;
    const id = completed.context.sources[0]!.id;
    expect(artifact.evidenceRefs).toEqual([id]);
    expect((artifact.structured as any).progress[0].evidenceRefs).toEqual([id]);
    expect((artifact.structured as any).risks).toEqual([]);
    expect(artifact.limitations?.some(item => item.includes('claim(s) removed'))).toBe(true);
    expect(warn.mock.calls.some(call => String(call[0]).includes('aeeis-finish-evidence-check/1'))).toBe(true);
    warn.mockRestore();
  });

  it('repairs a non-limited pulse finish that invents a year', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const repository = new InMemoryRunRepository();
    const complete = vi.fn(async (request: ModelRequest) => {
      if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'P', nodes: [{ id: 't', title: 'T', instruction: 'Pulse', dependsOn: [] }] } };
      if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'ok' } };
      const ref = (request.input as any).sourceCatalog[0].id; calls++;
      const date = calls === 1 ? '2026-10-20' : '10-20';
      return { value: { type: 'finish', title: 'Project Pulse', content: `发布截止 ${date} [${ref}]`, evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse({ deadlines: [{ text: '发布', date, evidenceRefs: [ref] }] }) } };
    });
    const engine = new AgentEngine(repository, { model: { pin: { model: 'f', endpoint: 'http://localhost', promptVersion: 't' }, complete } });
    const created = await engine.create({ goal: 'Project pulse', materials: [{ title: 'notes.md', source: 'upload', content: '# 计划\n发布截止 10-20' }] }, 'owner', 'local');
    await engine.advance(created.id);
    await engine.command(created.id, 'approve', { planHash: (await repository.get(created.id)).plans[0]!.hash });
    for (let i = 0; i < 16; i++) { const status = await engine.advance(created.id); if (['succeeded', 'failed'].includes(status)) break; }
    const completed = await repository.get(created.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(calls).toBe(2);
    expect(completed.events.some(item => item.type === 'artifact.repair_requested' && String(item.data.reason).includes('adds a year'))).toBe(true);
    expect((completed.artifacts[0]!.structured as any).deadlines[0].date).toBe('10-20');
    warn.mockRestore();
  });
});
