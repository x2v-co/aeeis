import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { projectRunGraphs } from '../src/runtime/graphs.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-bound-task-'));
  const repository = new FileRunRepository(directory); await repository.init();
  cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const store = new InMemoryStore(); const domain = new AeeisService(store);
  const goal = await domain.createGoal({ title: 'Release' }, undefined, 'alice', 'team-a');
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Verified', issues: [] } };
    return { value: { type: 'finish', title: 'Notes', content: 'Release notes prepared.', evidenceRefs: [] } };
  });
  const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, { model, domain });
  const plan = await domain.createPlan({ goalId: goal.id, nodes: [
    { id: 'notes', title: 'Notes', instruction: 'Write release notes with rollback instructions.' },
    { id: 'verify', title: 'Verify notes', dependsOn: ['notes'] },
    { id: 'other', title: 'Another independent task' },
  ] }, undefined, 'alice', 'team-a');
  const input = { goal: 'Write release notes', goalId: goal.id, taskExecution: { domainPlanId: plan.id, taskId: 'notes' } };
  return { repository, store, domain, goal, plan, model, complete, engine, input };
}
async function approve(engine: AgentEngine, repository: FileRunRepository, id: string) {
  expect(await engine.advance(id)).toBe('needs_approval');
  await engine.command(id, 'approve', { planHash: (await repository.get(id)).plans[0]!.hash });
}

describe('bound domain task execution', () => {
  it('reserves one Run across concurrent engines, lost responses and restarts; rejects changed inputs', async () => {
    const { engine, repository, model, domain, complete, input, plan } = await setup();
    const second = new AgentEngine(repository, { model, domain });
    const results = await Promise.all([engine.create(input, 'alice', 'team-a'), second.create(input, 'alice', 'team-a')]);
    expect(results[0].id).toBe(results[1].id); expect(await repository.list()).toHaveLength(1);
    await expect(second.create({ ...input, privacy: 'public' }, 'alice', 'team-a')).rejects.toThrow('different inputs');
    await approve(engine, repository, results[0].id);
    expect((await repository.get(results[0].id)).plans[0]!.nodes[0]!.instruction).toContain('rollback');
    expect(complete).not.toHaveBeenCalled();
    await second.recover();
    expect((await second.create(input, 'alice', 'team-a')).id).toBe(results[0].id);
    await second.advance(results[0].id); await second.advance(results[0].id);
    expect((await domain.getPlan(plan.id, 'alice', 'team-a')).nodes[1]!.status).toBe('planned');
    expect(await second.advance(results[0].id)).toBe('succeeded');
    expect((await domain.getPlan(plan.id, 'alice', 'team-a')).nodes[1]!.status).toBe('ready');
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('rejects blocked dependencies and cancellation changes only the bound task', async () => {
    const { engine, repository, domain, plan, input } = await setup();
    await expect(engine.create({ ...input, taskExecution: { domainPlanId: plan.id, taskId: 'verify' } }, 'alice', 'team-a')).rejects.toThrow('not ready');
    const run = await engine.create(input, 'alice', 'team-a');
    await engine.command(run.id, 'cancel', {});
    expect((await domain.getPlan(plan.id, 'alice', 'team-a')).nodes.map(node => node.status)).toEqual(['cancelled', 'planned', 'ready']);
    expect((await repository.get(run.id)).calls).toHaveLength(0);
  });

  it('keeps a rejected review from completing the task or unlocking its dependents', async () => {
    const { engine, repository, complete, domain, plan, input } = await setup();
    const run = await engine.create(input, 'alice', 'team-a'); await approve(engine, repository, run.id);
    await engine.advance(run.id); await engine.advance(run.id);
    complete.mockResolvedValueOnce({ value: { verdict: 'needs_revision', summary: 'Missing rollback steps', issues: ['Missing rollback steps'] } });
    expect(await engine.advance(run.id)).toBe('failed');
    expect((await domain.getPlan(plan.id, 'alice', 'team-a')).nodes.map(node => node.status)).toEqual(['failed', 'planned', 'ready']);
    await expect(engine.command(run.id, 'replan', {})).rejects.toThrow('immutable');
  });

  it('recovers an accepted review before domain completion without another billable call', async () => {
    const { engine, repository, model, complete, domain, plan, input } = await setup();
    const run = await engine.create(input, 'alice', 'team-a'); await approve(engine, repository, run.id);
    await engine.advance(run.id); await engine.advance(run.id);
    // A crash after the reviewer response commits but before the Task receipt.
    await repository.mutate(run.id, current => { current.review = { verdict: 'accepted', summary: 'Verified', issues: [] }; });
    const restarted = new AgentEngine(repository, { model, domain });
    await restarted.recover(); await restarted.recover();
    expect((await repository.get(run.id)).status).toBe('succeeded');
    expect((await domain.getSnapshot(plan.id, 'alice', 'team-a')).receipts.filter(receipt => receipt.transition === 'succeed')).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('preserves source identity and origin, rejects privacy downgrade, missing references and cross-tenant evidence', async () => {
    const { engine, repository, domain, goal } = await setup();
    const source = await engine.create({ goal: 'Origin', privacy: 'confidential', materials: [{ title: 'Release fact', source: 'user-input', content: 'Private release date' }] }, 'alice', 'team-a');
    const ref = source.context.sources[0]!.id;
    const plan = await domain.createPlanRevision({ goalId: goal.id, nodes: [{ id: 'follow', title: 'Follow up', evidenceRunId: source.id, evidenceRefs: [ref] }] }, undefined, 'alice', 'team-a');
    const input = { goal: 'Follow up', goalId: goal.id, taskExecution: { domainPlanId: plan.id, taskId: 'follow' } };
    await expect(engine.create(input, 'alice', 'team-a')).rejects.toThrow('privacy');
    const run = await engine.create({ ...input, privacy: 'confidential' }, 'alice', 'team-a');
    expect(run.context.sources[0]).toMatchObject({ id: ref, content: 'Private release date', hash: source.context.sources[0]!.hash, classification: 'confidential', origin: { runId: source.id, ref } });
    expect(projectRunGraphs(run).evidence.nodes[0]?.metadata?.origin).toEqual({ runId: source.id, ref });
    const missing = await domain.createPlanRevision({ goalId: goal.id, nodes: [{ id: 'missing', title: 'Missing evidence', evidenceRunId: source.id, evidenceRefs: ['missing'] }] }, undefined, 'alice', 'team-a');
    await expect(engine.create({ ...input, privacy: 'confidential', taskExecution: { domainPlanId: missing.id, taskId: 'missing' } }, 'alice', 'team-a')).rejects.toThrow('not available');
    const otherGoal = await domain.createGoal({ title: 'Other tenant' }, undefined, 'alice', 'team-b');
    const otherPlan = await domain.createPlan({ goalId: otherGoal.id, nodes: [{ id: 'stolen', title: 'Evidence', evidenceRunId: source.id, evidenceRefs: [ref] }] }, undefined, 'alice', 'team-b');
    await expect(engine.create({ goal: 'Read evidence', goalId: otherGoal.id, privacy: 'confidential', taskExecution: { domainPlanId: otherPlan.id, taskId: 'stolen' } }, 'alice', 'team-b')).rejects.toThrow('Unknown run');
    expect(await repository.list({ owner: 'alice', tenantId: 'team-b' })).toEqual([]);
  });
});
