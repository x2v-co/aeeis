import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, Conflict } from '../src/runtime/engine.js';
import { explainRun } from '../src/runtime/explanation.js';
import type { ModelRequest } from '../src/runtime/model.js';
import type { ToolGateway } from '../src/integrations.js';
import { decideAction, isReadOnlyAction, normalizeActionPolicy, withActionDecision, type ActionCandidate } from '../src/runtime/action-policy.js';

const publish: ActionCandidate = { kind: 'tool', id: 'publish', version: '1', capabilities: ['write', 'network'] };
const lookup: ActionCandidate = { kind: 'tool', id: 'lookup', version: '1', capabilities: ['read'] };
const agent: ActionCandidate = { kind: 'agent', id: 'helper.agent' };

describe('action policy decisions', () => {
  it('refuses a blocked ref in every mode without asking', () => {
    const policy = normalizeActionPolicy({ block: ['publish'] });
    for (const mode of ['required', 'auto', 'yolo'] as const) {
      for (const origin of ['owner', 'webhook'] as const) expect(decideAction(policy, origin, mode, publish)).toMatchObject({ decision: 'refuse', rule: 'block' });
    }
  });

  it('asks for a non-read-only action in a run started from outside, and refuses it under yolo', () => {
    expect(decideAction(undefined, 'webhook', 'required', publish)).toMatchObject({ decision: 'ask', rule: 'external' });
    expect(decideAction(undefined, 'routine', 'auto', publish)).toMatchObject({ decision: 'ask', rule: 'external' });
    expect(decideAction(undefined, 'channel', 'yolo', publish)).toMatchObject({ decision: 'refuse', rule: 'external' });
    expect(decideAction(undefined, 'agent', 'required', agent)).toMatchObject({ decision: 'ask', rule: 'external' });
    expect(decideAction(undefined, 'webhook', 'yolo', lookup)).toMatchObject({ decision: 'allow', rule: 'plan' });
  });

  it('does not let the allow list bypass the outside-origin rule', () => {
    const policy = normalizeActionPolicy({ allow: ['publish@1'] });
    expect(decideAction(policy, 'owner', 'required', publish)).toMatchObject({ decision: 'allow', rule: 'allow' });
    expect(decideAction(policy, 'webhook', 'required', publish)).toMatchObject({ decision: 'ask', rule: 'external' });
  });

  it('keeps an owner run without a policy on the approved plan', () => {
    expect(decideAction(undefined, undefined, undefined, publish)).toMatchObject({ decision: 'allow', rule: 'plan' });
    expect(decideAction(undefined, 'owner', 'yolo', agent)).toMatchObject({ decision: 'allow', rule: 'plan' });
  });

  it('treats only read-only tools as read-only and never a delegation', () => {
    expect(isReadOnlyAction(lookup)).toBe(true);
    expect(isReadOnlyAction(publish)).toBe(false);
    expect(isReadOnlyAction({ kind: 'tool', id: 'mystery', capabilities: [] })).toBe(false);
    expect(isReadOnlyAction(agent)).toBe(false);
  });

  it('normalizes and widens the frozen policy only by explicit decisions', () => {
    expect(normalizeActionPolicy({ allow: ['b', 'a', 'a'], block: [] })).toEqual({ allow: ['a', 'b'], block: [] });
    expect(normalizeActionPolicy({ allow: [], block: [] })).toBeUndefined();
    expect(withActionDecision(undefined, 'publish@1', 'always')).toEqual({ allow: ['publish@1'], block: [] });
    expect(withActionDecision({ allow: ['publish@1'], block: [] }, 'publish@1', 'block')).toEqual({ allow: [], block: ['publish@1'] });
    expect(withActionDecision(undefined, 'publish@1', 'once')).toBeUndefined();
    expect(withActionDecision(undefined, 'publish@1', 'deny')).toBeUndefined();
  });
});

function harness(capabilities: string[]) {
  const repository = new InMemoryRunRepository();
  const invoke = vi.fn<ToolGateway['invoke']>(async request => ({ status: 'completed',
    output: { published: true }, outputRefs: ['post'], receipt: {
      schemaVersion: 'receipt/1', receiptId: `receipt_00000000-0000-0000-0000-${String(invoke.mock.calls.length).padStart(12, '0')}`, provider: 'toolkit_new', operation: request.toolId,
      requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: ['post'], capabilitiesUsed: capabilities,
      startedAt: new Date().toISOString(), status: 'completed',
    } }));
  const tools: ToolGateway = { listTools: async () => [{ id: 'publish', version: '1', capabilities, inputSchema: {}, outputSchema: {} }], invoke };
  const complete = vi.fn(async (request: ModelRequest) => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Publish the note', nodes: [{ id: 'post', title: 'Publish the note', instruction: 'Publish the release note', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Checked' } };
    if (!input.observations.length && !input.executionBudget.finalOnly) {
      return { value: { type: 'capability', toolId: 'publish', toolVersion: '1', purpose: 'Publish the release note', input: { text: 'Release 1.2' } } };
    }
    const refs = (input.availableEvidenceRefs as string[]).slice(0, 1);
    return { value: { type: 'finish', title: 'Release note', content: `Release note handled. [${refs[0]}]`, evidenceRefs: refs, limitations: invoke.mock.calls.length ? [] : ['The publish action did not run.'] } };
  });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, { model, tools, executionLimits: { maxNodeIterations: 4 } });
  const materials = [{ title: 'Release note', source: 'user-input', content: 'Release 1.2 ships the new channel board.' }];
  const settle = async (id: string, stopAt: string[] = ['succeeded', 'failed', 'unknown', 'needs_approval']) => {
    for (let i = 0; i < 30; i++) {
      const status = await engine.advance(id);
      if (stopAt.includes(status)) return status;
    }
    return (await repository.get(id)).status;
  };
  const approvePlan = async (id: string) => {
    const plan = (await repository.get(id)).plans.at(-1)!;
    await engine.command(id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  };
  return { repository, invoke, engine, materials, settle, approvePlan };
}

describe('action approval in the engine', () => {
  it('runs a write tool under the approved plan when the owner started the run and set no policy', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials });
    expect(await h.settle(run.id)).toBe('needs_approval');
    await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(finished.actionApproval).toBeUndefined();
    expect(finished.events.some(event => event.type.startsWith('action.'))).toBe(false);
  });

  it('refuses a blocked tool without a card and lets the run continue', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, actionPolicy: { block: ['publish'] } });
    await h.settle(run.id);
    await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(finished.actionApproval).toBeUndefined();
    expect(finished.events.filter(event => event.type === 'action.refused')).toHaveLength(1);
    expect(finished.steps[0]!.observations[0]!.result).toMatchObject({ error: { recoverable: true, errorCode: 'action_refused' } });
  });

  it('waits for the owner on a write in a webhook run, and runs it once approved', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, origin: 'webhook' });
    await h.settle(run.id);
    await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('needs_approval');
    const waiting = await h.repository.get(run.id);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(waiting.actionApproval).toMatchObject({ status: 'pending', kind: 'tool', ref: 'publish@1', taskId: 'post' });
    expect(explainRun(waiting).attention.kind).toBe('approve_action');

    // The plan approval cannot be reused to slip past the action.
    const plan = waiting.plans.at(-1)!;
    await expect(h.engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version })).rejects.toBeInstanceOf(Conflict);
    await expect(h.engine.command(run.id, 'approve-action', { idempotencyKey: 'stale', decision: 'once' })).rejects.toBeInstanceOf(Conflict);

    await h.engine.command(run.id, 'approve-action', { idempotencyKey: waiting.actionApproval!.idempotencyKey, decision: 'once' });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0]![0].idempotencyKey).toBe(waiting.actionApproval!.idempotencyKey);
    expect(finished.actionApproval).toMatchObject({ status: 'approved', decision: 'once', actor: 'owner' });
    expect(finished.events.filter(event => event.type === 'action.approved')).toHaveLength(1);
  });

  it('drops a declined write and tells the executor why', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, origin: 'routine' });
    await h.settle(run.id);
    await h.approvePlan(run.id);
    await h.settle(run.id);
    const waiting = await h.repository.get(run.id);
    await h.engine.command(run.id, 'approve-action', { idempotencyKey: waiting.actionApproval!.idempotencyKey, decision: 'block' });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(finished.pendingTool).toBeUndefined();
    expect(finished.actionPolicy).toEqual({ allow: [], block: ['publish@1'] });
    expect(finished.steps[0]!.observations.some(item => (item.result as any)?.error?.errorCode === 'action_declined')).toBe(true);
  });

  it('refuses a write in a yolo run started from outside instead of running it unattended', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, origin: 'webhook', executionReview: 'yolo' });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(finished.events.filter(event => event.type === 'action.refused')).toHaveLength(1);
    expect(finished.events.some(event => event.type === 'action.approval_requested')).toBe(false);
  });

  it('lets a read-only tool run in a run started from outside', async () => {
    const h = harness(['read']);
    const run = await h.engine.create({ goal: 'Look up the release note', allowedTools: ['publish'], materials: h.materials, origin: 'webhook' });
    await h.settle(run.id);
    await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect((await h.repository.get(run.id)).actionApproval).toBeUndefined();
  });
});
