import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
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
function harness(options: { calls?: string[]; reject?: boolean } = {}) {
  const repository = new InMemoryRunRepository();
  const grants = new InMemoryWorkGrantStore();
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
  };
  const sequence = options.calls ?? ['edit'];
  let plans = 0;
  const usage = { inputTokens: 10, outputTokens: 5 };
  const respond = async (request: ModelRequest) => ({ ...(await answer(request)), usage });
  const answer = async (request: ModelRequest): Promise<{ value: unknown }> => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) plans += 1;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: plans === 1 ? 'Change the site' : 'Change the site and add the footer', nodes: [{ id: 'site', title: 'Change the site', instruction: 'Edit the page', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) {
      return { value: options.reject && plans === 1 ? { verdict: 'needs_revision', summary: 'Missing the footer', issues: ['Add the footer'] } : { verdict: 'accepted', summary: 'Checked' } };
    }
    if (request.system.includes('You review one external side effect')) throw new Error('no approval model in this test');
    const next = sequence[input.observations.length];
    if (next && !input.executionBudget.finalOnly) return { value: { type: 'capability', toolId: next, toolVersion: '1', purpose: `Use ${next}`, input: { step: input.observations.length } } };
    const refs = (input.availableEvidenceRefs as string[]).slice(0, 1);
    return { value: { type: 'finish', title: 'Site', content: `Done. [${refs[0]}]`, evidenceRefs: refs } };
  };
  const complete = vi.fn(respond);
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, { model, tools, workGrants: grants, executionLimits: { maxNodeIterations: 4 } });
  const materials = [{ title: 'Brief', source: 'user-input', content: 'Add a footer to the landing page.' }];
  const settle = async (id: string, stopAt: string[] = ['succeeded', 'failed', 'unknown', 'needs_approval', 'paused']) => {
    for (let i = 0; i < 30; i++) { const status = await engine.advance(id); if (stopAt.includes(status)) return status; }
    return (await repository.get(id)).status;
  };
  return { repository, grants, invoke, engine, materials, settle };
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
    expect(finished.events.find(event => event.type === 'action.allowed')?.data).toMatchObject({ rule: 'grant', grantId: grant.grantId });
    expect(workGrantRemaining(await h.grants.get(scope, grant.grantId))).toEqual({ tokens: 1500 });
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
  it('counts code-running tools as confined only when the container has no network', async () => {
    const { LocalToolGateway } = await import('../src/local-tools.js');
    const { writeFile } = await import('node:fs/promises');
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-contained-'));
    const load = async (network: 'none' | 'bridge') => {
      const file = join(directory, `${network}.json`);
      await writeFile(file, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: `./ws-${network}`, stateDirectory: `./state-${network}`, tools: ['read', 'write', 'shell', 'process', 'web-fetch'], sandbox: { network } }));
      return LocalToolGateway.load(file);
    };
    expect(await (await load('bridge')).workspaceContainedTools()).toEqual(['read', 'write']);
    expect(await (await load('none')).workspaceContainedTools()).toEqual(['read', 'write', 'shell', 'process']);
  });
});
