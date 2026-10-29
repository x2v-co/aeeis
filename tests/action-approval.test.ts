import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, Conflict } from '../src/runtime/engine.js';
import { explainRun } from '../src/runtime/explanation.js';
import type { ModelRequest } from '../src/runtime/model.js';
import type { ToolGateway } from '../src/integrations.js';
import { decideAction, isReadOnlyAction, normalizeActionPolicy, withActionDecision, type ActionCandidate } from '../src/runtime/action-policy.js';
import { ActionPolicyConflict, InMemoryActionPolicyStore, JsonActionPolicyStore, actionPolicyDigest, frozenRunPolicy, type ActionPolicyStore } from '../src/action-policy-store.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    expect(decideAction(undefined, 'webhook', 'yolo', lookup)).toMatchObject({ decision: 'allow', rule: 'read' });
  });

  it('treats a write after external text like one in a run started from outside', () => {
    const policy = normalizeActionPolicy({ allow: ['publish@1'] });
    expect(decideAction(policy, 'owner', 'required', publish, { untrusted: true })).toMatchObject({ decision: 'ask', rule: 'untrusted' });
    expect(decideAction(policy, 'owner', 'auto', publish, { untrusted: true })).toMatchObject({ decision: 'ask', rule: 'untrusted' });
    expect(decideAction(policy, 'owner', 'yolo', publish, { untrusted: true })).toMatchObject({ decision: 'refuse', rule: 'untrusted' });
    expect(decideAction(undefined, 'owner', 'yolo', lookup, { untrusted: true })).toMatchObject({ decision: 'allow', rule: 'read' });
  });

  it('does not let the allow list bypass the outside-origin rule', () => {
    const policy = normalizeActionPolicy({ allow: ['publish@1'] });
    expect(decideAction(policy, 'owner', 'required', publish)).toMatchObject({ decision: 'allow', rule: 'allow' });
    expect(decideAction(policy, 'webhook', 'required', publish)).toMatchObject({ decision: 'ask', rule: 'external' });
  });

  it('asks under required, lets the approval model judge under auto, and proceeds under yolo for an owner run', () => {
    expect(decideAction(undefined, undefined, undefined, publish)).toMatchObject({ decision: 'ask', rule: 'review' });
    expect(decideAction(undefined, 'owner', 'required', agent)).toMatchObject({ decision: 'ask', rule: 'review' });
    expect(decideAction(undefined, 'owner', 'auto', publish)).toMatchObject({ decision: 'judge', rule: 'auto' });
    expect(decideAction(undefined, 'owner', 'yolo', agent)).toMatchObject({ decision: 'allow', rule: 'yolo' });
    expect(decideAction(undefined, 'owner', 'required', lookup)).toMatchObject({ decision: 'allow', rule: 'read' });
    expect(decideAction(undefined, 'owner', 'required', { kind: 'tool', id: 'web-fetch', version: '1', capabilities: ['read', 'network'] })).toMatchObject({ decision: 'allow', rule: 'read' });
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

function harness(capabilities: string[], options: { judge?: (request: ModelRequest) => unknown; actionPolicies?: ActionPolicyStore; calls?: number } = {}) {
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
    if (request.system.includes('You review one external side effect')) {
      if (!options.judge) throw new Error('no approval model in this test');
      return { value: options.judge(request) };
    }
    if (input.observations.length < (options.calls ?? 1) && !input.executionBudget.finalOnly) {
      return { value: { type: 'capability', toolId: 'publish', toolVersion: '1', purpose: 'Publish the release note', input: { text: `Release 1.${input.observations.length + 2}` } } };
    }
    const refs = (input.availableEvidenceRefs as string[]).slice(0, 1);
    return { value: { type: 'finish', title: 'Release note', content: `Release note handled. [${refs[0]}]`, evidenceRefs: refs, limitations: invoke.mock.calls.length ? [] : ['The publish action did not run.'] } };
  });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, { model, tools, executionLimits: { maxNodeIterations: 4 }, ...(options.actionPolicies ? { actionPolicies: options.actionPolicies } : {}) });
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
  return { repository, invoke, engine, materials, settle, approvePlan, complete };
}

describe('action approval in the engine', () => {
  it('asks before a write in a required run the owner started, even after the plan was approved', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials });
    expect(await h.settle(run.id)).toBe('needs_approval');
    await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('needs_approval');
    const waiting = await h.repository.get(run.id);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(waiting.actionApproval).toMatchObject({ status: 'pending', ref: 'publish@1' });
    expect(waiting.events.find(event => event.type === 'action.approval_requested')?.data).toMatchObject({ rule: 'review' });
    await h.engine.command(run.id, 'approve-action', { idempotencyKey: waiting.actionApproval!.idempotencyKey, decision: 'once' });
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('runs an allow-listed write in a required run without asking', async () => {
    const h = harness(['write']);
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, actionPolicy: { allow: ['publish'] } });
    await h.settle(run.id);
    await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(finished.actionApproval).toBeUndefined();
    expect(finished.events.filter(event => event.type === 'action.allowed')).toHaveLength(1);
  });

  it('lets the approval model clear a write under auto review', async () => {
    const h = harness(['write'], { judge: () => ({ allow: true, reason: 'Publishing is exactly the approved step' }) });
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, executionReview: 'auto' });
    await h.settle(run.id);
    if ((await h.repository.get(run.id)).status === 'needs_approval') await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(finished.actionApproval).toMatchObject({ status: 'approved', actor: 'policy:auto', decision: 'once' });
    expect(finished.calls.filter(call => call.phase === 'action_review')).toHaveLength(1);
    expect(finished.events.some(event => event.type === 'action.auto_approved')).toBe(true);
  });

  it.each([
    ['says no', () => ({ allow: false, reason: 'This sends a public post' }), 'This sends a public post'],
    ['answers in the wrong shape', () => ({ maybe: true }), '没有给出可用的判断'],
    ['fails', () => { throw new Error('provider down'); }, '审批模型'],
  ])('asks the owner when the approval model %s', async (_label, judge, reason) => {
    const h = harness(['write'], { judge });
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, executionReview: 'auto' });
    await h.settle(run.id);
    if ((await h.repository.get(run.id)).status === 'needs_approval' && !(await h.repository.get(run.id)).actionApproval) await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('needs_approval');
    const waiting = await h.repository.get(run.id);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(waiting.actionApproval).toMatchObject({ status: 'pending', ref: 'publish@1' });
    expect(waiting.actionApproval!.reason).toContain(reason);
    await h.engine.command(run.id, 'approve-action', { idempotencyKey: waiting.actionApproval!.idempotencyKey, decision: 'once' });
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('asks before a second allow-listed write once the first one returned external text', async () => {
    const h = harness(['read', 'write'], { calls: 2 });
    const run = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, actionPolicy: { allow: ['publish@1'] } });
    await h.settle(run.id); await h.approvePlan(run.id);
    expect(await h.settle(run.id)).toBe('needs_approval');
    const waiting = await h.repository.get(run.id);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(waiting.actionApproval).toMatchObject({ status: 'pending', ref: 'publish@1' });
    expect(waiting.events.filter(event => event.type === 'action.approval_requested').at(-1)?.data).toMatchObject({ rule: 'untrusted' });

    const yolo = harness(['read', 'write'], { calls: 2 });
    const unattended = await yolo.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: yolo.materials, executionReview: 'yolo' });
    expect(await yolo.settle(unattended.id)).toBe('succeeded');
    expect(yolo.invoke).toHaveBeenCalledTimes(1);
    expect((await yolo.repository.get(unattended.id)).events.filter(event => event.type === 'action.refused').at(-1)?.data).toMatchObject({ rule: 'untrusted' });
  });

  it('copies the owner list at creation, and "always" adds to it for later runs only', async () => {
    const policies = new InMemoryActionPolicyStore();
    const h = harness(['write'], { actionPolicies: policies });
    const first = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials });
    expect(first.actionPolicy).toBeUndefined();
    await h.settle(first.id); await h.approvePlan(first.id); await h.settle(first.id);
    const waiting = await h.repository.get(first.id);
    await h.engine.command(first.id, 'approve-action', { idempotencyKey: waiting.actionApproval!.idempotencyKey, decision: 'always' });
    expect(await policies.get({ owner: 'owner', tenantId: 'local' })).toMatchObject({ allow: ['publish@1'], block: [], revision: 1 });
    expect(await h.settle(first.id)).toBe('succeeded');

    const second = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials });
    expect(second.actionPolicy).toEqual({ allow: ['publish@1'], block: [] });
    expect(second.actionPolicyDigest).toBe(actionPolicyDigest(second.actionPolicy));
    await policies.change({ owner: 'owner', tenantId: 'local' }, { add: { list: 'block', ref: 'publish@1' } });
    await h.settle(second.id); await h.approvePlan(second.id);
    expect(await h.settle(second.id)).toBe('succeeded');
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect((await h.repository.get(second.id)).actionPolicy).toEqual({ allow: ['publish@1'], block: [] });

    const third = await h.engine.create({ goal: 'Publish the release note', allowedTools: ['publish'], materials: h.materials, actionPolicy: { allow: ['publish@1'] } });
    expect(third.actionPolicy).toEqual({ allow: [], block: ['publish@1'] });
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

describe('owner action policy store', () => {
  const scope = { owner: 'alice', tenantId: 'team-a' };
  it('moves a ref between lists, checks the revision, and keeps a request from lifting an owner block', async () => {
    const store = new InMemoryActionPolicyStore();
    await store.change(scope, { add: { list: 'allow', ref: 'publish@1' } });
    const blocked = await store.change(scope, { add: { list: 'block', ref: 'publish@1' } });
    expect(blocked).toMatchObject({ allow: [], block: ['publish@1'], revision: 2 });
    await expect(store.change(scope, { expectedRevision: 1, allow: [], block: [] })).rejects.toBeInstanceOf(ActionPolicyConflict);
    expect(await store.change(scope, { add: { list: 'block', ref: 'publish@1' } })).toMatchObject({ revision: 2 });
    expect(frozenRunPolicy(blocked, normalizeActionPolicy({ allow: ['publish@1', 'lookup'] }))).toEqual({ allow: ['lookup'], block: ['publish@1'] });
    expect((await store.get({ owner: 'bob', tenantId: 'team-a' })).block).toEqual([]);
  });

  it('keeps the owner lists in the JSON store across restart', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'aeeis-action-policy-')), 'action-policies.json');
    const first = new JsonActionPolicyStore(file); await first.init();
    await first.change(scope, { expectedRevision: 0, allow: ['lookup', 'agent:helper.agent'], block: ['publish'] });
    await first.close();
    const second = new JsonActionPolicyStore(file); await second.init();
    try {
      expect(await second.get(scope)).toMatchObject({ allow: ['agent:helper.agent', 'lookup'], block: ['publish'], revision: 1 });
    } finally { await second.close(); }
  });
});

describe('owner action policy over HTTP', () => {
  it('reads and changes the lists with a revision check', async () => {
    const { buildApp } = await import('../src/runtime/http.js');
    const app = buildApp({ repository: new InMemoryRunRepository(), actionPolicies: new InMemoryActionPolicyStore() });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/action-policy' })).json()).toEqual({ allow: [], block: [], revision: 0 });
      const added = await app.inject({ method: 'PATCH', url: '/api/action-policy', payload: { expectedRevision: 0, add: { list: 'allow', ref: 'publish@1' } } });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toMatchObject({ allow: ['publish@1'], block: [], revision: 1 });
      expect((await app.inject({ method: 'PATCH', url: '/api/action-policy', payload: { expectedRevision: 0, add: { list: 'block', ref: 'publish@1' } } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PATCH', url: '/api/action-policy', payload: { add: { list: 'allow', ref: 'not a ref!' } } })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
