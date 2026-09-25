import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { ModelOutcomeUnknown, ModelResponseRejected, type ModelAdapter, type ModelRequest, type ModelResponse } from '../src/runtime/model.js';
import { CatalogModelResolver } from '../src/runtime/model-router.js';
import { buildApp } from '../src/runtime/http.js';

const plan = { summary: 'Deliver', nodes: [{ id: 'work', title: 'Work', instruction: 'Produce a result', dependsOn: [] }] };
const reportedUsage = { inputTokens: 10, outputTokens: 5 };
const resources: Array<{ directory: string; repo: FileRunRepository }> = [];
afterEach(async () => { for (const { repo, directory } of resources.splice(0)) { await repo.close(); await rm(directory, { recursive: true, force: true }); } });
async function setup(complete?: ModelAdapter['complete'], prices = { inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: 'USD' }) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-budget-'));
  const repo = new FileRunRepository(directory); await repo.init(); resources.push({ directory, repo });
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    pin: { model: 'priced-model', provider: 'test-provider', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
    complete: async request => {
      requests.push(request);
      if (complete) return complete(request);
      const value = request.system.includes('Plan a real deliverable') ? plan
        : request.system.includes('Independently review') ? { verdict: 'accepted', summary: 'Ready', issues: [] }
        : { type: 'finish', title: 'Result', content: 'Completed work', evidenceRefs: [] };
      return { value, usage: reportedUsage };
    },
  };
  const resolver = new CatalogModelResolver({ list: async () => [{ model: model.pin.model, provider: model.pin.provider!, endpoint: model.pin.endpoint, capabilities: ['agent'], ...prices }] }, { create: () => model });
  const engine = new AgentEngine(repo, { resolver });
  return { repo, engine, model, resolver, prices, requests, directory };
}
async function approve(engine: AgentEngine, repo: FileRunRepository, id: string) {
  const run = await repo.get(id);
  await engine.command(id, 'approve', { planHash: run.plans.at(-1)!.hash });
}

describe('durable Run model budgets', () => {
  it('pins input/output prices and accounts planner, executor and reviewer across restart', async () => {
    const { engine, repo, resolver, prices, requests } = await setup();
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 50, moneyUsd: 0.001 } });
    expect(run.modelDecision).toMatchObject({ selected: { inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: 'USD' }, catalogHash: expect.stringMatching(/^[a-f0-9]{64}$/), catalogRetrievedAt: expect.any(String) });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    await approve(engine, repo, run.id);
    prices.inputPricePerMillion = 999; prices.outputPricePerMillion = 999;
    const resumed = new AgentEngine(repo, { resolver }); await resumed.recover();
    for (let i = 0; i < 4; i++) await resumed.advance(run.id);
    const completed = await repo.get(run.id);
    expect(completed.status).toBe('succeeded');
    expect(completed.modelUsage).toMatchObject({ tokens: 45, unreportedCalls: 0 });
    expect(completed.modelUsage?.moneyUsd).toBeCloseTo(0.00006, 10);
    expect(requests).toHaveLength(3);
  });

  it('stops the next billable call at the exact token threshold and denies retry/replan', async () => {
    const { engine, repo, requests } = await setup();
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 15 } });
    await engine.advance(run.id); await approve(engine, repo, run.id);
    expect(await engine.advance(run.id)).toBe('failed');
    expect(requests).toHaveLength(1);
    await expect(engine.command(run.id, 'retry', {})).rejects.toThrow('token budget exhausted');
    await expect(engine.command(run.id, 'replan', {})).rejects.toThrow('token budget exhausted');
  });

  it('records overshoot and rejects the output before it can authorize a plan', async () => {
    const { engine, repo, requests } = await setup();
    const run = await engine.create({ goal: 'Deliver', modelBudget: { moneyUsd: 0.00001 } });
    expect(await engine.advance(run.id)).toBe('failed');
    const stopped = await repo.get(run.id);
    expect(stopped.plans).toEqual([]);
    expect(stopped.modelUsage?.moneyUsd).toBeCloseTo(0.00002, 10);
    await expect(engine.command(run.id, 'retry', {})).rejects.toThrow('money budget exhausted');
    expect(requests).toHaveLength(1);
  });

  it('makes no model call for a zero USD budget', async () => {
    const { engine, requests } = await setup();
    const run = await engine.create({ goal: 'Deliver', modelBudget: { moneyUsd: 0 } });
    expect(await engine.advance(run.id)).toBe('failed'); expect(requests).toHaveLength(0);
  });

  it.each([
    { inputPricePerMillion: -1, outputPricePerMillion: 2, priceCurrency: 'USD' },
    { inputPricePerMillion: NaN, outputPricePerMillion: 2, priceCurrency: 'USD' },
    { inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: 'CNY' },
  ])('refuses unverified dollar prices before creating a Run: %j', async prices => {
    const { engine, repo, requests } = await setup(undefined, prices);
    await expect(engine.create({ goal: 'Deliver', modelBudget: { moneyUsd: 1 } })).rejects.toThrow('USD');
    expect(await repo.list()).toEqual([]); expect(requests).toEqual([]);
  });

  it('rejects dollar budgets on an unpriced model without claiming zero cost', async () => {
    const { repo, model } = await setup(); const engine = new AgentEngine(repo, model);
    await expect(engine.create({ goal: 'Deliver', modelBudget: { moneyUsd: 1 } })).rejects.toThrow('USD');
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 100 } });
    await engine.advance(run.id);
    expect((await repo.get(run.id)).modelUsage).toEqual({ tokens: 15, unreportedCalls: 0 });
  });

  it.each([undefined, { inputTokens: -1, outputTokens: 5 }, { inputTokens: 1.5, outputTokens: 5 }, { inputTokens: Infinity, outputTokens: 5 }])('does not let missing/invalid usage become a free retry: %j', async usage => {
    const { engine, repo, resolver, requests } = await setup(async () => ({ value: plan, ...(usage ? { usage } : {}) }));
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 100 } });
    expect(await engine.advance(run.id)).toBe('failed');
    expect((await repo.get(run.id)).modelUsage).toMatchObject({ tokens: 0, unreportedCalls: 1 });
    const resumed = new AgentEngine(repo, { resolver }); await resumed.recover();
    await expect(resumed.command(run.id, 'retry', {})).rejects.toThrow('usage is missing');
    expect(requests).toHaveLength(1);
  });

  it('reconciles an unknown call with the same key and settles its usage once', async () => {
    let first = true;
    const { engine, repo, resolver, requests } = await setup(async () => {
      if (first) { first = false; throw new ModelOutcomeUnknown('unconfirmed'); }
      return { value: plan, usage: reportedUsage };
    });
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 100 } });
    expect(await engine.advance(run.id)).toBe('unknown');
    const resumed = new AgentEngine(repo, { resolver }); await resumed.recover();
    await resumed.command(run.id, 'reconcile', { reason: 'Provider supports idempotent replay' });
    expect(await resumed.advance(run.id)).toBe('needs_approval');
    expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);
    expect((await repo.get(run.id)).calls).toHaveLength(1);
    expect((await repo.get(run.id)).modelUsage).toMatchObject({ tokens: 15, unreportedCalls: 0 });
    await resumed.advance(run.id);
    expect(requests).toHaveLength(2);
  });

  it('accepts an operator-confirmed model result without issuing a second provider request', async () => {
    const { engine, repo, requests } = await setup(async () => {
      throw new ModelOutcomeUnknown('provider response was confirmed by the billing portal');
    });
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 100 } });
    expect(await engine.advance(run.id)).toBe('unknown');
    const unknown = await repo.get(run.id);
    const call = unknown.calls[0]!;
    const reconciled = await engine.reconcileModelCall(run.id, {
      callId: call.id,
      idempotencyKey: call.idempotencyKey,
      inputHash: call.inputHash,
      outcome: 'completed',
      reason: 'Provider audit confirmed the response payload',
      output: plan,
      usage: reportedUsage,
    });
    expect(reconciled.status).toBe('planning');
    expect(await engine.advance(run.id)).toBe('needs_approval');
    const current = await repo.get(run.id);
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]).toMatchObject({ id: call.id, state: 'completed', inputHash: call.inputHash, usage: reportedUsage });
    expect(current.plans).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('restores an unknown model call and its reconciliation disposition after a File restart', async () => {
    const { engine, repo, resolver, requests, directory } = await setup(async () => {
      throw new ModelOutcomeUnknown('provider response was interrupted');
    });
    const run = await engine.create({ goal: 'Deliver' });
    expect(await engine.advance(run.id)).toBe('unknown');
    const unknown = await repo.get(run.id); const call = unknown.calls[0]!;
    const resourceIndex = resources.findIndex(resource => resource.repo === repo);
    if (resourceIndex >= 0) resources.splice(resourceIndex, 1);
    await repo.close();
    const reopened = new FileRunRepository(directory); await reopened.init();
    const resumed = new AgentEngine(reopened, { resolver });
    const reconciled = await resumed.reconcileModelCall(run.id, {
      callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash,
      outcome: 'completed', reason: 'Provider audit confirmed the payload', output: plan, usage: reportedUsage,
    });
    expect(await resumed.advance(run.id)).toBe('needs_approval');
    expect(reconciled.reconcileDisposition).toBeUndefined();
    expect(requests).toHaveLength(1);
    await reopened.close();
  });

  it('exposes model reconciliation through the owner-scoped HTTP boundary', async () => {
    const { engine, repo, requests } = await setup(async () => {
      throw new ModelOutcomeUnknown('provider response was interrupted');
    });
    const app = buildApp({ engine, repository: repo, dispatcher: { notify: async () => {}, close: async () => {} } });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Deliver' } });
      expect(created.statusCode).toBe(202);
      const runId = created.json().id as string;
      await engine.advance(runId);
      const unknown = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
      const call = unknown.calls[0];
      const reconciled = await app.inject({ method: 'POST', url: `/api/runs/${runId}/model-reconcile`, payload: {
        callId: call.id,
        idempotencyKey: call.idempotencyKey,
        inputHash: call.inputHash,
        outcome: 'completed',
        reason: 'Provider audit confirmed the response',
        output: plan,
        usage: reportedUsage,
      } });
      expect(reconciled.statusCode).toBe(200);
      await engine.advance(runId);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json()).toMatchObject({ status: 'needs_approval', plans: [{ nodes: plan.nodes }] });
      expect(requests).toHaveLength(1);
    } finally { await app.close(); }
  });

  it('rejects mismatched model receipts and records an explicitly failed provider outcome', async () => {
    const { engine, repo } = await setup(async () => { throw new ModelOutcomeUnknown('provider timeout'); });
    const run = await engine.create({ goal: 'Deliver' });
    await engine.advance(run.id);
    const unknown = await repo.get(run.id);
    const call = unknown.calls[0]!;
    await expect(engine.reconcileModelCall(run.id, {
      callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: 'f'.repeat(64), outcome: 'failed', reason: 'wrong request receipt',
    })).rejects.toThrow('input hash');
    const failed = await engine.reconcileModelCall(run.id, {
      callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash, outcome: 'failed', reason: 'Provider confirmed no response was committed',
    });
    expect(failed.status).toBe('failed');
    expect((await repo.get(run.id)).calls[0]).toMatchObject({ state: 'failed', inputHash: call.inputHash });
  });

  it.each(['cancel', 'pause'] as const)('accounts in-flight results after %s and preserves control state', async action => {
    let resolve!: (value: ModelResponse) => void; let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const result = new Promise<ModelResponse>(done => { resolve = done; });
    const { engine, repo } = await setup(async () => { entered(); return result; });
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 10 } });
    const advancing = engine.advance(run.id); await started;
    await engine.command(run.id, action, {});
    resolve({ value: plan, usage: reportedUsage }); await advancing;
    const completed = await repo.get(run.id);
    expect(completed.status).toBe(action === 'cancel' ? 'cancelled' : 'paused');
    expect(completed.modelUsage).toMatchObject({ tokens: 15, unreportedCalls: 0 });
    expect(completed.plans).toEqual([]);
    if (action === 'pause') expect(completed.resumeStatus).toBe('failed');
    else expect(completed.calls[0]?.state).toBe('discarded');
  });

  it('settles a reconciled result after cancellation without reviving the Run', async () => {
    let reject!: (error: unknown) => void; let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const pending = new Promise<ModelResponse>((_resolve, fail) => { reject = fail; });
    const { engine, repo } = await setup(async () => { entered(); return pending; });
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 100 } });
    const advancing = engine.advance(run.id); await started;
    await engine.command(run.id, 'cancel', {});
    reject(new ModelOutcomeUnknown('provider response arrived after cancellation'));
    await advancing;
    const unknown = await repo.get(run.id); const call = unknown.calls[0]!;
    const reconciled = await engine.reconcileModelCall(run.id, {
      callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash,
      outcome: 'completed', reason: 'Provider audit located the response', output: plan, usage: reportedUsage,
    });
    expect(reconciled.status).toBe('cancelled');
    expect((await repo.get(run.id)).calls[0]?.state).toBe('discarded');
    expect((await repo.get(run.id)).plans).toEqual([]);
  });

  it('keeps a paused Run paused while staging a reconciled result', async () => {
    let reject!: (error: unknown) => void; let entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const pending = new Promise<ModelResponse>((_resolve, fail) => { reject = fail; });
    const { engine, repo } = await setup(async () => { entered(); return pending; });
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 100 } });
    const advancing = engine.advance(run.id); await started;
    await engine.command(run.id, 'pause', {});
    reject(new ModelOutcomeUnknown('provider response interrupted during pause'));
    await advancing;
    const unknown = await repo.get(run.id); const call = unknown.calls[0]!;
    const reconciled = await engine.reconcileModelCall(run.id, {
      callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash,
      outcome: 'completed', reason: 'Provider audit located the response', output: plan, usage: reportedUsage,
    });
    expect(reconciled.status).toBe('paused');
    expect(reconciled.resumeStatus).toBe('planning');
    await engine.command(run.id, 'resume', {});
    expect(await engine.advance(run.id)).toBe('needs_approval');
  });

  it('charges unusable provider output and blocks retry if that consumed the budget', async () => {
    const { engine, repo } = await setup(async () => { throw new ModelResponseRejected('Incomplete output', reportedUsage); });
    const run = await engine.create({ goal: 'Deliver', modelBudget: { tokens: 15 } });
    await engine.advance(run.id);
    expect((await repo.get(run.id)).modelUsage).toMatchObject({ tokens: 15, unreportedCalls: 0 });
    await expect(engine.command(run.id, 'retry', {})).rejects.toThrow('budget exhausted');
  });

  it('accepts budgets through the HTTP API, validates input and persists totals', async () => {
    const { engine, repo } = await setup();
    const app = buildApp({ engine, repository: repo, dispatcher: { notify: async () => {}, close: async () => {} } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Deliver', modelBudget: { tokens: 100, moneyUsd: 1 } } });
      expect(response.statusCode).toBe(202);
      await engine.advance(response.json().id);
      const get = await app.inject({ method: 'GET', url: `/api/runs/${response.json().id}` });
      expect(get.json()).toMatchObject({ modelBudget: { tokens: 100, moneyUsd: 1 }, modelUsage: { tokens: 15, unreportedCalls: 0 } });
      for (const modelBudget of [{}, { tokens: -1 }, { moneyUsd: -1 }, { tokens: 2.5 }, { moneyUsd: 1, currency: 'USD' }]) {
        const bad = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Deliver', modelBudget } });
        expect(bad.statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });
});
