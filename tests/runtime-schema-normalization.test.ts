import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Summarize supplied evidence', dependsOn: [] }] };
const fence = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```';

async function runModel(options: { planner?: unknown; executor?: (ref: string) => unknown; reviewer?: unknown; skill?: 'project-pulse/1' | 'website-builder/1' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-schema-'));
  const repository = new FileRunRepository(directory); await repository.init();
  cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const model: ModelAdapter = {
    pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' },
    complete: async request => {
      const input = request.input as { sourceCatalog: Array<{ id: string }> };
      const value = request.system.includes('Plan a real deliverable') ? options.planner ?? plan
        : request.system.includes('Independently review') ? options.reviewer ?? { verdict: 'accepted', summary: 'Verified' }
        : options.executor?.(input.sourceCatalog[0]!.id) ?? { type: 'finish', title: 'Report', content: 'Evidence supports the report.', evidenceRefs: [input.sourceCatalog[0]!.id] };
      return { value, rawOutput: typeof value === 'string' ? value : JSON.stringify(value) };
    },
  };
  const engine = new AgentEngine(repository, model);
  const run = await engine.create({ goal: 'Report', builtinSkill: options.skill, materials: [{ title: 'Brief', source: 'upload', content: 'Evidence supports the report.' }] });
  const proposed = await engine.advance(run.id);
  if (proposed === 'needs_approval') {
    await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
    for (let i = 0; i < 8; i++) if (['succeeded', 'failed'].includes(await engine.advance(run.id))) break;
  }
  return { run: await repository.get(run.id), repository };
}

describe('model schema normalization', () => {
  it.each(['project-pulse/1', 'website-builder/1'] as const)('strips extras and unwraps fenced decisions and %s artifacts', async skill => {
    const { run } = await runModel({
      skill, planner: fence({ plan: JSON.stringify({ ...plan, finishDecision: {} }) }),
      executor: ref => fence({ decision: {
        type: 'finish', title: 'Report', content: 'Evidence supports the report.', evidenceRefs: [ref], extra: 'metadata',
        structured: fence({ artifact: skill === 'project-pulse/1' ? {
          schemaVersion: skill, progress: [{ text: 'Evidence supports the report.', evidenceRefs: [ref], confidence: 1 }],
          completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], extra: true,
        } : { schemaVersion: skill, changedFiles: [], validation: [{ name: 'Evidence check', status: 'passed', evidenceRefs: [ref], extra: true }], artifacts: [], blockers: [], unknowns: [], extra: true } }),
      } }),
      reviewer: fence({ review: JSON.stringify({ verdict: 'APPROVED', summary: 'Verified', extra: 'metadata' }) }),
    });
    expect(run.status, run.error).toBe('succeeded');
    expect(run.artifacts[0]?.structured).not.toHaveProperty('extra');
    expect(run.review).toEqual({ verdict: 'accepted', summary: 'Verified', issues: [] });
  });

  it('normalizes revision verdict and a single issue without accepting the run', async () => {
    const { run } = await runModel({ reviewer: { decision: { verdict: 'Needs Revision', summary: 'Incomplete', issues: 'Missing requirement', extra: true } } });
    expect(run.status).toBe('failed');
    expect(run.review).toEqual({ verdict: 'needs_revision', summary: 'Incomplete', issues: ['Missing requirement'] });
  });

  it.each(['planner', 'reviewer'] as const)('durably stores raw output and validation errors for a %s schema failure', async phase => {
    const bad = phase === 'planner' ? fence({ plan: { summary: 'Invalid wrapped plan' } }) : fence({ review: { verdict: 'accepted or needs_revision', summary: 'Ambiguous review' } });
    const { run, repository } = await runModel(phase === 'planner' ? { planner: bad } : { reviewer: bad });
    expect(run.status).toBe('failed');
    await repository.close(); await repository.init();
    const call = (await repository.get(run.id)).calls.find(call => call.phase === phase)!;
    expect(call.rawOutput).toBe(bad);
    expect(call.validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ path: phase === 'planner' ? 'nodes' : 'verdict' })]));
  });

  it.each(['project-pulse/1', 'website-builder/1'] as const)('still requires all %s sections and evidence citations', async skill => {
    const { run } = await runModel({ skill, executor: ref => ({ type: 'finish', title: 'Report', content: 'Report', evidenceRefs: [ref], artifactType: skill,
      structured: { schemaVersion: skill, progress: [{ text: 'Claim', evidenceRefs: [] }], validation: [{ name: 'Check', status: 'passed', evidenceRefs: [] }], extra: true },
    }) });
    expect(run.status).toBe('failed');
    expect(run.artifacts).toHaveLength(0);
    expect(run.calls.filter(call => call.phase === 'executor').every(call => call.rawOutput && call.validationErrors?.length)).toBe(true);
  });
});
