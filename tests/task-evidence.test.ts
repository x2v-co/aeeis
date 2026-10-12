import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { Artifact, PlanDraft, ProjectPulseArtifact } from '../src/runtime/contracts.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { materialContentHash } from '../src/runtime/materials.js';

type Input = { task: { id: string }; dependencies: Artifact[]; sourceCatalog: Array<{ id: string }>; presentedSources: Array<{ id: string; content: string; contentHash: string; truncated: boolean }>; availableEvidenceRefs: string[]; finishRepair?: { reason: string } };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const oneTask: PlanDraft = { summary: 'Evidence-bound report', nodes: [{ id: 'report', title: 'Report', instruction: 'Summarize the migration', dependsOn: [] }] };
const finish = (refs: string[]) => ({ type: 'finish', title: 'Report', content: 'Migration is blocked.', evidenceRefs: refs });

async function setup(output: (input: Input) => unknown, plan = oneTask, builtinSkill?: 'project-pulse/1') {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-task-evidence-'));
  const repository = new FileRunRepository(directory); await repository.init();
  cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const complete = vi.fn(async (request: ModelRequest) => ({ value: request.system.includes('Plan a real deliverable') ? plan : request.system.includes('Independently review') ? { verdict: 'accepted', summary: 'Verified', issues: [] } : output(request.input as Input) }));
  const model: ModelAdapter = { pin: { model: 'evidence-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, model);
  const run = await engine.create({ goal: 'Summarize migration status', ...(builtinSkill ? { builtinSkill } : {}), materials: [{ title: 'Migration status', source: 'user-input', content: `Migration is blocked. ${'Background. '.repeat(400)}` }] });
  expect(await engine.advance(run.id)).toBe('needs_approval');
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
  return { engine, repository, model, complete, run };
}
async function completeRun(engine: AgentEngine, repository: FileRunRepository, id: string) {
  for (let attempt = 0; attempt < 10; attempt++) if (['succeeded', 'failed'].includes(await engine.advance(id))) break;
  return repository.get(id);
}

describe('task evidence visibility', () => {
  it('allows sources actually presented in the prompt without a redundant sources.read', async () => {
    const { engine, repository, complete, run } = await setup(input => {
      const source = input.presentedSources[0]!;
      expect(source.id).toBe(input.sourceCatalog[0]!.id);
      expect(source.content).toContain('Migration is blocked.');
      expect(source.content).toContain('<external_source');
      expect(source.content.length).toBeLessThan(1500);
      expect(source.truncated).toBe(true);
      const excerpt = source.content.split('\n').slice(1, -1).join('\n');
      expect(source.contentHash).toBe(materialContentHash(excerpt));
      expect(input.availableEvidenceRefs).toContain(source.id);
      return finish([source.id]);
    });
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.steps[0]?.observations).toHaveLength(0);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('lets a synthesis task cite validated evidence refs from the dependency it receives', async () => {
    const plan = { summary: 'Research and synthesis', nodes: [{ ...oneTask.nodes[0]!, id: 'research' }, { ...oneTask.nodes[0]!, dependsOn: ['research'] }] };
    const { engine, repository, run } = await setup(input => {
      const ref = input.sourceCatalog[0]!.id;
      if (input.task.id === 'report') {
        expect(input.dependencies[0]?.evidenceRefs).toEqual([ref]);
        expect(input.availableEvidenceRefs).toEqual(expect.arrayContaining([ref, input.dependencies[0]!.id]));
        return finish([ref, input.dependencies[0]!.id]);
      }
      return finish([ref]);
    }, plan);
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.artifacts[1]?.evidenceRefs).toContain(completed.artifacts[0]!.id);
  });

  it('canonicalizes whitespace, case and known prefixes in both finish and structured refs', async () => {
    const { engine, repository, run } = await setup(input => {
      const ref = input.sourceCatalog[0]!.id;
      const structured: ProjectPulseArtifact = { schemaVersion: 'project-pulse/1', progress: [{ text: 'Migration is blocked.', evidenceRefs: [` source:${ref.toUpperCase()} `] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };
      return { ...finish([` \`${ref}\` `]), artifactType: 'project-pulse/1', structured };
    }, oneTask, 'project-pulse/1');
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.artifacts[0]?.evidenceRefs).toEqual([run.context.sources[0]!.id]);
    expect((completed.artifacts[0]?.structured as ProjectPulseArtifact).progress[0]?.evidenceRefs).toEqual([run.context.sources[0]!.id]);
    const artifact = completed.artifacts[0]!;
    expect(artifact.hash).toBe(digest({ ...finish(artifact.evidenceRefs), artifactType: artifact.artifactType, structured: artifact.structured }));
  });

  it('offers one repair with allowed IDs, and rejects fabricated evidence after that', async () => {
    const { engine, repository, run } = await setup(input => {
      if (input.finishRepair) {
        expect(input.finishRepair.reason).toContain('invented-source');
        expect(input.finishRepair.reason).toContain(input.sourceCatalog[0]!.id);
      }
      return finish(['invented-source']);
    });
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('Artifact cited evidence the task did not receive');
    expect(completed.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(1);
    expect(completed.artifacts).toHaveLength(0);
  });

  it('accepts a repaired citation only after checking it against the same prompt evidence', async () => {
    const { engine, repository, run } = await setup(input => finish(input.finishRepair ? [input.sourceCatalog[0]!.id] : ['invented-source']));
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.artifacts[0]?.evidenceRefs).toEqual([run.context.sources[0]!.id]);
  });

  it('rejects invalid structured citations even when the top-level citation is valid', async () => {
    const { engine, repository, run } = await setup(input => ({ ...finish([input.sourceCatalog[0]!.id]), artifactType: 'project-pulse/1', structured: {
      schemaVersion: 'project-pulse/1', progress: [{ text: 'Unsupported claim', evidenceRefs: ['invented-source'] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [],
    } }), oneTask, 'project-pulse/1');
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('invented-source');
    expect(completed.artifacts).toHaveLength(0);
  });

  it.each(['isolated-output', 'case-collision'] as const)('never treats isolated tool receipts as received evidence (%s)', async mode => {
    let hiddenRef = 'isolated-output';
    const { engine, repository, run } = await setup(input => {
      expect(input.availableEvidenceRefs).not.toContain(hiddenRef);
      return finish([hiddenRef]);
    });
    if (mode === 'case-collision') hiddenRef = run.context.sources[0]!.id.toUpperCase();
    await repository.mutate(run.id, current => { current.toolReceipts.push({
      schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-4000-8000-000000000000', provider: 'fixture', operation: 'fixture.read', requestHash: digest({}), inputRefs: ['report'], outputRefs: [hiddenRef], capabilitiesUsed: ['read'], startedAt: new Date().toISOString(), status: 'completed',
      authorization: { decision: 'isolated', reason: 'cancelled', toolId: 'fixture.read', toolVersion: '1', taskId: 'report', capabilityGrant: 'grant', idempotencyKey: 'key', settledAt: new Date().toISOString() },
    }); });
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.artifacts).toHaveLength(0);
  });

  it('rejects a sibling artifact that was never presented as a dependency', async () => {
    let siblingId = '';
    const plan = { summary: 'Independent tasks', nodes: [{ ...oneTask.nodes[0]!, id: 'sibling' }, oneTask.nodes[0]!] };
    const { engine, repository, run } = await setup(input => {
      if (input.task.id === 'sibling') return finish([input.sourceCatalog[0]!.id]);
      expect(input.dependencies).toEqual([]);
      expect(input.availableEvidenceRefs).not.toContain(siblingId);
      return finish([`artifact:${siblingId.toUpperCase()}`]);
    }, plan);
    await engine.advance(run.id);
    siblingId = (await repository.get(run.id)).artifacts[0]!.id;
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.artifacts[0]?.taskId).toBe('sibling');
  });
});
