import { afterEach, expect, it, vi } from 'vitest';
import { normalizeArtifactLists } from '../src/runtime/artifact-lists.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => vi.restoreAllMocks());

it('deduplicates normalized text, merges citations and drops clear truncations while retaining short labels', () => {
  const structured = { risks: [
    { text: 'Vendor  delay.', evidenceRefs: ['a'] }, { text: ' VENDOR delay。 ', evidenceRefs: ['b'] },
    { text: 'Migration depends on the', evidenceRefs: ['a'] }, { text: 'Approval is pending…', evidenceRefs: ['a'] },
    { text: 'Delivery could be delayed by vendor confir', evidenceRefs: ['a'] },
    { text: 'Delivery could be delayed by vendor confirmation.', evidenceRefs: ['a'] },
    { text: '供应商可能延期', evidenceRefs: ['a'] }, { text: 'Staffing gap', evidenceRefs: ['a'] },
  ] };
  expect(normalizeArtifactLists(structured)).toEqual({ duplicates: 1, truncated: 3 });
  expect(structured.risks).toEqual([
    { text: 'Vendor  delay.', evidenceRefs: ['a', 'b'] },
    { text: 'Delivery could be delayed by vendor confirmation.', evidenceRefs: ['a'] },
    { text: '供应商可能延期', evidenceRefs: ['a'] }, { text: 'Staffing gap', evidenceRefs: ['a'] },
  ]);
  expect(normalizeArtifactLists(structured)).toEqual({ duplicates: 0, truncated: 0 });
});

it('normalizes structured risk items before validation and hashing in the artifact finalize path', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Risks', nodes: [{ id: 'report', title: 'Report', instruction: 'Report risks', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) {
      expect((request.input as any).artifacts[0].structured.risks).toHaveLength(1);
      return { value: { verdict: 'accepted', summary: 'Grounded risks', issues: [] } };
    }
    const refs = (request.input as any).availableEvidenceRefs;
    return { value: { type: 'finish', title: 'Risks', content: 'Vendor delay is reported.', evidenceRefs: refs, artifactType: 'project-pulse/1', structured: {
      schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [
        'Vendor delay is reported.', { text: '  Vendor delay is reported. ', evidenceRefs: refs }, { text: 'Release depends on the', evidenceRefs: refs },
      ], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [],
    } } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const created = await engine.create({ goal: 'Report project risks', builtinSkill: 'project-pulse/1', materials: [{ title: 'risks.txt', source: 'upload', content: 'Vendor delay is reported.' }] });
  await engine.advance(created.id);
  const planned = await repository.get(created.id);
  await engine.command(created.id, 'approve', { planHash: planned.plans[0]!.hash, planVersion: 1 });
  for (let i = 0; i < 5; i++) if (await engine.advance(created.id) === 'succeeded') break;
  const run = await repository.get(created.id), artifact = run.artifacts[0]!;
  expect(run.status, run.error).toBe('succeeded');
  expect((artifact.structured as any).risks).toEqual([{ text: 'Vendor delay is reported.', evidenceRefs: [run.context.sources[0]!.id] }]);
  expect(artifact.partial).toBe(true);
  expect(artifact.limitations!.join(' ')).toContain('truncated list item');
  expect(artifact.hash).toBe(digest({ type: 'finish', title: artifact.title, content: artifact.content, evidenceRefs: artifact.evidenceRefs, artifactType: artifact.artifactType, structured: artifact.structured, limitations: artifact.limitations }));
  expect(run.events).toContainEqual(expect.objectContaining({ type: 'artifact.lists_normalized', data: expect.objectContaining({ duplicates: 1, truncated: 1 }) }));
  expect(complete).toHaveBeenCalledTimes(3);
});

it('preserves dated entries and separate PDF fields that share the same text', () => {
  const structured = {
    risks: [{ text: 'Plan A', evidenceRefs: ['a'] }, { text: 'Vendor risk', evidenceRefs: ['a'] }, { text: 'Vendor risks', evidenceRefs: ['a'] }],
    deadlines: [{ text: 'Review', date: '2026-10-15' }, { text: 'Review', date: '2026-10-16' }],
    unknowns: [{ field: 'phone', text: 'Not provided', evidenceRefs: ['a'] }, { field: 'email', text: 'Not provided', evidenceRefs: ['a'] }],
  };
  const before = structuredClone(structured);
  expect(normalizeArtifactLists(structured)).toEqual({ duplicates: 0, truncated: 0 });
  expect(structured).toEqual(before);
});
