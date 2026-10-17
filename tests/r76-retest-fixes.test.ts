import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelTimeout, type ModelRequest } from '../src/runtime/model.js';
import { terminalizeRun } from '../src/runtime/terminalize-run.js';
import { populateRunLimitations } from '../src/runtime/run-limitations.js';

const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const plan = { summary: 'Trip', nodes: [
  { id: 'route', title: 'Route', instruction: 'Summarize route', dependsOn: [] },
  { id: 'budget', title: 'Budget, weather and safety contingency', instruction: 'Summarize contingency', dependsOn: ['route'] },
  { id: 'checklist', title: 'Departure checklist', instruction: 'Prepare checklist', dependsOn: ['budget'] },
] };
const pulse = { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function setup(complete: (request: ModelRequest) => Promise<{ value: unknown }>) {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, { model: { pin, complete } });
  const run = await engine.create({ goal: 'Plan a trip', materials: [{ title: 'Notes', source: 'upload', content: 'Route is confirmed.' }] });
  await engine.advance(run.id);
  const planned = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: planned.hash, planVersion: planned.version });
  return { repository, engine, run, async drain() {
    for (let i = 0; i < 12; i++) {
      const current = await repository.get(run.id);
      if (['succeeded', 'failed', 'unknown'].includes(current.status)) return current;
      await engine.advance(run.id);
    }
    throw new Error('Run did not terminate');
  } };
}

it.each(['executor', 'repair'] as const)('r76: %s overall timeout retains completed work and lists missing tasks and review in artifacts and run.partial', async phase => {
  vi.stubEnv('AEEIS_REVIEW_AFTER_STOP', '0');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let executorCalls = 0, repairCalls = 0;
  const fixture = await setup(async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    if (request.system.includes('Independently review')) throw new Error('Review must not be requested');
    const input = request.input as any;
    const ref = input.sourceCatalog[0].id;
    if (input.task.id === 'route') return { value: { type: 'finish', title: 'Route', content: 'Route is confirmed.', evidenceRefs: [ref] } };
    executorCalls++;
    if (input.finishRepair) { repairCalls++; throw new ModelTimeout('Model response timed out after 180000ms (overall timeout)'); }
    if (phase === 'executor') throw new ModelTimeout('Model response timed out after 180000ms (overall timeout)');
    return { value: { type: 'finish', title: 'Contingency', content: 'Unverified claim [source_missing]', evidenceRefs: ['source_missing'], artifactType: 'project-pulse/1', structured: pulse } };
  });
  const run = await fixture.drain();
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.artifacts).toHaveLength(1);
  expect(run.artifacts[0]!.content).toContain('Route is confirmed.');
  const reason = String(run.events.find(event => event.type === 'run.partial')!.data.reason);
  for (const output of [reason, run.artifacts[0]!.content]) {
    expect(output).toContain('Unknown:');
    expect(output).toContain('Budget, weather and safety contingency');
    expect(output).toContain('Departure checklist');
    expect(output).toContain('Independent review was not completed');
  }
  expect(run.events.some(event => event.type === 'run.failed' || event.type === 'model.timeout_retry')).toBe(false);
  expect(executorCalls).toBe(phase === 'repair' ? 2 : 1);
  expect(repairCalls).toBe(phase === 'repair' ? 1 : 0);
  const dropped = run.events.filter(event => event.type === 'artifact.structured_dropped');
  if (phase === 'repair') {
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.data).toMatchObject({ taskId: 'budget', reason: expect.stringContaining('repair timed out') });
    expect(run.artifacts.every(artifact => artifact.structured === undefined)).toBe(true);
  } else expect(dropped).toHaveLength(0);
});

it('r76: an executor overall timeout with no previous work never retries the task', async () => {
  let executorCalls = 0;
  const fixture = await setup(async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    executorCalls++;
    throw new ModelTimeout('Model response timed out after 180000ms (overall timeout)');
  });
  const run = await fixture.drain();
  expect(run.status).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(executorCalls).toBe(1);
  expect(run.events.some(event => event.type === 'model.timeout_retry')).toBe(false);
  expect(run.artifacts[0]!.content).not.toContain('after one retry');
  expect(run.artifacts[0]!.content).toContain('Unknown:');
  expect(String(run.events.find(event => event.type === 'run.partial')!.data.reason)).toContain('Departure checklist');
});

it('r76: workflow terminalization adds explicit Unknown gaps without duplicating the section on repeated updates', async () => {
  const fixture = await setup(async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    const input = request.input as any;
    return { value: { type: 'finish', title: 'Route', content: 'Route is confirmed.', evidenceRefs: [input.sourceCatalog[0].id] } };
  });
  await fixture.engine.advance(fixture.run.id);
  const run = await terminalizeRun(fixture.repository, fixture.run.id, 'Workflow deadline reached');
  const before = run.artifacts[0]!.content;
  populateRunLimitations(run);
  populateRunLimitations(run);
  expect(run.status).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.artifacts[0]!.content).toBe(before);
  expect(before.match(/Unknown:/g)).toHaveLength(1);
  for (const text of [before, String(run.events.find(event => event.type === 'run.partial')!.data.reason)]) {
    expect(text).toContain('Unknown:');
    expect(text).toContain('Budget, weather and safety contingency');
    expect(text).toContain('Independent review was not completed');
  }
});

it('r76: a normally completed partial answer lists source gaps after accepted independent review', async () => {
  const fixture = await setup(async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Honest gaps', issues: [] } };
    const input = request.input as any;
    const ref = input.sourceCatalog[0].id;
    return { value: { type: 'finish', title: input.task.title, content: 'Route is confirmed.', evidenceRefs: [ref],
      limitations: ['Budget range is not provided by the source.'] } };
  });
  const run = await fixture.drain();
  expect(run.status, run.error).toBe('succeeded');
  expect(run.partial).toBe(true);
  expect(run.review?.verdict).toBe('accepted');
  for (const artifact of run.artifacts) {
    expect(artifact.content).toContain('Unknown:');
    expect(artifact.content).toContain('Budget range is not provided');
    expect(artifact.content).not.toContain('Independent review was not completed');
  }
});

it('r76: reviewing retained output updates the Unknown section to the actual review result', async () => {
  vi.stubEnv('AEEIS_REVIEW_AFTER_STOP', '1');
  const fixture = await setup(async request => {
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Retained route verified', issues: [] } };
    const input = request.input as any;
    if (input.task.id !== 'route') throw new ModelTimeout('Model response timed out after 180000ms (overall timeout)');
    return { value: { type: 'finish', title: 'Route', content: 'Route is confirmed.', evidenceRefs: [input.sourceCatalog[0].id] } };
  });
  const run = await fixture.drain();
  expect(run.status, run.error).toBe('succeeded');
  expect(run.review?.verdict).toBe('accepted');
  expect(run.artifacts[0]!.content).toContain('Unknown:');
  expect(run.artifacts[0]!.content).toContain('Budget, weather and safety contingency');
  expect(run.artifacts[0]!.content).not.toContain('Independent review was not completed');
  expect(run.events.some(event => event.type === 'model.timeout_retry')).toBe(false);
});
