import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { buildApp } from '../src/runtime/http.js';
import { projectRunGraphs } from '../src/runtime/graphs.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import type { PlanDraft } from '../src/runtime/contracts.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import type { ToolGateway } from '../src/integrations.js';

const original: PlanDraft = { summary: '初始计划', nodes: [
  { id: 'read', title: '读取资料', instruction: '整理已有资料', dependsOn: [] },
  { id: 'write', title: '生成报告', instruction: '根据资料撰写报告', dependsOn: ['read'] },
] };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(options: { external?: boolean; goalLinked?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-plan-revision-'));
  const repository = new FileRunRepository(directory); await repository.init();
  cleanups.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const complete = vi.fn<ModelAdapter['complete']>(async request => {
    const input = request.input as any;
    return { value: request.system.includes('Plan a real deliverable')
      ? (input.userFeedback ? { summary: '修订后的计划', nodes: [{ ...original.nodes[0]!, title: '核查并总结', evidenceRequirements: '引用原始资料' }] } : original)
      : request.system.includes('Independently review') ? { verdict: 'accepted', summary: '通过', issues: [] }
      : options.external ? { type: 'capability', toolId: 'lookup', toolVersion: '1', input: {}, purpose: '读取资料' }
      : { type: 'finish', title: '报告', content: '整理完成。', evidenceRefs: [] }, usage: { inputTokens: 2, outputTokens: 1 } };
  });
  const invoke = vi.fn<ToolGateway['invoke']>(async request => ({ status: 'completed', output: '资料', receipt: {
    schemaVersion: 'receipt/1', receiptId: `receipt_${randomUUID()}`, provider: 'fixture', operation: 'lookup', requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: [], capabilitiesUsed: ['read'], startedAt: new Date().toISOString(), status: 'completed', cost: { tokens: 1, money: 0, currency: 'USD' },
  } }));
  const tools: ToolGateway = { listTools: async () => [{ id: 'lookup', version: '1', capabilities: ['read'], inputSchema: {}, outputSchema: {} }], invoke };
  const domain = options.goalLinked ? new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository()) : undefined;
  const room = domain ? await domain.createRoom({ title: '报告工作区' }, undefined, 'owner', 'team') : undefined;
  const goal = domain ? await domain.createGoal({ title: '报告', roomId: room!.id }, undefined, 'owner', 'team') : undefined;
  if (domain && room) await domain.addRoomMember(room.id, 'other', 'viewer', 'owner', 'team');
  const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' }, complete };
  const engine = new AgentEngine(repository, { model, ...(options.external ? { tools } : {}), ...(domain ? { domain } : {}) });
  const run = await engine.create({ goal: '根据资料形成报告', ...(goal ? { goalId: goal.id } : {}), ...(options.external ? { allowedTools: ['lookup'] } : {}) }, 'owner', 'team');
  await engine.advance(run.id);
  const app = buildApp({ repository, engine, ...(domain ? { domain } : {}), principalTokens: {
    owner: { id: 'owner', tenantId: 'team', roles: ['owner'] },
    other: { id: 'other', tenantId: 'team', roles: ['owner'] },
    outsider: { id: 'owner', tenantId: 'other-team', roles: ['owner'] },
    reader: { id: 'reader', tenantId: 'team', roles: ['agent'] },
    ownerReadOnly: { id: 'owner', tenantId: 'team', roles: ['agent'] },
  } });
  cleanups.push(() => app.close());
  const post = (action: string, payload: unknown, token = 'owner') => app.inject({ method: 'POST', url: `/api/runs/${run.id}/${action}`, headers: { authorization: `Bearer ${token}` }, payload });
  return { app, engine, repository, run, post, complete, invoke, domain, goal, directory };
}

describe('plan approval revisions API', () => {
  it('persists user feedback before planning, survives restart and returns v2 to approval', async () => {
    const f = await setup();
    const response = await f.post('revise-plan', { planVersion: 1, feedback: '  请合并任务并引用原始资料  ' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('planning');
    expect(response.json().planProvenance[0]).toMatchObject({ source: 'user', actor: 'owner', kind: 'feedback', basePlanVersion: 1, feedback: '请合并任务并引用原始资料' });
    expect(response.json().events.at(-1)).toMatchObject({ type: 'plan.revision_requested', data: { source: 'user', feedback: '请合并任务并引用原始资料', provenanceRef: response.json().planProvenance[0].id } });
    const restarted = new AgentEngine(f.repository, { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' }, complete: f.complete });
    expect(await restarted.advance(f.run.id)).toBe('needs_approval');
    const current = await f.repository.get(f.run.id);
    expect(current.plans.map(plan => plan.version)).toEqual([1, 2]);
    expect(current.plans[0]?.nodes).toEqual(original.nodes);
    expect(current.planProvenance?.[0]).toMatchObject({ planVersion: 2, planHash: current.plans[1]!.hash });
    expect(f.complete.mock.calls[1]![0].input).toMatchObject({ userFeedback: { feedback: '请合并任务并引用原始资料', basePlanVersion: 1 }, previousPlan: { version: 1 } });
    expect(projectRunGraphs(current).planComparisons[0]?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'modified', fields: ['title', 'evidenceRequirements'] }), expect.objectContaining({ kind: 'removed', taskId: 'write' })]));
    expect((await f.post('approve', { planVersion: 1, planHash: current.plans[0]!.hash })).statusCode).toBe(409);
    expect((await f.post('approve', { planVersion: 2, planHash: current.plans[1]!.hash })).statusCode).toBe(200);
    await restarted.advance(f.run.id);
    expect(f.complete.mock.calls.at(-1)![0].input).toMatchObject({ task: { title: '核查并总结', evidenceRequirements: '引用原始资料' } });
  });

  it('saves edits, deletion, addition and order as immutable user revisions and executes only the latest', async () => {
    const f = await setup();
    const v1 = (await f.repository.get(f.run.id)).plans[0]!;
    const edited: PlanDraft = { summary: '用户计划', nodes: [
      { id: 'verify', title: '核查结果', instruction: '核查报告', evidenceRequirements: '列出证据链接', dependsOn: [] },
      { ...original.nodes[1]!, title: '撰写简报', instruction: '生成简报', dependsOn: [] },
    ] };
    const saved = await f.post('edit-plan', { planVersion: 1, plan: edited });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().plans[1]).toMatchObject({ ...edited, version: 2, author: { type: 'user', actor: 'owner' } });
    expect(saved.json().plans[0]).toEqual(v1);
    expect(saved.json().planProvenance[0]).toMatchObject({ kind: 'edit', source: 'user', planVersion: 2 });
    expect(saved.json().approval.approved).toBe(false);
    expect(saved.json().steps.map((step: any) => step.taskId)).toEqual(['verify', 'write']);
    for (const action of ['approve', 'edit-plan', 'revise-plan', 'budgets']) {
      const payload = action === 'approve' ? { planVersion: 1, planHash: v1.hash } : action === 'edit-plan' ? { planVersion: 1, plan: edited } : action === 'revise-plan' ? { planVersion: 1, feedback: '过期' } : { planVersion: 1, modelBudget: { tokens: 100 } };
      expect((await f.post(action, payload)).statusCode).toBe(409);
    }
    // Identical plan content still needs the latest version, even when hashes match.
    const copy = await f.post('edit-plan', { planVersion: 2, plan: edited });
    const latest = copy.json().plans.at(-1);
    expect(latest.hash).toBe(saved.json().plans[1].hash);
    expect((await f.post('approve', { planVersion: 2, planHash: latest.hash })).statusCode).toBe(409);
    expect((await f.post('approve', { planHash: latest.hash })).statusCode).toBe(400);
    expect((await f.post('approve', { planVersion: 3, planHash: latest.hash })).statusCode).toBe(200);
    await f.engine.advance(f.run.id);
    expect(f.complete.mock.calls.at(-1)![0].input).toMatchObject({ task: edited.nodes[0] });
  });

  it('rejects invalid plans and leaves history and approval unchanged', async () => {
    const f = await setup();
    const before = await f.repository.get(f.run.id), node = original.nodes[0]!;
    const invalid: unknown[] = [
      { ...original, nodes: [] }, { ...original, summary: ' ' },
      { ...original, nodes: [node, node] }, { ...original, nodes: [{ ...node, title: ' ' }] },
      { ...original, nodes: [{ ...node, instruction: '' }] }, { ...original, nodes: [{ ...node, evidenceRequirements: ' ' }] },
      { ...original, nodes: [{ ...node, title: 'x'.repeat(201) }] }, { ...original, nodes: [{ ...node, instruction: 'x'.repeat(4001) }] },
      { ...original, nodes: [{ ...node, evidenceRequirements: 'x'.repeat(4001) }] },
      { ...original, nodes: [{ ...node, dependsOn: ['missing'] }] }, { ...original, nodes: [{ ...node, dependsOn: ['read'] }] },
      { ...original, nodes: [{ ...node, dependsOn: ['write'] }, original.nodes[1]] },
      { ...original, nodes: [node, { ...original.nodes[1]!, dependsOn: ['read', 'read'] }] },
      { ...original, nodes: Array.from({ length: 13 }, (_, i) => ({ ...node, id: `task_${i}` })) },
      { ...original, nodes: [{ ...node, status: 'succeeded' }] },
    ];
    for (const plan of invalid) expect((await f.post('edit-plan', { planVersion: 1, plan })).statusCode).toBe(400);
    for (const feedback of ['', ' ', 'x'.repeat(8001)]) expect((await f.post('revise-plan', { planVersion: 1, feedback })).statusCode).toBe(400);
    const after = await f.repository.get(f.run.id);
    expect(after).toEqual(before);
  });

  it('persists approval budgets and stops model execution when the edited limit is spent', async () => {
    const f = await setup();
    expect((await f.post('budgets', { planVersion: 1, modelBudget: { tokens: 7 }, externalBudget: { calls: 2, tokens: 100, moneyUsd: 1 } })).statusCode).toBe(200);
    const current = await f.repository.get(f.run.id);
    expect(current.modelBudget).toEqual({ tokens: 7 });
    expect(current.externalBudget).toEqual({ calls: 2, tokens: 100, moneyUsd: 1 });
    expect(current.events.at(-1)?.type).toBe('plan.budgets_updated');
    const approved = await f.post('approve', { planVersion: 1, planHash: current.plans[0]!.hash, modelBudget: { tokens: 5 } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().modelBudget.tokens).toBe(5);
    expect(await f.engine.advance(f.run.id)).toBe('failed');
    expect((await f.repository.get(f.run.id)).error).toContain('budget');
    expect(f.complete).toHaveBeenCalledTimes(2);
  });

  it('applies external call budgets configured at approval', async () => {
    const f = await setup({ external: true });
    const plan = (await f.repository.get(f.run.id)).plans[0]!;
    expect((await f.post('approve', { planVersion: 1, planHash: plan.hash, externalBudget: { calls: 1 } })).statusCode).toBe(200);
    for (let tick = 0; tick < 6; tick++) if (await f.engine.advance(f.run.id) === 'failed') break;
    expect(f.invoke).toHaveBeenCalledTimes(1);
    const stopped = await f.repository.get(f.run.id);
    expect(stopped.error, JSON.stringify(stopped.toolReceipts)).toContain('budget');
  });

  it('validates budgets atomically, supports clearing and refuses unverifiable prices or exhausted limits', async () => {
    const f = await setup();
    const before = await f.repository.get(f.run.id);
    const invalid = [{ modelBudget: {} }, { externalBudget: {} }, { modelBudget: { tokens: 0 } }, { modelBudget: { tokens: 1.2 } }, { modelBudget: { tokens: Number.MAX_SAFE_INTEGER + 1 } }, { externalBudget: { calls: -1 } }, { externalBudget: { calls: 0.5 } }, { externalBudget: { moneyUsd: -1 } }, { modelBudget: { moneyUsd: '1' } }, { modelBudget: { tokens: 50, extra: 1 } }];
    for (const budgets of invalid) expect((await f.post('budgets', { planVersion: 1, ...budgets })).statusCode).toBe(400);
    for (const budgets of [{ modelBudget: { moneyUsd: 1 } }, { modelBudget: { tokens: 2 } }]) expect((await f.post('approve', { planVersion: 1, planHash: before.plans[0]!.hash, ...budgets })).statusCode).toBe(409);
    expect(await f.repository.get(f.run.id)).toEqual(before);
    await f.post('budgets', { planVersion: 1, modelBudget: { tokens: 100 }, externalBudget: { calls: 2 } });
    const cleared = await f.post('budgets', { planVersion: 1, modelBudget: null, externalBudget: null });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().modelBudget).toBeUndefined(); expect(cleared.json().externalBudget).toBeUndefined();
  });

  it('requires auth and owner plus tenant for every mutation; share tokens grant read access only', async () => {
    const f = await setup();
    const share = await f.app.inject({ method: 'POST', url: `/api/runs/${f.run.id}/share`, headers: { authorization: 'Bearer owner' }, payload: {} });
    expect(share.statusCode).toBe(200);
    const token = share.json().url.split('/').at(-1);
    expect((await f.app.inject({ url: `/api/share/${token}` })).statusCode).toBe(200);
    for (const [action, payload] of [
      ['revise-plan', { planVersion: 1, feedback: '反馈' }], ['edit-plan', { planVersion: 1, plan: original }],
      ['budgets', { planVersion: 1, modelBudget: { tokens: 100 } }], ['approve', { planVersion: 1, planHash: (await f.repository.get(f.run.id)).plans[0]!.hash }],
    ] as const) {
      expect((await f.app.inject({ method: 'POST', url: `/api/runs/${f.run.id}/${action}`, payload })).statusCode).toBe(401);
      for (const caller of ['other', 'outsider', 'reader', token]) expect((await f.post(action, payload, caller)).statusCode).toBe(caller === 'reader' ? 403 : caller === token ? 401 : 404);
    }
    expect((await f.repository.get(f.run.id)).plans).toHaveLength(1);
  });

  it('keeps goal-linked domain tasks in sync with edited plan definitions', async () => {
    const f = await setup({ goalLinked: true });
    const plan: PlanDraft = { summary: '核查任务', nodes: [{ id: 'verify', title: '核查', instruction: '核查结果', dependsOn: [] }] };
    const saved = await f.post('edit-plan', { planVersion: 1, plan });
    expect(saved.statusCode).toBe(200);
    const domainPlan = await f.domain!.getPlan(saved.json().domainPlanId, 'owner', 'team');
    expect(domainPlan.nodes[0]).toMatchObject({ id: 'verify', title: '核查' });
    expect((await f.post('approve', { planVersion: 2, planHash: saved.json().plans[1].hash })).statusCode).toBe(200);
    expect(await f.engine.advance(f.run.id)).toBe('running');
    expect((await f.domain!.getPlan(domainPlan.id, 'owner', 'team')).nodes[0]?.status).toBe('succeeded');
  });

  it('marks room viewers and principals without an owner role read-only and rejects their writes', async () => {
    const f = await setup({ goalLinked: true });
    for (const caller of ['other', 'ownerReadOnly']) {
      const view = await f.app.inject({ url: `/api/runs/${f.run.id}`, headers: { authorization: `Bearer ${caller}` } });
      expect(view.statusCode).toBe(200); expect(view.json().canEdit).toBe(false);
      const expected = caller === 'other' ? 404 : 403;
      for (const [action, body] of [['edit-plan', { plan: original }], ['revise-plan', { feedback: '反馈' }], ['budgets', { modelBudget: { tokens: 100 } }], ['approve', { planHash: view.json().plans[0].hash }]] as const) {
        expect((await f.post(action, { planVersion: 1, ...body }, caller)).statusCode).toBe(expected);
      }
    }
    expect((await f.app.inject({ url: `/api/runs/${f.run.id}`, headers: { authorization: 'Bearer owner' } })).json().canEdit).toBe(true);
  });

  it('serializes concurrent edits: exactly one revision wins', async () => {
    const f = await setup();
    const responses = await Promise.all([f.post('edit-plan', { planVersion: 1, plan: original }), f.post('revise-plan', { planVersion: 1, feedback: '重写' })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
  });
});
