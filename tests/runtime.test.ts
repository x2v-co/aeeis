import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelPin } from '../src/runtime/contracts.js';
import type { SkillGovernance, ToolGateway, ToolInvocation, ToolResult } from '../src/integrations.js';
import { AgentDirectory, AgentGateway } from '../src/agent-gateway.js';
import type { AgentCard } from '../src/protocol.js';
import { InMemoryKnowledgeProvider, makeKnowledgeRecord } from '../src/knowledge.js';
import { GovernedBrain } from '../src/brain.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { FileEvolutionActivationStore } from '../src/evolution-activation.js';

const pin: ModelPin = { model: 'fixture-model', endpoint: 'http://127.0.0.1:9999/chat/completions', promptVersion: 'fixture/1' };

class PlanningFixture implements ModelAdapter {
  readonly pin = pin;
  readonly calls: ModelRequest[] = [];
  async complete(request: ModelRequest) {
    this.calls.push(request);
    if (request.system.includes('Plan a real deliverable')) {
      return { value: { summary: 'Research and synthesize the supplied brief', nodes: [
        { id: 'research', title: 'Research the brief', instruction: 'Read the supplied source and extract facts', dependsOn: [] },
        { id: 'synthesize', title: 'Synthesize a report', instruction: 'Produce the final report', dependsOn: ['research'] },
      ] } };
    }
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Evidence supports the report', issues: [] } };
    const input = request.input as { task: { id: string }; observations: Array<{ result: unknown }>; dependencies: Array<{ id: string }>; sourceCatalog: Array<{ id: string }> };
    const sourceId = input.sourceCatalog[0]!.id;
    if (input.task.id === 'research' && input.observations.length === 0) return { value: { type: 'tool', tool: 'sources.read', argument: sourceId } };
    if (input.task.id === 'research') return { value: { type: 'finish', title: 'Research notes', content: 'The source says to ship safely.', evidenceRefs: [sourceId] } };
    return { value: { type: 'finish', title: 'Final report', content: 'The report recommends shipping safely.', evidenceRefs: input.dependencies.map(d => d.id) } };
  }
}

class RevisionFixture implements ModelAdapter {
  readonly pin = pin;
  plannerCalls = 0;
  reviewerCalls = 0;
  async complete(request: ModelRequest) {
    if (request.system.includes('Plan a real deliverable')) {
      this.plannerCalls += 1;
      return { value: this.plannerCalls === 1
        ? { summary: 'Initial plan', nodes: [{ id: 'draft', title: 'Draft', instruction: 'Draft', dependsOn: [] }] }
        : { summary: 'Revised plan', nodes: [{ id: 'research', title: 'Research', instruction: 'Research', dependsOn: [] }, { id: 'synthesize', title: 'Synthesize', instruction: 'Synthesize', dependsOn: ['research'] }] } };
    }
    if (request.system.includes('Independently review')) {
      this.reviewerCalls += 1;
      return { value: this.reviewerCalls === 1
        ? { verdict: 'needs_revision', summary: 'The plan needs a second research step', issues: ['Add independent research'] }
        : { verdict: 'accepted', summary: 'Revised plan is supported', issues: [] } };
    }
    const input = request.input as { task: { id: string }; sourceCatalog: Array<{ id: string }> ; dependencies: Array<{ id: string }> };
    return { value: { type: 'finish', title: input.task.id, content: `Completed ${input.task.id}`, evidenceRefs: input.dependencies.length ? input.dependencies.map(item => item.id) : input.sourceCatalog.map(item => item.id) } };
  }
}

class DefiniteFailureFixture implements ModelAdapter {
  readonly pin = pin;
  async complete(request: ModelRequest) {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Failure plan', nodes: [{ id: 'operate', title: 'Operate', instruction: 'Operate', dependsOn: [] }] } };
    throw new Error('Provider rejected the executor request');
  }
}

class UnknownPlanningFixture implements ModelAdapter {
  readonly pin = pin;
  readonly calls: ModelRequest[] = [];
  private first = true;
  async complete(request: ModelRequest) {
    this.calls.push(request);
    if (this.first) { this.first = false; throw new ModelOutcomeUnknown('Provider may have completed'); }
    return { value: { summary: 'Recovered plan', nodes: [{ id: 'one', title: 'One', instruction: 'Produce a result', dependsOn: [] }] } };
  }
}

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-runtime-'));
  const repo = new FileRunRepository(directory);
  await repo.init();
  return repo;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const oneTaskPlan = { summary: 'Specific fixture task', nodes: [{ id: 'one', title: 'One', instruction: 'Produce a result', dependsOn: [] }] };

class CapabilityFixture implements ModelAdapter {
  readonly pin = pin;
  calls = 0;
  async complete(request: ModelRequest) {
    this.calls++;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Use a registered capability', nodes: [{ id: 'operate', title: 'Operate', instruction: 'Call the approved tool and report', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Receipt-backed result accepted', issues: [] } };
    const input = request.input as { observations: Array<unknown> };
    if (input.observations.length === 0) return { value: { type: 'capability', toolId: 'fixture.lookup', toolVersion: '1', input: { key: 'status' }, purpose: 'Read the approved fixture status' } };
    return { value: { type: 'finish', title: 'Tool-backed report', content: 'The approved tool returned a verified status.', evidenceRefs: [] } };
  }
}

class CapabilityGateway implements ToolGateway {
  requests: ToolInvocation[] = [];
  async listTools() { return [{ id: 'fixture.lookup', version: '1', capabilities: ['read'], inputSchema: {}, outputSchema: {} }]; }
  async invoke(request: ToolInvocation): Promise<ToolResult> {
    this.requests.push(request);
    return {
      status: 'completed',
      output: { status: 'green' },
      outputRefs: ['tool-output-1'],
      receipt: {
        schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-0000-0000-000000000001',
        provider: 'fixture-toolkit', operation: request.toolId, requestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        inputRefs: [request.taskId], outputRefs: ['tool-output-1'], capabilitiesUsed: ['read'],
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: 'completed',
      },
    };
  }
}

class ReconcileGateway extends CapabilityGateway {
  invokes = 0;
  reconciles = 0;
  async invoke(request: ToolInvocation): Promise<ToolResult> {
    this.invokes++;
    return { status: 'unknown', receipt: {
      schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-0000-0000-000000000002',
      provider: 'fixture-toolkit', operation: request.toolId, requestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      inputRefs: [request.taskId], outputRefs: [], capabilitiesUsed: ['read'],
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: 'unknown',
    } };
  }
  async reconcile(request: ToolInvocation, receipt: ToolResult['receipt']): Promise<ToolResult> {
    this.reconciles++;
    return { status: 'completed', output: { status: 'green' }, outputRefs: ['tool-output-reconciled'], receipt: { ...receipt, status: 'completed', responseHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', outputRefs: ['tool-output-reconciled'] } };
  }
}

class SkillFixture implements SkillGovernance {
  readonly resolved = { methodId: 'project-pulse', version: '2', plan: { steps: ['inspect', 'synthesize'] }, receiptRef: 'skill-receipt-1' };
  readonly records: Array<{ outcome: string; evidence: string[] }> = [];
  async resolve() { return this.resolved; }
  async record(input: { task: string; outcome: 'success' | 'failure'; correction?: string; summary: string; evidence: string[]; runtime?: string }) { this.records.push({ outcome: input.outcome, evidence: input.evidence }); return { receiptRef: 'skill-record-1' }; }
  async propose() { return []; }
  async apply() { return { methodId: 'project-pulse', version: '2' }; }
  async rollback() { return { methodId: 'project-pulse', version: '1' }; }
}

class DelegationFixture implements ModelAdapter {
  readonly pin = pin;
  async complete(request: ModelRequest) {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Delegate bounded research', nodes: [{ id: 'delegate', title: 'Delegate research', instruction: 'Ask the admitted Agent for a candidate', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Delegated result accepted', issues: [] } };
    const input = request.input as { observations: Array<unknown> };
    if (input.observations.length === 0) return { value: { type: 'delegate', agentId: 'agent.partner', goal: 'Provide a bounded research candidate', expectedOutput: 'research/1' } };
    return { value: { type: 'finish', title: 'Delegated report', content: 'The delegated candidate was reviewed.', evidenceRefs: [] } };
  }
}

describe('AEEIS runtime', () => {
  it('does not accept a Goal reference without the Goal domain service', async () => {
    const repo = await repository();
    const engine = new AgentEngine(repo, new PlanningFixture());
    await expect(engine.create({ goal: 'Detached', goalId: 'goal_missing' })).rejects.toThrow('domain service');
    await repo.close();
  });

  it('links a Goal run to a durable domain Plan and task receipts', async () => {
    const repo = await repository();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-domain-runtime-')), 'domain.json'));
    await domainStore.init();
    const domain = new AeeisService(domainStore);
    const goal = await domain.createGoal({ title: 'Assess this release' });
    const engine = new AgentEngine(repo, { model: new PlanningFixture(), domain });
    const run = await engine.create({ goal: goal.title, goalId: goal.id, materials: [{ title: 'Brief', source: 'fixture', content: 'The source says to ship safely.' }] });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    const proposed = await repo.get(run.id);
    expect(proposed.domainPlanId).toBeDefined();
    expect((await domain.listPlans(goal.id))[0]?.nodes.map(node => node.id)).toEqual(['research', 'synthesize']);
    await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash });
    for (let i = 0; i < 10; i += 1) {
      const status = await engine.advance(run.id);
      if (['succeeded', 'failed'].includes(status)) break;
    }
    const snapshot = await domain.getSnapshot((await domain.listPlans(goal.id))[0]!.id);
    expect(snapshot.receipts.map(receipt => receipt.to)).toEqual(['running', 'succeeded', 'running', 'succeeded']);
    expect(snapshot.plan.nodes.every(node => node.status === 'succeeded')).toBe(true);
    await repo.close();
  });

  it('replans a failed review into a new runtime and domain Plan version', async () => {
    const repo = await repository();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-domain-replan-')), 'domain.json'));
    await domainStore.init();
    const domain = new AeeisService(domainStore);
    const goal = await domain.createGoal({ title: 'Revise this release plan' });
    const model = new RevisionFixture();
    const engine = new AgentEngine(repo, { model, domain });
    const run = await engine.create({ goal: goal.title, goalId: goal.id, materials: [{ title: 'Brief', source: 'fixture', content: 'Evidence' }] });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    let current = await repo.get(run.id);
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    for (let index = 0; index < 8; index += 1) {
      const status = await engine.advance(run.id);
      if (['succeeded', 'failed'].includes(status)) break;
    }
    expect((await repo.get(run.id)).status).toBe('failed');
    await engine.command(run.id, 'replan', { reason: 'Address review issue' });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    current = await repo.get(run.id);
    expect(current.plans.map(plan => plan.version)).toEqual([1, 2]);
    expect(current.events.map(item => item.type)).toContain('plan.revision_requested');
    expect((await domain.listPlans(goal.id)).map(plan => plan.version)).toEqual([2, 1]);
    expect(model.plannerCalls).toBe(2);
    await repo.close();
  });

  it('synchronizes failed executor state into the domain Task receipt', async () => {
    const repo = await repository();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-domain-failure-')), 'domain.json'));
    await domainStore.init();
    const domain = new AeeisService(domainStore);
    const goal = await domain.createGoal({ title: 'Keep domain state aligned' });
    const engine = new AgentEngine(repo, { model: new DefiniteFailureFixture(), domain });
    const run = await engine.create({ goal: goal.title, goalId: goal.id });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    let current = await repo.get(run.id);
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    expect(await engine.advance(run.id)).toBe('failed');
    current = await repo.get(run.id);
    const plan = (await domain.listPlans(goal.id)).find(item => item.id === current.domainPlanId)!;
    expect(plan.nodes[0]?.status).toBe('failed');
    expect((await domain.getSnapshot(plan.id)).receipts.map(receipt => receipt.to)).toEqual(['running', 'failed']);
    await repo.close();
  });

  it('generates a dynamic plan, requires exact approval, executes with evidence, and reviews it', async () => {
    const repo = await repository();
    const model = new PlanningFixture();
    const engine = new AgentEngine(repo, model);
    const run = await engine.create({ goal: 'Assess this release', materials: [{ title: 'Brief', source: 'fixture', content: 'The source says to ship safely.' }] });
    expect((await engine.advance(run.id))).toBe('needs_approval');
    let current = await repo.get(run.id);
    expect(current.plans[0]?.nodes).toHaveLength(2);
    expect(current.calls.some(call => call.phase === 'executor')).toBe(false);
    await expect(engine.command(run.id, 'approve', { planHash: 'wrong' })).rejects.toThrow('match');
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    for (let i = 0; i < 10; i += 1) {
      const status = await engine.advance(run.id);
      if (['succeeded', 'failed'].includes(status)) break;
    }
    current = await repo.get(run.id);
    expect(current.status).toBe('succeeded');
    expect(current.artifacts.map(a => a.title)).toEqual(['Research notes', 'Final report']);
    expect(current.review?.verdict).toBe('accepted');
    expect(current.events.map(e => e.type)).toContain('tool.completed');
    expect(model.calls.filter(call => call.system.includes('Plan a real deliverable'))).toHaveLength(1);
    await repo.close();
  });

  it('snapshots an activated RSI prompt into new Runs and leaves existing Runs unchanged', async () => {
    const repo = await repository();
    const evolutionDirectory = await mkdtemp(join(tmpdir(), 'aeeis-runtime-evolution-'));
    const evolution = new FileEvolutionRepository(evolutionDirectory); await evolution.init();
    const activation = new FileEvolutionActivationStore(evolutionDirectory); await activation.init();
    const rsi = new RsiService(evolution, activation);
    const candidate = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite every claim with an evidence reference.', sourceReceiptRefs: ['receipt.rsi.1'], reason: 'Review found an unsupported claim', risk: 'low' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await rsi.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: [`evidence.${kind}`] });
    await rsi.approve(candidate.id, 'approval.rsi.1'); await rsi.promote(candidate.id); await rsi.activate(candidate.id, 'activation.rsi.1');
    const model = new PlanningFixture();
    const engine = new AgentEngine(repo, { model, evolution: rsi });
    const run = await engine.create({ goal: 'Use activated policy' });
    expect(run.evolution?.[0]).toMatchObject({ candidateId: candidate.id, version: 'prompt/2' });
    expect(run.events.map(item => item.type)).toContain('evolution.snapshot');
    await engine.advance(run.id);
    expect(model.calls[0]?.system).toContain('Cite every claim with an evidence reference');
    await rsi.rollback(candidate.id, 'Activate the baseline after validation');
    const next = await engine.create({ goal: 'Use baseline policy' });
    expect(next.evolution).toBeUndefined();
    await activation.close(); await evolution.close(); await repo.close();
  });

  it('serializes concurrent mutations and preserves revisions on disk', async () => {
    const repo = await repository();
    const engine = new AgentEngine(repo, new PlanningFixture());
    const run = await engine.create({ goal: 'Concurrent writes' });
    await Promise.all(Array.from({ length: 12 }, (_, index) => repo.mutate(run.id, current => {
      current.error = `write-${index}`;
    })));
    const current = await repo.get(run.id);
    expect(current.revision).toBe(12);
    expect(current.error).toMatch(/^write-/);
    await repo.close();
  });

  it('reserves one request under concurrent ticks and discards a cancelled result', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>();
    const entered = deferred<void>();
    let requests = 0;
    const engine = new AgentEngine(repo, { pin, complete: async () => { requests++; entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Cancellation' });
    const tick = engine.advance(run.id);
    await entered.promise;
    await Promise.all([engine.advance(run.id), engine.advance(run.id)]);
    expect(requests).toBe(1);
    await engine.command(run.id, 'cancel', {});
    response.resolve({ value: oneTaskPlan });
    expect(await tick).toBe('cancelled');
    const current = await repo.get(run.id);
    expect(current.plans).toEqual([]);
    expect(current.calls[0]?.state).toBe('discarded');
    await repo.close();
  });

  it('checkpoints a plan returned while paused and resumes into approval', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>(), entered = deferred<void>();
    const engine = new AgentEngine(repo, { pin, complete: async () => { entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Pause' });
    const tick = engine.advance(run.id); await entered.promise;
    await engine.command(run.id, 'pause', {});
    response.resolve({ value: oneTaskPlan });
    expect(await tick).toBe('paused');
    expect((await repo.get(run.id)).resumeStatus).toBe('needs_approval');
    expect((await engine.command(run.id, 'resume', {})).status).toBe('needs_approval');
    await repo.close();
  });

  it('requires reconciliation after ambiguous transport failure, including a paused call', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>(), entered = deferred<void>();
    const engine = new AgentEngine(repo, { pin, complete: async () => { entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Unknown outcome' });
    const tick = engine.advance(run.id); await entered.promise;
    await engine.command(run.id, 'pause', {});
    response.reject(new ModelOutcomeUnknown('Provider may have completed'));
    expect(await tick).toBe('unknown');
    await expect(engine.command(run.id, 'retry', {})).rejects.toThrow('reconciliation');
    expect(await engine.advance(run.id)).toBe('unknown');
    expect((await repo.get(run.id)).calls).toHaveLength(1);
    expect((await engine.command(run.id, 'reconcile', { reason: 'Checked provider status and authorize another call' })).status).toBe('queued');
    await repo.close();
  });

  it('reuses the same model call and provider idempotency key after reconciliation', async () => {
    const repo = await repository();
    const model = new UnknownPlanningFixture();
    const engine = new AgentEngine(repo, model);
    const run = await engine.create({ goal: 'Recover the planning request' });
    expect(await engine.advance(run.id)).toBe('unknown');
    const interrupted = (await repo.get(run.id)).calls[0]!;
    expect(interrupted.state).toBe('unknown');
    expect(interrupted.idempotencyKey).toBe(`model:${run.id}:${interrupted.id}`);
    await engine.command(run.id, 'reconcile', { reason: 'Provider status checked; retry is authorized' });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    const recovered = (await repo.get(run.id)).calls;
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe(interrupted.id);
    expect(recovered[0]?.idempotencyKey).toBe(interrupted.idempotencyKey);
    expect(recovered[0]?.state).toBe('completed');
    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.idempotencyKey).toBe(model.calls[1]?.idempotencyKey);
    await repo.close();
  });

  it('preserves a definite failure received while paused instead of silently retrying on resume', async () => {
    const repo = await repository();
    const response = deferred<{ value: unknown }>(), entered = deferred<void>();
    const engine = new AgentEngine(repo, { pin, complete: async () => { entered.resolve(); return response.promise; } });
    const run = await engine.create({ goal: 'Pause and fail' });
    const tick = engine.advance(run.id); await entered.promise;
    await engine.command(run.id, 'pause', {});
    response.reject(new Error('Model provider returned HTTP 401'));
    expect(await tick).toBe('paused');
    expect((await engine.command(run.id, 'resume', {})).status).toBe('failed');
    await repo.close();
  });

  it('recovers interrupted reservations without resending the request', async () => {
    const repo = await repository();
    const model = new PlanningFixture(), engine = new AgentEngine(repo, model);
    const run = await engine.create({ goal: 'Restart recovery' });
    await repo.mutate(run.id, current => {
      current.status = 'planning';
      current.calls.push({ id: 'interrupted-call', phase: 'planner', state: 'started', inputHash: 'hash', startedAt: new Date().toISOString() });
    });
    await engine.recover();
    expect(await engine.advance(run.id)).toBe('unknown');
    expect(model.calls).toEqual([]);
    await repo.close();
  });

  it('runs an approved external capability and persists its receipt before finishing', async () => {
    const repo = await repository();
    const model = new CapabilityFixture();
    const tools = new CapabilityGateway();
    const engine = new AgentEngine(repo, { model, tools });
    const run = await engine.create({ goal: 'Check service status', allowedTools: ['fixture.lookup'], materials: [] });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    let current = await repo.get(run.id);
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    for (let i = 0; i < 20; i++) {
      const status = await engine.advance(run.id);
      if (status === 'succeeded' || status === 'failed') break;
    }
    current = await repo.get(run.id);
    expect(current.status).toBe('succeeded');
    expect(tools.requests[0]?.idempotencyKey).toContain(run.id);
    expect(current.toolReceipts).toHaveLength(1);
    expect(current.events.map(item => item.type)).toContain('tool.requested');
    await repo.close();
  });

  it('denies a capability that was not approved for the run', async () => {
    const repo = await repository();
    const engine = new AgentEngine(repo, { model: new CapabilityFixture(), tools: new CapabilityGateway() });
    const run = await engine.create({ goal: 'Denied capability' });
    await engine.advance(run.id);
    const current = await repo.get(run.id);
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    expect(await engine.advance(run.id)).toBe('failed');
    expect((await repo.get(run.id)).error).toContain('allowedTools');
    await repo.close();
  });

  it('reconciles an unknown external tool outcome without invoking it twice', async () => {
    const repo = await repository();
    const model = new CapabilityFixture();
    const tools = new ReconcileGateway();
    const engine = new AgentEngine(repo, { model, tools });
    const run = await engine.create({ goal: 'Reconcile tool status', allowedTools: ['fixture.lookup@1'] });
    expect((await repo.get(run.id)).approvedTools?.[0]?.version).toBe('1');
    expect(await engine.advance(run.id)).toBe('needs_approval');
    let current = await repo.get(run.id);
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    expect(await engine.advance(run.id)).toBe('running');
    expect(await engine.advance(run.id)).toBe('unknown');
    expect(tools.invokes).toBe(1);
    await expect(engine.command(run.id, 'retry', {})).rejects.toThrow('reconciliation');
    expect((await engine.command(run.id, 'reconcile', { reason: 'Checked provider idempotency record' })).status).toBe('running');
    expect(await engine.advance(run.id)).toBe('running');
    expect(tools.reconciles).toBe(1);
    for (let i = 0; i < 10; i++) { const status = await engine.advance(run.id); if (status === 'succeeded' || status === 'failed') break; }
    current = await repo.get(run.id);
    expect(current.status).toBe('succeeded');
    expect(current.events.some(event => event.type === 'tool.reconciled')).toBe(true);
    await repo.close();
  });

  it('passes the governed Skill plan into model context and records the final outcome', async () => {
    const repo = await repository();
    const skills = new SkillFixture();
    const model = new PlanningFixture();
    const engine = new AgentEngine(repo, { model, skills });
    const run = await engine.create({ goal: 'Use the governed method', skillRuntime: 'aeeis-test', materials: [{ title: 'Brief', source: 'fixture', content: 'Ship safely.' }] });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    let current = await repo.get(run.id);
    await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    for (let i = 0; i < 20; i++) { const status = await engine.advance(run.id); if (status === 'succeeded' || status === 'failed') break; }
    current = await repo.get(run.id);
    expect(current.status).toBe('succeeded');
    expect(current.skillSelection?.version).toBe('2');
    expect(current.skillOutcome?.receiptRef).toBe('skill-record-1');
    expect(skills.records).toEqual([{ outcome: 'success', evidence: current.artifacts.map(item => item.id) }]);
    const plannerInput = model.calls.find(call => call.system.includes('Plan a real deliverable'))?.input as { skill?: { methodId: string; version: string } };
    expect(plannerInput.skill).toMatchObject({ methodId: 'project-pulse', version: '2' });
    await repo.close();
  });

  it('executes an admitted external Agent through a task-scoped Context Pack and Grant', async () => {
    const repo = await repository();
    const card: AgentCard = { schemaVersion: 'agent-card/1', agentId: 'agent.partner', name: 'Partner', owner: 'partner', protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'], auth: ['local'], privacy: { dataRetention: 'session', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1' };
    const directory = new AgentDirectory(); directory.register(card);
    let receivedGrant = '';
    const agents = new AgentGateway(directory, { submit: async (_card, request) => { receivedGrant = request.grant.grantId; return { status: 'completed', receiptRef: 'receipt.partner', acknowledgement: { schemaVersion: 'context-ack/1', taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true }, result: { schemaVersion: 'result-envelope/1', taskId: request.taskBrief.taskId, agentId: request.agentId, status: 'completed', resultType: 'research/1', summary: 'candidate', claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: request.contextPack.id, receiptRef: 'receipt.partner' } }; } });
    const engine = new AgentEngine(repo, { model: new DelegationFixture(), agents });
    const run = await engine.create({ goal: 'Use a partner Agent', allowedAgents: ['agent.partner'] });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    let current = await repo.get(run.id); await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    expect(await engine.advance(run.id)).toBe('running');
    current = await repo.get(run.id);
    expect(current.pendingDelegation?.agentId).toBe('agent.partner');
    expect(await engine.advance(run.id)).toBe('running');
    current = await repo.get(run.id);
    expect(current.pendingDelegation).toBeUndefined();
    expect(current.delegationOutcomes?.[0]?.status).toBe('completed');
    expect(receivedGrant).toContain('grant_');
    for (let i = 0; i < 10; i++) { const status = await engine.advance(run.id); if (status === 'succeeded' || status === 'failed') break; }
    expect((await repo.get(run.id)).status).toBe('succeeded');
    await repo.close();
  });

  it('persists an asynchronously accepted Agent delegation until reconciliation', async () => {
    const repo = await repository();
    const card: AgentCard = { schemaVersion: 'agent-card/1', agentId: 'agent.partner', name: 'Partner', owner: 'partner', protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'], auth: ['local'], privacy: { dataRetention: 'session', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1' };
    const directory = new AgentDirectory(); directory.register(card);
    const agents = new AgentGateway(directory, {
      submit: async (_card, request) => ({ status: 'accepted', receiptRef: 'receipt.accepted', acknowledgement: { schemaVersion: 'context-ack/1' as const, taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true } }),
      reconcile: async (_card, request) => ({ status: 'completed' as const, receiptRef: 'receipt.async-complete', acknowledgement: { schemaVersion: 'context-ack/1' as const, taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true }, result: { schemaVersion: 'result-envelope/1' as const, taskId: request.taskBrief.taskId, agentId: request.agentId, status: 'completed' as const, resultType: 'research/1', summary: 'async complete', claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: request.contextPack.id, receiptRef: 'receipt.async-complete' } }),
    });
    const run = await new AgentEngine(repo, { model: new DelegationFixture(), agents }).create({ goal: 'Use an asynchronous partner Agent', allowedAgents: ['agent.partner'] });
    const engine = new AgentEngine(repo, { model: new DelegationFixture(), agents });
    await engine.advance(run.id); let current = await repo.get(run.id); await engine.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    await engine.advance(run.id);
    expect(await engine.advance(run.id)).toBe('waiting_external');
    current = await repo.get(run.id);
    expect(current.pendingDelegation?.receiptRef).toBe('receipt.accepted');
    expect(current.delegationOutcomes?.at(-1)?.status).toBe('accepted');
    await engine.command(run.id, 'reconcile', { reason: 'Provider reports the asynchronous task is complete' });
    expect(await engine.advance(run.id)).toBe('running');
    expect((await repo.get(run.id)).pendingDelegation).toBeUndefined();
    await repo.close();
  });

  it('reconciles a pending external Agent after a Runtime restart', async () => {
    const repo = await repository();
    const card: AgentCard = { schemaVersion: 'agent-card/1', agentId: 'agent.partner', name: 'Partner', owner: 'partner', protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'], auth: ['local'], privacy: { dataRetention: 'session', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1' };
    const directory = new AgentDirectory(); directory.register(card);
    const unknownTransport = { submit: async () => ({ status: 'unknown' as const, receiptRef: 'receipt.pending' }) };
    const firstGateway = new AgentGateway(directory, unknownTransport);
    const first = new AgentEngine(repo, { model: new DelegationFixture(), agents: firstGateway });
    const run = await first.create({ goal: 'Recover delegated work', allowedAgents: ['agent.partner'] });
    await first.advance(run.id); let current = await repo.get(run.id); await first.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    await first.advance(run.id); expect(await first.advance(run.id)).toBe('unknown');
    const unknownCurrent = await repo.get(run.id);
    const recoveredGateway = new AgentGateway(directory, { submit: async () => ({ status: 'unknown' as const, receiptRef: 'unused' }), reconcile: async (_card, request, receipt) => ({ status: 'completed' as const, receiptRef: 'receipt.after-restart', acknowledgement: { schemaVersion: 'context-ack/1' as const, taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true }, result: { schemaVersion: 'result-envelope/1' as const, taskId: request.taskBrief.taskId, agentId: 'agent.partner', status: 'completed' as const, resultType: 'research/1', summary: 'reconciled', claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: request.contextPack.id, receiptRef: 'receipt.after-restart' } }) });
    const recovered = new AgentEngine(repo, { model: new DelegationFixture(), agents: recoveredGateway });
    expect((await recovered.command(run.id, 'reconcile', { reason: 'Recovered provider receipt after restart' })).status).toBe('running');
    const recoveredStatus = await recovered.advance(run.id);
    expect(recoveredStatus).toBe('running');
    expect((await repo.get(run.id)).delegationOutcomes?.at(-1)?.receiptRef).toBe('receipt.after-restart');
    await repo.close();
  });

  it('turns an interrupted pending Tool into an unknown receipt during recovery', async () => {
    const repo = await repository();
    const tools: ToolGateway = {
      listTools: async () => [{ id: 'fixture.lookup', version: '1', capabilities: ['read'], inputSchema: {}, outputSchema: {} }],
      invoke: async () => { throw new Error('must reconcile after restart'); },
      reconcile: async (_request, receipt) => ({ status: 'completed', output: { recovered: true }, outputRefs: ['recovered.output'], receipt: { ...receipt, status: 'completed', completedAt: new Date().toISOString(), responseHash: 'c'.repeat(64), outputRefs: ['recovered.output'] } }),
    };
    const first = new AgentEngine(repo, { model: new CapabilityFixture(), tools });
    const run = await first.create({ goal: 'Recover tool call', allowedTools: ['fixture.lookup'] });
    await first.advance(run.id); let current = await repo.get(run.id); await first.command(run.id, 'approve', { planHash: current.plans[0]!.hash });
    await first.advance(run.id);
    await repo.mutate(run.id, saved => { saved.status = 'running'; delete saved.pendingTool!.receiptId; });
    const recovered = new AgentEngine(repo, { model: new CapabilityFixture(), tools });
    await recovered.recover();
    current = await repo.get(run.id);
    expect(current.status).toBe('unknown');
    expect(current.toolReceipts.at(-1)?.status).toBe('unknown');
    expect(await recovered.command(run.id, 'reconcile', { reason: 'Provider confirmed the idempotent tool receipt' })).toMatchObject({ status: 'running' });
    expect(await recovered.advance(run.id)).toBe('running');
    expect((await repo.get(run.id)).toolReceipts.at(-1)?.status).toBe('completed');
    await repo.close();
  });

  it('retrieves classified knowledge into the Runtime source catalog', async () => {
    const repo = await repository();
    const knowledge = new InMemoryKnowledgeProvider([makeKnowledgeRecord({ id: 'knowledge.runtime', title: 'Runtime note', content: 'Use durable execution', source: 'owned-wiki', classification: 'internal', tags: ['runtime'], updatedAt: '2026-09-18T00:00:00.000Z' }), makeKnowledgeRecord({ id: 'knowledge.private', title: 'Private note', content: 'Do not disclose', source: 'private', classification: 'private', tags: [], updatedAt: '2026-09-18T00:00:00.000Z' })]);
    const model = new PlanningFixture();
    const engine = new AgentEngine(repo, { model, knowledge });
    const run = await engine.create({ goal: 'Use project knowledge', knowledgeQuery: 'durable execution' });
    expect(run.context.sources.map(source => source.id)).toContain('knowledge.runtime');
    expect(run.context.sources.map(source => source.id)).not.toContain('knowledge.private');
    await engine.advance(run.id);
    const plannerInput = model.calls[0]?.input as { sources: Array<{ id: string }> };
    expect(plannerInput.sources.map(source => source.id)).toContain('knowledge.runtime');
    await repo.close();
  });

  it('reads an explicitly authorized Brain scope into the Runtime source catalog and audits the read', async () => {
    const repo = await repository();
    const brain = new GovernedBrain();
    const claim = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project.runtime', classification: 'internal', kind: 'decision', content: 'Use a durable checkpoint', sourceRefs: ['receipt.brain'], confidence: 1 }, 'owner');
    const engine = new AgentEngine(repo, { model: new PlanningFixture(), brain });
    const run = await engine.create({ goal: 'Use the project decision', brainScope: 'project.runtime' });
    expect(run.context.sources.map(source => source.id)).toContain(claim.id);
    expect(brain.auditLog().some(entry => entry.action === 'read' && entry.scopeRef === 'project.runtime')).toBe(true);
    await repo.close();
  });

  it('applies an active workflow policy when snapshotting a new Run', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-runtime-policy-runs-'))); await repo.init();
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-runtime-policy-evolution-'));
    const evolution = new FileEvolutionRepository(directory); await evolution.init();
    const activation = new FileEvolutionActivationStore(directory); await activation.init();
    const rsi = new RsiService(evolution, activation);
    const candidate = await rsi.propose({ target: 'workflow', baseVersion: 'workflow/1', proposedVersion: 'workflow/2', change: JSON.stringify({ maxModelCalls: 3, maxTaskCount: 4, retry: { maxAttempts: 2, backoffSeconds: 5 } }), sourceReceiptRefs: ['receipt.workflow'], reason: 'Bound long-running execution cost', risk: 'low' });
    for (const kind of ['replay', 'holdout', 'safety'] as const) await rsi.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: [`${kind}.workflow`] });
    await rsi.approve(candidate.id, 'approval.workflow'); await rsi.promote(candidate.id); await rsi.activate(candidate.id, 'activation.workflow');
    const engine = new AgentEngine(repo, { model: new PlanningFixture(), evolution: rsi });
    const run = await engine.create({ goal: 'Use governed workflow policy', maxModelCalls: 20 });
    expect(run.maxModelCalls).toBe(3);
    expect(run.evolution?.[0]).toMatchObject({ target: 'workflow', version: 'workflow/2' });
    await activation.close(); await evolution.close(); await repo.close();
  });
});
