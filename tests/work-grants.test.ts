import type { AcceptanceCheck, AgentRun } from '../src/runtime/contracts.js';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, delegationContext } from '../src/runtime/engine.js';
import { runMetrics } from '../src/runtime/run-metrics.js';
import type { VerifyInput } from '../src/executor.js';
import type { ModelRequest } from '../src/runtime/model.js';
import type { ToolGateway } from '../src/integrations.js';
import { decideAction, type ActionCandidate } from '../src/runtime/action-policy.js';
import { InMemoryWorkGrantStore, JsonWorkGrantStore, WorkGrantConflict, WorkGrantNotFound, createWorkGrantSchema, workGrantRemaining, workGrantState } from '../src/work-grant-store.js';
import { runWorkGrantStoreContract } from './support/work-grant-contract.js';

const scope = { owner: 'owner', tenantId: 'local' };
const grantInput = { title: 'Site A', tools: ['edit', 'publish'], budget: { perRun: { tokens: 1000 }, total: { tokens: 2500 } }, durationHours: 24 };

describe('work grant store', () => {
  runWorkGrantStoreContract('in memory', async () => ({ store: new InMemoryWorkGrantStore(), reopen: async store => store }));
  runWorkGrantStoreContract('JSON file', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'aeeis-grants-')), 'work-grants.json');
    const store = new JsonWorkGrantStore(file); await store.init();
    return { store, reopen: async current => { await current.close?.(); const next = new JsonWorkGrantStore(file); await next.init(); return next; } };
  });

  it('rejects a grant whose per-Run cap exceeds the total or whose dimensions do not match', () => {
    expect(() => createWorkGrantSchema.parse({ ...grantInput, budget: { perRun: { tokens: 3000 }, total: { tokens: 2500 } } })).toThrow(/cannot exceed/);
    expect(() => createWorkGrantSchema.parse({ ...grantInput, budget: { perRun: { tokens: 10 }, total: { moneyUsd: 2 } } })).toThrow(/both/);
    expect(() => createWorkGrantSchema.parse({ ...grantInput, tools: [], agents: [] })).toThrow(/at least one/);
    expect(() => createWorkGrantSchema.parse({ ...grantInput, durationHours: 24 * 8 })).toThrow();
  });

  it('keeps a settlement and a reopening on disk, and refuses a reopening the grant cannot cover', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'aeeis-grants-')), 'work-grants.json');
    let store = new JsonWorkGrantStore(file); await store.init();
    const grant = await store.create(scope, grantInput);
    await store.allocate(scope, grant.grantId, 'run_a', undefined);
    await store.settle(scope, grant.grantId, 'run_a', { tokens: 120 });
    await store.close(); store = new JsonWorkGrantStore(file); await store.init();
    expect((await store.get(scope, grant.grantId)).allocations[0]).toMatchObject({ runId: 'run_a', tokens: 120, settledAt: expect.any(String) });
    // Settling again keeps the first settlement.
    expect((await store.settle(scope, grant.grantId, 'run_a', { tokens: 5 })).allocations[0]!.tokens).toBe(120);
    await store.allocate(scope, grant.grantId, 'run_b', undefined);
    await store.allocate(scope, grant.grantId, 'run_c', undefined);
    await expect(store.reopen(scope, grant.grantId, 'run_a', { tokens: 1000 })).rejects.toThrow(WorkGrantConflict);
    await store.settle(scope, grant.grantId, 'run_b', { tokens: 100 });
    const reopened = await store.reopen(scope, grant.grantId, 'run_a', { tokens: 1000 });
    expect(reopened.allocations[0]).toEqual({ runId: 'run_a', tokens: 1000, at: expect.any(String) });
    expect(workGrantRemaining(reopened)).toEqual({ tokens: 2500 - 1000 - 100 - 1000 });
    await store.close();
  });

  it('holds a dimension it could not settle, fills it in once known, and never grows it', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'aeeis-grants-')), 'work-grants.json');
    let store = new JsonWorkGrantStore(file); await store.init();
    const grant = await store.create(scope, grantInput);
    await store.allocate(scope, grant.grantId, 'run_a', undefined);
    const first = (await store.settle(scope, grant.grantId, 'run_a', {})).allocations[0]!;
    expect(first).toEqual({ runId: 'run_a', tokens: 1000, at: expect.any(String), settledAt: expect.any(String), held: ['tokens'] });
    await store.close(); store = new JsonWorkGrantStore(file); await store.init();
    // Still unknown: nothing changes.
    expect((await store.settle(scope, grant.grantId, 'run_a', {})).allocations[0]).toEqual(first);
    const filled = (await store.settle(scope, grant.grantId, 'run_a', { tokens: 80 })).allocations[0]!;
    expect(filled).toEqual({ runId: 'run_a', tokens: 80, at: first.at, settledAt: first.settledAt });
    // Settled and known: a later report cannot change it.
    expect((await store.settle(scope, grant.grantId, 'run_a', { tokens: 5 })).allocations[0]).toEqual(filled);
    await store.close();
  });
  it('reports expiry from the clock without rewriting the record', async () => {
    const store = new InMemoryWorkGrantStore();
    const grant = await store.create(scope, grantInput, '2026-11-05T00:00:00.000Z');
    expect(workGrantState(grant, '2026-11-05T23:59:59.000Z')).toBe('active');
    expect(workGrantState(grant, '2026-11-06T00:00:00.000Z')).toBe('expired');
    await expect(store.allocate(scope, grant.grantId, 'run_late', undefined, '2026-11-06T00:00:01.000Z')).rejects.toThrow(WorkGrantConflict);
  });
});

describe('action decisions under a work grant', () => {
  const edit: ActionCandidate = { kind: 'tool', id: 'edit', version: '1', capabilities: ['write'] };
  const publish: ActionCandidate = { kind: 'tool', id: 'publish', version: '1', capabilities: ['write', 'network'] };
  const grant = { grantId: 'wg_test', containedTools: ['edit'], agents: ['helper.agent'] };

  it('runs a contained tool unasked whoever started the Run and after external text', () => {
    for (const origin of ['owner', 'webhook', 'channel', 'agent'] as const) {
      for (const mode of ['required', 'yolo'] as const) expect(decideAction(undefined, origin, mode, edit, { untrusted: true, grant })).toMatchObject({ decision: 'allow', rule: 'grant' });
    }
    expect(decideAction(undefined, 'channel', 'required', { kind: 'agent', id: 'helper.agent' }, { grant })).toMatchObject({ decision: 'allow', rule: 'grant' });
  });

  it('still asks for a tool whose effect reaches outside, and still refuses a blocked one', () => {
    expect(decideAction(undefined, 'owner', 'required', publish, { grant })).toMatchObject({ decision: 'ask', rule: 'review' });
    expect(decideAction(undefined, 'webhook', 'required', publish, { grant })).toMatchObject({ decision: 'ask', rule: 'external' });
    expect(decideAction({ allow: [], block: ['edit'] }, 'owner', 'required', edit, { grant })).toMatchObject({ decision: 'refuse', rule: 'block' });
    expect(decideAction(undefined, 'owner', 'required', { kind: 'agent', id: 'other.agent' }, { grant })).toMatchObject({ decision: 'ask' });
  });
});

/** `edit` is confined to the workspace by the gateway's own code; `publish` is not. */
function harness(options: { twoSteps?: boolean; calls?: string[]; reject?: boolean; wrongVersionFirst?: boolean; muddledCall?: boolean; verifier?: { verify(input: VerifyInput): Promise<AcceptanceCheck> } } = {}) {
  const repository = new InMemoryRunRepository();
  const grants = new InMemoryWorkGrantStore();
  const interrupt = vi.fn<NonNullable<ToolGateway['interruptRun']>>(async () => ({ confirmed: true }));
  const invoke = vi.fn<ToolGateway['invoke']>(async request => ({ status: 'completed', output: { done: request.toolId }, outputRefs: ['out'], receipt: {
    schemaVersion: 'receipt/1', receiptId: `receipt_00000000-0000-0000-0000-${String(invoke.mock.calls.length).padStart(12, '0')}`, provider: 'aeeis-local-tools', operation: request.toolId,
    requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: ['out'], capabilitiesUsed: request.toolId === 'edit' ? ['write'] : ['write', 'network'], startedAt: new Date().toISOString(), status: 'completed',
  } }));
  const tools: ToolGateway = {
    listTools: async () => [
      { id: 'edit', version: '1', capabilities: ['write'], inputSchema: {}, outputSchema: {} },
      { id: 'publish', version: '1', capabilities: ['write', 'network'], inputSchema: {}, outputSchema: {} },
      { id: 'other', version: '1', capabilities: ['write'], inputSchema: {}, outputSchema: {} },
    ],
    invoke,
    workspaceContainedTools: async () => ['edit', 'other'],
    interruptRun: interrupt,
  };
  const sequence = options.calls ?? ['edit'];
  let plans = 0, rejecting = false;
  const usage = { inputTokens: 10, outputTokens: 5 };
  const respond = async (request: ModelRequest) => ({ ...(await answer(request)), usage });
  const answer = async (request: ModelRequest): Promise<{ value: unknown }> => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) plans += 1;
    if (request.system.includes('Plan a real deliverable') && options.twoSteps) return { value: { summary: 'Build, then summarize', nodes: [{ id: 'site', title: 'Change the site', instruction: 'Edit the page', dependsOn: [] }, { id: 'deliver', title: 'Summarize the delivery', instruction: 'Summarize', dependsOn: ['site'] }] } };
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: plans === 1 ? 'Change the site' : 'Change the site and add the footer', nodes: [{ id: 'site', title: 'Change the site', instruction: 'Edit the page', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) {
      if (rejecting) return { value: { verdict: 'needs_revision', summary: 'Not convinced', issues: ['Not sure about this'] } };
      return { value: options.reject && plans === 1 ? { verdict: 'needs_revision', summary: 'Missing the footer', issues: ['Add the footer'] } : { verdict: 'accepted', summary: 'Checked' } };
    }
    if (request.system.includes('You review one external side effect')) throw new Error('no approval model in this test');
    const next = sequence[input.observations.length];
    if (next && options.muddledCall && !input.executionBudget.finalOnly) return { value: { type: 'tool', tool: 'capability', toolId: next, toolVersion: '1', input: { step: 0 } } };
    if (next && !input.executionBudget.finalOnly) return { value: { type: 'capability', toolId: next, toolVersion: options.wrongVersionFirst && !input.observations.length ? '9' : '1', purpose: `Use ${next}`, input: { step: input.observations.length } } };
    const refs = (input.availableEvidenceRefs as string[]).slice(0, 1);
    // In two steps, the summary never becomes valid, so its repair runs out after the build step's work.
    if (options.twoSteps && input.task?.id === 'deliver') return { value: { type: 'finish', title: '', content: '' } };
    return { value: { type: 'finish', title: 'Site', content: `Done. [${refs[0]}]`, evidenceRefs: refs } };
  };
  const complete = vi.fn(respond);
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, { model, tools, workGrants: grants, executionLimits: { maxNodeIterations: 4 }, ...(options.verifier ? { verifier: options.verifier } : {}) });
  const materials = [{ title: 'Brief', source: 'user-input', content: 'Add a footer to the landing page.' }];
  const settle = async (id: string, stopAt: string[] = ['succeeded', 'failed', 'unknown', 'needs_approval', 'paused']) => {
    for (let i = 0; i < 30; i++) { const status = await engine.advance(id); if (stopAt.includes(status)) return status; }
    return (await repository.get(id)).status;
  };
  return { repository, grants, invoke, interrupt, engine, materials, settle, rejectReviews: () => { rejecting = true; } };
}

describe('runs under a work grant', () => {
  it('approves the plan from the grant and runs a contained tool without any card', async () => {
    const h = harness();
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId, origin: 'channel' });
    expect(run.allowedTools).toEqual(['edit', 'publish']);
    expect(run.workGrant).toMatchObject({ grantId: grant.grantId, containedTools: ['edit'], allocation: { tokens: 1000 } });
    expect(run.modelBudget).toEqual({ tokens: 1000 });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(finished.approval).toMatchObject({ approved: true, actor: `grant:${grant.grantId}` });
    expect(finished.actionApproval).toBeUndefined();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    // The grant travels beside the call, never inside the request a remote toolkit would receive.
    expect(h.invoke.mock.calls[0]![1]).toEqual({ workspace: grant.grantId });
    expect(JSON.stringify(h.invoke.mock.calls[0]![0])).not.toContain(grant.grantId);
    expect(finished.events.find(event => event.type === 'action.allowed')?.data).toMatchObject({ rule: 'grant', grantId: grant.grantId });
    expect(workGrantRemaining(await h.grants.get(scope, grant.grantId))).toEqual({ tokens: 1500 });
  });

  it('gives back what an ended Run did not spend, and keeps a running Run\'s whole reservation', async () => {
    const h = harness();
    const grant = await h.grants.create(scope, grantInput);
    const waiting = await h.engine.create({ goal: 'Add a header', materials: h.materials, workGrantId: grant.grantId });
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    const spent = finished.calls.length * 15;
    expect(spent).toBeGreaterThan(0);
    const settled = await h.engine.settleWorkGrant(grant.grantId, scope);
    expect(settled.allocations.find(item => item.runId === run.id)).toMatchObject({ tokens: spent, settledAt: expect.any(String) });
    expect(settled.allocations.find(item => item.runId === waiting.id)).toEqual(expect.not.objectContaining({ settledAt: expect.anything() }));
    expect(workGrantRemaining(settled)).toEqual({ tokens: 2500 - 1000 - spent });
    // Settling again changes nothing; the next Run reserves from what came back.
    expect((await h.engine.settleWorkGrant(grant.grantId, scope)).revision).toBe(settled.revision);
  });

  it('takes the whole reservation back before a failed Run is retried, and refuses when others used the refund', async () => {
    const h = harness();
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId });
    expect(await h.settle(run.id)).toBe('succeeded');
    await h.repository.mutate(run.id, current => { current.status = 'failed'; current.error = 'fixture failure'; });
    const settled = await h.engine.settleWorkGrant(grant.grantId, scope);
    const spent = settled.allocations[0]!.tokens!;
    expect(spent).toBeLessThan(1000);
    expect((await h.repository.get(run.id)).events.some(item => item.type === 'work_grant.settled')).toBe(true);
    // With room left, a retry reserves the full cap again and the Run is no longer settled.
    const retried = await h.engine.command(run.id, 'retry', {});
    expect(retried.status).not.toBe('failed');
    const reopened = await h.grants.get(scope, grant.grantId);
    expect(reopened.allocations[0]).toEqual(expect.objectContaining({ tokens: 1000 }));
    expect(reopened.allocations[0]).not.toHaveProperty('settledAt');
    expect(workGrantRemaining(reopened)).toEqual({ tokens: 1500 });

    // Settled again, then two other Runs take what came back: a retry or replan is refused rather than overspending.
    await h.repository.mutate(run.id, current => { current.status = 'failed'; current.error = 'fixture failure'; });
    await h.engine.settleWorkGrant(grant.grantId, scope);
    await h.engine.create({ goal: 'Add a header', materials: h.materials, workGrantId: grant.grantId });
    await h.engine.create({ goal: 'Add a menu', materials: h.materials, workGrantId: grant.grantId });
    await expect(h.engine.command(run.id, 'retry', {})).rejects.toThrow(/不够/);
    await expect(h.engine.command(run.id, 'replan', {})).rejects.toThrow(/不够/);
    expect((await h.repository.get(run.id)).status).toBe('failed');
    expect(workGrantRemaining(await h.grants.get(scope, grant.grantId)).tokens).toBeGreaterThanOrEqual(0);
  });

  it('keeps the reservation of a cancelled Run while a call it made may still be billed', async () => {
    const h = harness();
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId });
    await h.repository.mutate(run.id, current => { current.status = 'cancelled'; current.pendingTool = { toolId: 'edit', toolVersion: '1' } as never; });
    expect((await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]).not.toHaveProperty('settledAt');
    await h.repository.mutate(run.id, current => { delete current.pendingTool; });
    expect((await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]).toHaveProperty('settledAt');
  });

  it('still asks before an action whose effect reaches outside the workspace', async () => {
    const h = harness({ calls: ['publish'] });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Publish the site', materials: h.materials, workGrantId: grant.grantId });
    expect(await h.settle(run.id)).toBe('needs_approval');
    const waiting = await h.repository.get(run.id);
    expect(waiting.approval).toMatchObject({ approved: true, actor: `grant:${grant.grantId}` });
    expect(waiting.actionApproval).toMatchObject({ status: 'pending', ref: 'publish@1' });
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('waits for approval when the Run asks for a tool outside the grant', async () => {
    const h = harness({ calls: ['other'] });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', allowedTools: ['edit', 'other'], materials: h.materials, workGrantId: grant.grantId });
    expect(await h.settle(run.id)).toBe('needs_approval');
    const waiting = await h.repository.get(run.id);
    expect(waiting.approval).toMatchObject({ approved: false });
    expect(waiting.approval!.reason).toContain('other');
    expect(waiting.events.find(event => event.type === 'plan.approval_requested')?.data).toMatchObject({ grantId: grant.grantId });
  });

  it('approves a replanned version from the same grant', async () => {
    const h = harness({ reject: true });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId });
    expect(await h.settle(run.id)).toBe('failed');
    await h.engine.command(run.id, 'replan', { reason: 'Reviewer wants a footer' });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    expect(finished.plans.length).toBeGreaterThanOrEqual(2);
    expect(finished.events.filter(event => event.type === 'plan.auto_approved').map(event => (event.data as { planVersion: number }).planVersion)).toEqual(finished.plans.map(plan => plan.version));
    expect(finished.events.some(event => event.type === 'plan.approval_requested')).toBe(false);
  });

  it('pauses active work on revoke, and nothing afterwards is covered', async () => {
    const h = harness({ calls: ['edit'] });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId });
    await h.engine.advance(run.id);
    expect((await h.repository.get(run.id)).status).toBe('running');
    const result = await h.engine.revokeWorkGrant(grant.grantId, scope);
    expect(result.pausedRunIds).toEqual([run.id]);
    const paused = await h.repository.get(run.id);
    expect(paused.status).toBe('paused');
    expect(paused.workGrant?.revokedAt).toBeDefined();
    await h.engine.command(run.id, 'resume', {});
    expect(await h.settle(run.id)).toBe('needs_approval');
    expect((await h.repository.get(run.id)).actionApproval).toMatchObject({ status: 'pending', ref: 'edit@1' });
    expect(h.invoke).not.toHaveBeenCalled();
    await expect(h.engine.create({ goal: 'Another', materials: h.materials, workGrantId: grant.grantId })).rejects.toThrow('已撤销');
  });

  it('keeps grants to their owner and apart from review modes and budget edits', async () => {
    const h = harness({ calls: ['other'] });
    const grant = await h.grants.create(scope, grantInput);
    await expect(h.engine.create({ goal: 'Steal', materials: h.materials, workGrantId: grant.grantId }, 'mallory', 'local')).rejects.toThrow(WorkGrantNotFound);
    await expect(h.engine.create({ goal: 'Both', materials: h.materials, workGrantId: grant.grantId, executionReview: 'yolo' })).rejects.toThrow(/executionReview/);
    const run = await h.engine.create({ goal: 'Add a footer', allowedTools: ['edit', 'other'], materials: h.materials, workGrantId: grant.grantId, modelBudget: { tokens: 400 } });
    expect(run.modelBudget).toEqual({ tokens: 400 });
    expect(await h.settle(run.id)).toBe('needs_approval');
    const plan = (await h.repository.get(run.id)).plans.at(-1)!;
    await expect(h.engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version, modelBudget: { tokens: 99999 } })).rejects.toThrow('授权');
    await h.engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
    expect((await h.repository.get(run.id)).approval).toMatchObject({ approved: true, actor: 'owner' });
  });
});

describe('stopping the work on a Run machine', () => {
  const start = async (h: ReturnType<typeof harness>) => (await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: (await h.grants.create(scope, grantInput)).grantId, origin: 'channel' })).id;
  const events = async (h: ReturnType<typeof harness>, id: string) => (await h.repository.get(id)).events.filter(item => item.type.startsWith('machine.')).map(item => [item.type, item.data]);
  it('freezes on pause, continues on resume, and stops everything on cancel', async () => {
    const h = harness();
    const id = await start(h);
    await h.engine.command(id, 'pause', {});
    expect(h.interrupt).toHaveBeenLastCalledWith(id, 'freeze');
    await h.engine.command(id, 'resume', {});
    expect(h.interrupt).toHaveBeenLastCalledWith(id, 'thaw');
    await h.engine.command(id, 'cancel', {});
    expect(h.interrupt).toHaveBeenLastCalledWith(id, 'halt');
    expect(await events(h, id)).toEqual([['machine.interrupted', { action: 'freeze' }], ['machine.interrupted', { action: 'thaw' }], ['machine.interrupted', { action: 'halt' }]]);
  });
  it('says so when the host could not confirm, and the Run still pauses', async () => {
    const h = harness();
    const id = await start(h);
    h.interrupt.mockResolvedValueOnce({ confirmed: false, detail: 'Sandbox host vps is unreachable' });
    expect((await h.engine.command(id, 'pause', {})).status).toBe('paused');
    expect(await events(h, id)).toEqual([['machine.interrupt_unconfirmed', { action: 'freeze', detail: 'Sandbox host vps is unreachable' }]]);
    h.interrupt.mockRejectedValueOnce(new Error('gateway down'));
    await h.engine.command(id, 'cancel', {});
    expect((await h.repository.get(id)).status).toBe('cancelled');
    expect((await events(h, id)).at(-1)).toEqual(['machine.interrupt_unconfirmed', { action: 'halt', detail: 'gateway down' }]);
  });
  it('records nothing for a Run that has no machine yet', async () => {
    const h = harness();
    const id = await start(h);
    h.interrupt.mockResolvedValueOnce({ confirmed: true, detail: 'no machine' });
    await h.engine.command(id, 'pause', {});
    expect(await events(h, id)).toEqual([]);
  });
  it('freezes the machine when a grant is revoked', async () => {
    const h = harness();
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId, origin: 'channel' });
    await h.engine.revokeWorkGrant(grant.grantId, scope);
    expect(h.interrupt).toHaveBeenCalledWith(run.id, 'freeze');
  });
});

describe('independent acceptance of finished work', () => {
  const requirements = ['The page loads', 'The form rejects an empty email'];
  const check = (round: number, passed: boolean, overrides: Partial<AcceptanceCheck> = {}): AcceptanceCheck => ({
    round, at: '2026-11-06T00:00:00.000Z', passed, projectChanged: false, cost: { tokens: 50, money: 0.01, currency: 'USD' },
    items: [{ requirement: requirements[0]!, status: 'passed', notes: 'ok' }, { requirement: requirements[1]!, status: passed ? 'passed' : 'failed', notes: passed ? 'ok' : 'Empty email was accepted' }], ...overrides,
  });
  const start = async (verify: (input: VerifyInput) => Promise<AcceptanceCheck>) => {
    const verifier = { verify: vi.fn(verify) };
    const h = harness({ verifier });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a form', materials: h.materials, workGrantId: grant.grantId, origin: 'channel', acceptance: requirements });
    return { h, verifier, run };
  };
  it('checks before the reviewer, tells the work about the requirements, and accepts only after it passes', async () => {
    const { h, verifier, run } = await start(async () => check(0, true));
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(verifier.verify.mock.calls[0]![0]).toMatchObject({ runId: run.id, goal: 'Add a form', requirements, round: 0, deliver: true, workspace: run.workGrant!.grantId });
    const done = await h.repository.get(run.id);
    expect(done.context.sources.some(source => source.content.includes('1. The page loads'))).toBe(true);
    expect(done.events.map(item => item.type)).toContain('acceptance.checked');
    expect(done.acceptanceChecks).toHaveLength(1);
  });
  it('sends a failure back through the revision loop, and accepts when a later check passes', async () => {
    const { h, verifier, run } = await start(async input => check(input.round, input.round === 1));
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(verifier.verify.mock.calls.map(call => call[0].round)).toEqual([0, 1]);
    const done = await h.repository.get(run.id);
    const revision = done.events.find(item => item.type === 'review.revision_requested')!;
    expect(JSON.stringify(revision.data)).toContain('Empty email was accepted');
    expect(runMetrics(done)).toMatchObject({ completed: true, acceptedWithoutRework: false, revisions: 1, humanInterventions: 0 });
  });
  it('fails the Run when the work never passes, and does not ask the reviewer to overrule it', async () => {
    const { h, verifier, run } = await start(async input => check(input.round, false));
    expect(await h.settle(run.id)).toBe('failed');
    expect(verifier.verify).toHaveBeenCalledTimes(3);
    const done = await h.repository.get(run.id);
    expect(done.review).toMatchObject({ verdict: 'needs_revision' });
    expect(runMetrics(done)).toMatchObject({ completed: false, acceptedWithoutRework: false });
  });
  it('fails plainly when the check itself could not run, without spending revisions on it', async () => {
    const { h, verifier, run } = await start(async input => ({ ...check(input.round, false), items: requirements.map(requirement => ({ requirement, status: 'unverified' as const, notes: 'host down' })), error: 'Sandbox host unreachable' }));
    expect(await h.settle(run.id)).toBe('failed');
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect((await h.repository.get(run.id)).error).toContain('Sandbox host unreachable');
  });
  it('keeps the reservation while a check is out after a cancel, then counts its late bill', async () => {
    let held: { tokens?: number; settled: boolean } | undefined;
    let ctx!: Awaited<ReturnType<typeof start>>;
    ctx = await start(async () => {
      // The owner cancels while the check runs, and someone lists the grant before the check comes back.
      await ctx.h.engine.command(ctx.run.id, 'cancel', {});
      const during = (await ctx.h.engine.settleWorkGrant(ctx.run.workGrant!.grantId, scope)).allocations[0]!;
      held = { ...(during.tokens === undefined ? {} : { tokens: during.tokens }), settled: Boolean(during.settledAt) };
      return check(0, true);
    });
    const { h, run } = ctx;
    await h.settle(run.id, ['succeeded', 'failed', 'cancelled', 'unknown', 'needs_approval', 'paused']);
    expect(held).toEqual({ tokens: 1000, settled: false });
    const stopped = await h.repository.get(run.id);
    expect(stopped.status).toBe('cancelled');
    expect(stopped.pendingAcceptance).toBeUndefined();
    expect(stopped.acceptanceChecks).toEqual([expect.objectContaining({ ignored: 'stopped', cost: expect.objectContaining({ tokens: 50 }) })]);
    expect(stopped.events.map(item => item.type)).toContain('acceptance.checked_after_stop');
    expect(stopped.events.map(item => item.type)).not.toContain('acceptance.checked');
    const settled = (await h.engine.settleWorkGrant(run.workGrant!.grantId, scope)).allocations[0]!;
    expect(settled).toMatchObject({ tokens: stopped.calls.length * 15 + 50, settledAt: expect.any(String) });
  });
  const reviewing = async (h: Awaited<ReturnType<typeof start>>['h'], id: string) => {
    expect(await h.settle(id, ['reviewing', 'succeeded', 'failed'])).toBe('reviewing');
    return h.repository.get(id);
  };
  it('does not start a check for a Run that was cancelled and settled while its tick was held up', async () => {
    const { h, verifier, run } = await start(async () => check(0, true));
    const stale = await reviewing(h, run.id);
    await h.engine.command(run.id, 'cancel', {});
    expect((await h.engine.settleWorkGrant(run.workGrant!.grantId, scope)).allocations[0]!.settledAt).toEqual(expect.any(String));
    expect(await (h.engine as unknown as { checkAcceptance(run: AgentRun): Promise<boolean> }).checkAcceptance(stale)).toBe(false);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect((await h.repository.get(run.id)).pendingAcceptance).toBeUndefined();
  });
  it('leaves a check that is out alone, then follows a stale one for its cost before checking afresh', async () => {
    const resume = vi.fn(async (input: VerifyInput) => check(input.round, true, { cost: { tokens: 70 } }));
    const verifier = { verify: vi.fn(async (input: VerifyInput) => check(input.round, true)), resume };
    const h = harness({ verifier });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a form', materials: h.materials, workGrantId: grant.grantId, origin: 'channel', acceptance: requirements });
    await reviewing(h, run.id);
    // Another Engine holds a live claim: this one neither replaces nor clears it, and starts nothing.
    await h.repository.mutate(run.id, current => { current.pendingAcceptance = { round: 0, attempt: '0', claim: 'other', at: new Date().toISOString() }; });
    expect(await h.engine.advance(run.id)).toBe('reviewing');
    expect(verifier.verify).not.toHaveBeenCalled();
    expect((await h.repository.get(run.id)).pendingAcceptance).toMatchObject({ claim: 'other', attempt: '0' });
    // Its process died: the claim stops being renewed, and the next tick follows the same session for what it cost.
    await h.repository.mutate(run.id, current => { current.pendingAcceptance!.at = new Date(Date.now() - 10 * 60_000).toISOString(); });
    expect(await h.engine.advance(run.id)).toBe('reviewing');
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ round: 0, attempt: '0' }));
    const followed = await h.repository.get(run.id);
    expect(followed.pendingAcceptance).toBeUndefined();
    expect(followed.acceptanceChecks).toEqual([expect.objectContaining({ ignored: 'interrupted', cost: { tokens: 70 } })]);
    // Its verdict decided nothing: a fresh check, in a session of its own, does.
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(verifier.verify.mock.calls[0]![0]).toMatchObject({ round: 0, attempt: '1' });
    const settled = (await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]!;
    const done = await h.repository.get(run.id);
    expect(settled.tokens).toBe(done.modelUsage!.tokens + 70 + 50);
  });
  it('keeps the cost of a result whose claim was taken over, but lets it decide nothing', async () => {
    let ctx!: Awaited<ReturnType<typeof start>>;
    ctx = await start(async () => {
      await ctx.h.repository.mutate(ctx.run.id, current => { current.pendingAcceptance = { ...current.pendingAcceptance!, claim: 'other' }; });
      return check(0, true);
    });
    await reviewing(ctx.h, ctx.run.id);
    expect(await ctx.h.engine.advance(ctx.run.id)).toBe('reviewing');
    const after = await ctx.h.repository.get(ctx.run.id);
    expect(after.pendingAcceptance).toMatchObject({ claim: 'other' });
    expect(after.acceptanceChecks).toEqual([expect.objectContaining({ ignored: 'duplicate', cost: expect.objectContaining({ tokens: 50 }) })]);
    expect(after.events.map(item => item.type)).not.toContain('acceptance.checked');
  });
  it('checks again after a pause, ignoring what came back while it was paused', async () => {
    let ctx!: Awaited<ReturnType<typeof start>>;
    ctx = await start(async input => {
      if (input.attempt === '0') { await ctx.h.engine.command(ctx.run.id, 'pause', {}); return check(input.round, false); }
      return check(input.round, true);
    });
    expect(await ctx.h.settle(ctx.run.id)).toBe('paused');
    await ctx.h.engine.command(ctx.run.id, 'resume', {});
    expect(await ctx.h.settle(ctx.run.id)).toBe('succeeded');
    expect(ctx.verifier.verify.mock.calls.map(call => call[0].attempt)).toEqual(['0', '1']);
    const done = await ctx.h.repository.get(ctx.run.id);
    expect(done.acceptanceChecks).toEqual([expect.objectContaining({ ignored: 'stopped', passed: false }), expect.objectContaining({ passed: true })]);
    expect(done.acceptanceChecks![1]!.ignored).toBeUndefined();
  });
  it('follows a dead check on a cancelled Run for its cost before refunding the grant', async () => {
    const resume = vi.fn(async (input: VerifyInput) => check(input.round, false, { cost: { tokens: 40 } }));
    const verifier = { verify: vi.fn(async (input: VerifyInput) => check(input.round, true)), resume };
    const h = harness({ verifier });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a form', materials: h.materials, workGrantId: grant.grantId, origin: 'channel', acceptance: requirements });
    await reviewing(h, run.id);
    await h.repository.mutate(run.id, current => { current.pendingAcceptance = { round: 0, attempt: '0', claim: 'dead', at: new Date(Date.now() - 10 * 60_000).toISOString() }; });
    await h.engine.command(run.id, 'cancel', {});
    expect((await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]!.settledAt).toBeUndefined();
    await vi.waitFor(async () => expect((await h.repository.get(run.id)).pendingAcceptance).toBeUndefined());
    const settled = (await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]!;
    const done = await h.repository.get(run.id);
    expect(done.acceptanceChecks).toEqual([expect.objectContaining({ ignored: 'interrupted', cost: { tokens: 40 } })]);
    expect(settled).toMatchObject({ tokens: done.modelUsage!.tokens + 40, settledAt: expect.any(String) });
  });
  type Checking = { checkAcceptance(run: AgentRun): Promise<boolean> };
  it('records one session once when a takeover and the original watcher both see it end', async () => {
    let ctx!: Awaited<ReturnType<typeof start>>;
    const resume = vi.fn(async (input: VerifyInput) => check(input.round, true, { cost: { tokens: 50, money: 0.01, currency: 'USD' } }));
    const verify = vi.fn(async (input: VerifyInput) => {
      if (input.attempt !== '0') return check(input.round, true);
      // The original watcher stalls: its claim goes stale, another tick takes over, follows the session and closes the relay first.
      await ctx.h.repository.mutate(ctx.run.id, current => { current.pendingAcceptance!.at = new Date(Date.now() - 10 * 60_000).toISOString(); });
      expect(await (ctx.h.engine as unknown as Checking).checkAcceptance(await ctx.h.repository.get(ctx.run.id))).toBe(false);
      // Then the original returns: the same money, and no tokens, since the relay was already closed.
      return check(input.round, true, { cost: { money: 0.01, currency: 'USD' } });
    });
    const verifier = { verify, resume };
    const h = harness({ verifier });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a form', materials: h.materials, workGrantId: grant.grantId, origin: 'channel', acceptance: requirements });
    ctx = { h, verifier, run } as unknown as Awaited<ReturnType<typeof start>>;
    expect(await h.settle(run.id)).toBe('succeeded');
    const done = await h.repository.get(run.id);
    expect(done.acceptanceChecks).toEqual([
      expect.objectContaining({ attempt: '0', ignored: 'interrupted', cost: { tokens: 50, money: 0.01, currency: 'USD' } }),
      expect.objectContaining({ attempt: '1', passed: true }),
    ]);
    expect(verify.mock.calls.map(call => call[0].attempt)).toEqual(['0', '1']);
    const settled = (await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]!;
    expect(settled.tokens).toBe(done.modelUsage!.tokens + 50 + 50);
  });
  it('settles again once a late report of the same session brings the tokens the first settlement did not know', async () => {
    let ctx!: Awaited<ReturnType<typeof start>>;
    let held: unknown;
    const resume = vi.fn(async (input: VerifyInput) => check(input.round, true, { cost: { money: 0.01, currency: 'USD' } }));
    const verify = vi.fn(async (input: VerifyInput) => {
      // The original closes the relay first (so it alone has the tokens), then stalls; a takeover saves a report without tokens.
      await ctx.h.repository.mutate(ctx.run.id, current => { current.pendingAcceptance!.at = new Date(Date.now() - 10 * 60_000).toISOString(); });
      expect(await (ctx.h.engine as unknown as Checking).checkAcceptance(await ctx.h.repository.get(ctx.run.id))).toBe(false);
      // The owner cancels, and the grant settles while the tokens are still unknown: that part of the reservation stays.
      await ctx.h.engine.command(ctx.run.id, 'cancel', {});
      held = (await ctx.h.engine.settleWorkGrant(ctx.run.workGrant!.grantId, scope)).allocations[0];
      return check(input.round, true, { cost: { tokens: 50, money: 0.01, currency: 'USD' } });
    });
    const verifier = { verify, resume };
    const h = harness({ verifier });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a form', materials: h.materials, workGrantId: grant.grantId, origin: 'channel', acceptance: requirements });
    ctx = { h, verifier, run } as unknown as Awaited<ReturnType<typeof start>>;
    await h.settle(run.id, ['succeeded', 'failed', 'cancelled', 'unknown', 'needs_approval', 'paused']);
    expect(held).toMatchObject({ tokens: 1000, held: ['tokens'], settledAt: expect.any(String) });
    const done = await h.repository.get(run.id);
    expect(done.acceptanceChecks).toEqual([expect.objectContaining({ attempt: '0', cost: { tokens: 50, money: 0.01, currency: 'USD' } })]);
    const settled = (await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]!;
    expect(settled).toEqual({ runId: run.id, tokens: done.modelUsage!.tokens + 50, at: expect.any(String), settledAt: (held as { settledAt: string }).settledAt });
    expect((await h.repository.get(run.id)).events.map(item => item.type)).toContain('work_grant.reconciled');
    // Nothing more to learn: settling again changes nothing.
    expect((await h.engine.settleWorkGrant(grant.grantId, scope)).allocations[0]).toEqual(settled);
  });
  it('does not start another paid check from a stale snapshot once the round is decided', async () => {
    const { h, verifier, run } = await start(async input => check(input.round, true));
    const stale = await reviewing(h, run.id);
    // Engine A decides the round; Engine B was held up with the snapshot from before.
    expect(await (h.engine as unknown as Checking).checkAcceptance(await h.repository.get(run.id))).toBe(true);
    expect(await (h.engine as unknown as Checking).checkAcceptance(stale)).toBe(false);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect((await h.repository.get(run.id)).pendingAcceptance).toBeUndefined();
  });
  it('checks afresh after a pause when what passed came back while paused, and the reviewer\'s doubts then stand', async () => {
    let ctx!: Awaited<ReturnType<typeof start>>;
    ctx = await start(async input => {
      if (input.round === 0 && input.attempt === '0') { await ctx.h.engine.command(ctx.run.id, 'pause', {}); return check(input.round, true); }
      return check(input.round, false);
    });
    ctx.h.rejectReviews();
    expect(await ctx.h.settle(ctx.run.id)).toBe('paused');
    await ctx.h.engine.command(ctx.run.id, 'resume', {});
    expect(await ctx.h.settle(ctx.run.id)).toBe('failed');
    expect(ctx.verifier.verify.mock.calls[1]![0]).toMatchObject({ round: 0, attempt: '1' });
    const done = await ctx.h.repository.get(ctx.run.id);
    expect(done.acceptanceChecks![0]).toMatchObject({ ignored: 'stopped', passed: true });
    expect(done.events.map(item => item.type)).not.toContain('review.advisory');
  });
  it('counts what checks cost against the Run', async () => {
    const { h, run } = await start(async () => check(0, true));
    await h.settle(run.id);
    const done = await h.repository.get(run.id);
    expect(delegationContext(done).tokens).toBe(1000 - done.modelUsage!.tokens - 50);
    expect(runMetrics(done)).toMatchObject({ acceptedWithoutRework: true, externalTokens: 50, humanInterventions: 0 });
    expect(runMetrics(done).elapsedSeconds).not.toBeNull();
  });
  it('keeps a passed check even when the reviewer has doubts, with the doubts on record', async () => {
    const { h, verifier, run } = await start(async () => check(0, true));
    h.rejectReviews();
    expect(await h.settle(run.id)).toBe('succeeded');
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    const done = await h.repository.get(run.id);
    expect(done.events.find(item => item.type === 'review.advisory')?.data).toMatchObject({ issues: ['Not sure about this'] });
    expect(done.events.some(item => item.type === 'review.revision_requested')).toBe(false);
  });
  it('tells the planner not to do the check\'s job, only on Runs that have one', async () => {
    const { h, run } = await start(async () => check(0, true));
    await h.settle(run.id);
    const done = await h.repository.get(run.id);
    expect(done.calls[0]!.modelRequest!.system).toContain('do not plan verification or testing steps');
    const plain = harness();
    const other = await plain.engine.create({ goal: 'Add a footer', materials: plain.materials, workGrantId: (await plain.grants.create(scope, grantInput)).grantId, origin: 'channel' });
    await plain.settle(other.id);
    expect((await plain.repository.get(other.id)).calls[0]!.modelRequest!.system).not.toContain('do not plan verification');
  });
  describe('when the work stops early as partial', () => {
    // The delivery step's output never becomes valid, so it ends with its repair exhausted after the build step's
    // work, as in production.
    const stopEarly = async (verify: (input: VerifyInput) => Promise<AcceptanceCheck>) => {
      const verifier = { verify: vi.fn(verify) };
      const h = harness({ verifier, twoSteps: true });
      const grant = await h.grants.create(scope, grantInput);
      const run = await h.engine.create({ goal: 'Build a timer page', materials: h.materials, workGrantId: grant.grantId, origin: 'channel', acceptance: requirements, builtinSkill: 'website-builder/1' });
      return { h, verifier, run };
    };
    it('still checks the work, and accepts it when the check passes', async () => {
      const { h, verifier, run } = await stopEarly(async () => check(0, true));
      expect(await h.settle(run.id)).toBe('succeeded');
      const done = await h.repository.get(run.id);
      expect(done.events.some(item => item.type === 'run.partial')).toBe(true);
      expect(verifier.verify).toHaveBeenCalledTimes(1);
      expect(verifier.verify.mock.calls[0]![0]).toMatchObject({ deliver: true, round: 0 });
      expect(done.acceptanceChecks?.at(-1)?.passed).toBe(true);
      expect(done.partial).toBe(true);
    });
    it('fails the Run when the check finds a requirement unmet, since stopped work has no revision left', async () => {
      const { h, verifier, run } = await stopEarly(async () => check(0, false));
      expect(await h.settle(run.id)).toBe('failed');
      expect(verifier.verify).toHaveBeenCalledTimes(1);
      const done = await h.repository.get(run.id);
      expect(done.error).toContain('1 of 2 requirements not met');
      expect(done.events.some(item => item.type === 'review.revision_requested')).toBe(false);
      expect(runMetrics(done)).toMatchObject({ completed: false });
    });
    it('fails the Run when the check cannot run at all', async () => {
      const { h, run } = await stopEarly(async () => { throw new Error('Sandbox host unreachable'); });
      expect(await h.settle(run.id)).toBe('failed');
      expect((await h.repository.get(run.id)).error).toContain('Sandbox host unreachable');
    });
    it('checks even when review after a stop is turned off', async () => {
      vi.stubEnv('AEEIS_REVIEW_AFTER_STOP', '0');
      try {
        const { h, verifier, run } = await stopEarly(async () => check(0, false));
        expect(await h.settle(run.id)).toBe('failed');
        expect(verifier.verify).toHaveBeenCalledTimes(1);
      } finally { vi.unstubAllEnvs(); }
    });
  });
  it('refuses requirements on an AEEIS that cannot check them', async () => {
    const h = harness();
    await expect(h.engine.create({ goal: 'Add a form', materials: h.materials, acceptance: requirements, origin: 'channel' })).rejects.toThrow(/executor configured/);
  });
});

describe('a slip in naming a tool', () => {
  it('reads a call that mixes the tool and capability shapes as the tool it names', async () => {
    const h = harness({ muddledCall: true });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId, origin: 'channel' });
    const outcome = await h.settle(run.id);
    expect((await h.repository.get(run.id)).error).toBeUndefined();
    expect(outcome).toBe('succeeded');
    expect(h.invoke.mock.calls[0]![0].toolId).toBe('edit');
  });
  it('lets the model correct a wrong version instead of ending the Run', async () => {
    const h = harness({ wrongVersionFirst: true, calls: ['edit', 'edit'] });
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId, origin: 'channel' });
    expect(await h.settle(run.id)).toBe('succeeded');
    const slip = (await h.repository.get(run.id)).events.find(item => item.type === 'tool.failed_recoverable');
    expect(JSON.stringify(slip?.data)).toContain('toolVersion');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('what a delegation may spend', () => {
  it('takes what is left of the grant, after model calls and earlier external spending', async () => {
    const h = harness();
    const grant = await h.grants.create(scope, grantInput);
    const run = await h.engine.create({ goal: 'Add a footer', materials: h.materials, workGrantId: grant.grantId, origin: 'channel' });
    expect(delegationContext(run)).toEqual({ runId: run.id, workspace: grant.grantId, tokens: 1000 });
    expect(await h.settle(run.id)).toBe('succeeded');
    const finished = await h.repository.get(run.id);
    const used = finished.modelUsage!.tokens;
    expect(used).toBeGreaterThan(0);
    expect(delegationContext(finished).tokens).toBe(1000 - used);
    const external = { ...finished, delegationOutcomes: [{ status: 'completed', cost: { tokens: 100 } }] } as never as AgentRun;
    expect(delegationContext({ ...external, externalBudget: { tokens: 150 } }).tokens).toBeLessThanOrEqual(150);
  });
  it('has no token figure for a Run with no budget', () => {
    expect(delegationContext({ id: 'run_x', calls: [], delegationOutcomes: [], toolReceipts: [] } as never as AgentRun)).toEqual({ runId: 'run_x' });
  });
});

describe('the computer panel API', () => {
  const machine = { state: 'running' as const, previews: [{ port: 3000, url: 'https://x.example/?_token=ibp_secret' }], live: { foreground: null, processes: [], repository: null, files: [] } };
  const setup = async (status: string) => {
    const { buildApp } = await import('../src/runtime/http.js');
    const repository = new InMemoryRunRepository();
    const run = { id: `run_${'9'.repeat(36)}`, goal: 'Site', status, owner: 'alice', tenantId: 'team-a', events: [], calls: [], steps: [], artifacts: [] } as never as AgentRun;
    await repository.create(run);
    const runComputer = {
      observe: vi.fn(async () => machine), screenshots: vi.fn(async () => [{ name: '20261106T000000-abc123.png', bytes: 4, capturedAt: '2026-11-06T00:00:00.000Z' }]),
      screenshot: vi.fn(async (_id: string, name: string) => name === '20261106T000000-abc123.png' ? Buffer.from('png!') : undefined), hostWait: vi.fn(async () => undefined as never),
    };
    const app = buildApp({ repository, runComputer, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } } });
    return { app, run, runComputer, alice: { authorization: 'Bearer alice' }, bob: { authorization: 'Bearer bob' } };
  };
  it('shows the machine to its owner only, and looks at working Runs only', async () => {
    const { app, run, runComputer, alice, bob } = await setup('running');
    try {
      const view = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/computer`, headers: alice });
      expect(view.statusCode).toBe(200);
      expect(view.json()).toMatchObject({ status: 'running', machine: { state: 'running' }, screenshots: [{ name: '20261106T000000-abc123.png' }] });
      expect(runComputer.observe).toHaveBeenLastCalledWith(run.id, true);
      const refused = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/computer`, headers: bob });
      expect(refused.statusCode).toBe(404); expect(refused.body).not.toContain('ibp_secret');
      expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/computer/screenshots/20261106T000000-abc123.png`, headers: bob })).statusCode).toBe(404);
      const image = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/computer/screenshots/20261106T000000-abc123.png`, headers: alice });
      expect(image.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff' });
      expect(image.body).toBe('png!');
      expect((await app.inject({ method: 'GET', url: `/api/runs/${run.id}/computer/screenshots/..%2F..%2Fsecret.png`, headers: alice })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('does not reach the host for a finished Run', async () => {
    const { app, run, runComputer, alice } = await setup('succeeded');
    try {
      await app.inject({ method: 'GET', url: `/api/runs/${run.id}/computer`, headers: alice });
      expect(runComputer.observe).toHaveBeenLastCalledWith(run.id, false);
    } finally { await app.close(); }
  });
});

describe('work grants over HTTP', () => {
  it('creates, lists and revokes a grant only for its owner', async () => {
    const { buildApp } = await import('../src/runtime/http.js');
    const app = buildApp({ repository: new InMemoryRunRepository(), workGrants: new InMemoryWorkGrantStore(), principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
    } });
    const alice = { authorization: 'Bearer alice' }, bob = { authorization: 'Bearer bob' };
    try {
      const created = await app.inject({ method: 'POST', url: '/api/work-grants', headers: alice, payload: grantInput });
      expect(created.statusCode).toBe(201);
      const grant = created.json();
      expect(grant).toMatchObject({ owner: 'alice', state: 'active', remaining: { tokens: 2500 }, runCount: 0 });
      expect((await app.inject({ method: 'POST', url: '/api/work-grants', headers: alice, payload: { ...grantInput, durationHours: 1000 } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/work-grants', headers: bob })).json()).toEqual({ grants: [] });
      expect((await app.inject({ method: 'POST', url: `/api/work-grants/${grant.grantId}/revoke`, headers: bob })).statusCode).toBe(404);
      const revoked = await app.inject({ method: 'POST', url: `/api/work-grants/${grant.grantId}/revoke`, headers: alice });
      expect(revoked.json()).toMatchObject({ state: 'revoked' });
      expect((await app.inject({ method: 'GET', url: '/api/work-grants', headers: alice })).json().grants.map((item: { state: string }) => item.state)).toEqual(['revoked']);
    } finally { await app.close(); }
  });
});

describe('local tools confined to the workspace', () => {
  it('counts code-running tools as confined only without an open network', async () => {
    const { LocalToolGateway } = await import('../src/local-tools.js');
    const { writeFile } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-contained-'));
    const load = async (network: 'none' | 'bridge' | 'proxied') => {
      const file = join(directory, `${network}.json`);
      await writeFile(file, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: `./ws-${network}`, stateDirectory: `./state-${network}`, tools: ['read', 'write', 'shell', 'process', 'browser', 'web-fetch'], sandbox: { network, ...(network === 'proxied' ? { egressHosts: ['registry.npmjs.org'] } : {}) } }));
      return LocalToolGateway.load(file);
    };
    expect(await (await load('bridge')).workspaceContainedTools()).toEqual(['read', 'write']);
    expect(await (await load('none')).workspaceContainedTools()).toEqual(['read', 'write', 'shell', 'process', 'browser']);
    // The Run's own proxy is its only route out, so code-running tools stay inside what the operator allowed.
    expect(await (await load('proxied')).workspaceContainedTools()).toEqual(['read', 'write', 'shell', 'process', 'browser']);
  });
});
