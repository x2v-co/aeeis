import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PiModelAdapter, type PiToolBinding } from '../src/adapters/pi/model.js';
import type { Receipt, ToolGateway, ToolInvocation, ToolResult } from '../src/integrations.js';
import { AgentEngine, digest } from '../src/runtime/engine.js';
import { CatalogModelResolver } from '../src/runtime/model-router.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';
import { piModel, piPin, recordingFetch, responses, type ResponsesUsage } from './support/pi-fixture.js';

const input = z.object({ key: z.string() });
const binding: PiToolBinding = { name: 'fixture_lookup', toolId: 'fixture.lookup', toolVersion: '1', description: 'Read fixture status', input };
const plan = { summary: 'Check the fixture', nodes: [{ id: 'operate', title: 'Check status', instruction: 'Read status with the approved capability and report its evidence', dependsOn: [] }] };
const finish = { type: 'finish', title: 'Verified status', content: 'The approved tool returned green.', evidenceRefs: ['tool-output-1'] };
const review = { verdict: 'accepted', summary: 'Receipt-backed status verified', issues: [] };
const resources: Array<{ directory: string; repo: FileRunRepository }> = [];
const ledgers: InMemoryGlobalBudgetLedger[] = [];
afterEach(async () => {
  for (const { directory, repo } of resources.splice(0)) {
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  }
  for (const ledger of ledgers.splice(0)) await ledger.close();
});
async function globalBudget(budget: { tokens?: number; moneyUsd?: number }) {
  const ledger = new InMemoryGlobalBudgetLedger();
  ledgers.push(ledger);
  await ledger.init();
  return { ledger, select: createGlobalBudgetSelector([{ window: 'none', budget: { calls: 10, ...budget } }]) };
}
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-pi-runtime-'));
  const repo = new FileRunRepository(directory);
  resources.push({ directory, repo });
  await repo.init();
  return { directory, repo };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function adapter(fetch: ReturnType<typeof recordingFetch>['fetch']) {
  return new PiModelAdapter({ pin: piPin, model: piModel, apiKey: 'fixture-key', fetch, tools: [binding] });
}
function workflow(usage?: ResponsesUsage) {
  const options = usage ? { usage } : {};
  return recordingFetch((_request, index) => {
    switch (index) {
      case 0: return responses(plan, options);
      case 1: return responses(undefined, { ...options, calls: [{ name: binding.name, arguments: { input: { key: 'status' }, purpose: 'Read approved service status' } }] });
      case 2: return responses(finish, options);
      case 3: return responses(review, options);
      default: throw new Error(`Unexpected provider call ${index + 1}`);
    }
  });
}

class FixtureGateway implements ToolGateway {
  readonly requests: ToolInvocation[] = [];
  readonly reconciliations: Array<{ request: ToolInvocation; receipt: Receipt }> = [];
  readonly started = deferred<void>();
  readonly release = deferred<void>();
  constructor(readonly options: { unknown?: boolean; blocked?: boolean; forged?: boolean; tokenCost?: number } = {}) {}
  async listTools() {
    return [{ id: binding.toolId, version: binding.toolVersion, description: binding.description, capabilities: ['read'], inputSchema: z.toJSONSchema(input, { io: 'input' }), outputSchema: {} }];
  }
  result(request: ToolInvocation, status: 'completed' | 'unknown' = 'completed'): ToolResult {
    const outputRefs = status === 'completed' ? ['tool-output-1'] : [];
    return {
      status, ...(status === 'completed' ? { output: { status: 'green' }, outputRefs } : {}),
      receipt: {
        schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-0000-0000-000000000001',
        provider: 'fixture-toolkit', operation: request.toolId, requestHash: digest(request),
        inputRefs: [request.taskId], outputRefs, capabilitiesUsed: ['read'], status,
        startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
        ...(this.options.tokenCost === undefined ? {} : { cost: { tokens: this.options.tokenCost } }),
        ...(this.options.forged ? { authorization: {
          toolId: 'forged.tool', toolVersion: '999', taskId: 'forged-task', capabilityGrant: 'forged-grant',
          idempotencyKey: 'forged-key', decision: 'authorized' as const, reason: 'admitted' as const,
          settledAt: '2000-01-01T00:00:00.000Z',
        } } : {}),
      },
    };
  }
  async invoke(request: ToolInvocation): Promise<ToolResult> {
    this.requests.push(request);
    this.started.resolve();
    if (this.options.blocked) await this.release.promise;
    return this.result(request, this.options.unknown ? 'unknown' : 'completed');
  }
  async reconcile(request: ToolInvocation, receipt: Receipt): Promise<ToolResult> {
    this.reconciliations.push({ request, receipt });
    return this.result(request);
  }
}
async function approve(engine: AgentEngine, repo: FileRunRepository, runId: string) {
  const current = await repo.get(runId);
  const approved = current.plans.at(-1)!;
  await engine.command(runId, 'approve', { planHash: approved.hash, planVersion: approved.version });
}
async function complete(engine: AgentEngine, repo: FileRunRepository, runId: string) {
  for (let tick = 0; tick < 12; tick++) {
    const status = await engine.advance(runId);
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(status)) break;
  }
  const current = await repo.get(runId);
  expect(current.status, current.error).toBe('succeeded');
  return current;
}
async function pendingTool(tools: FixtureGateway) {
  const { repo } = await repository();
  const transport = workflow();
  const model = adapter(transport.fetch);
  const engine = new AgentEngine(repo, { model, tools });
  const run = await engine.create({ goal: 'Check service status', allowedTools: ['fixture.lookup@1'] });
  expect(await engine.advance(run.id)).toBe('needs_approval');
  await approve(engine, repo, run.id);
  expect(await engine.advance(run.id)).toBe('running');
  expect((await repo.get(run.id)).pendingTool).toMatchObject({ toolId: binding.toolId, toolVersion: '1', input: { key: 'status' } });
  expect(tools.requests).toHaveLength(0);
  return { repo, transport, engine, run };
}

describe('Pi Responses adapter through the durable AEEIS runtime', () => {
  it('requires the exact plan hash and version before invoking one native call and finishing with receipt evidence', async () => {
    const { repo } = await repository();
    const transport = workflow();
    const tools = new FixtureGateway();
    const engine = new AgentEngine(repo, { model: adapter(transport.fetch), tools });
    const run = await engine.create({ goal: 'Check service status', allowedTools: ['fixture.lookup@1'] });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    const planned = await repo.get(run.id);
    const approved = planned.plans[0]!;
    await expect(engine.command(run.id, 'approve', { planHash: 'wrong', planVersion: approved.version })).rejects.toThrow();
    await expect(engine.command(run.id, 'approve', { planHash: approved.hash, planVersion: approved.version + 1 })).rejects.toThrow();
    expect(await engine.advance(run.id)).toBe('needs_approval');
    expect(tools.requests).toHaveLength(0);
    expect(transport.requests).toHaveLength(1);
    expect(planned.calls.map(call => call.phase)).toEqual(['planner']);
    await approve(engine, repo, run.id);
    // Native calls are proposals: this tick persists the pending tool, but cannot execute it.
    expect(await engine.advance(run.id)).toBe('running');
    expect(tools.requests).toHaveLength(0);
    expect((await repo.get(run.id)).pendingTool).toMatchObject({ toolId: binding.toolId, toolVersion: '1', input: { key: 'status' }, purpose: 'Read approved service status' });
    const current = await complete(engine, repo, run.id);
    expect(tools.requests).toHaveLength(1);
    expect(tools.requests[0]).not.toHaveProperty('executionToken');
    expect(tools.requests[0]?.idempotencyKey).toContain(run.id);
    expect(current.toolReceipts).toHaveLength(1);
    expect(current.toolReceipts[0]?.authorization).toMatchObject({ toolId: binding.toolId, toolVersion: '1', taskId: 'operate', decision: 'authorized', reason: 'admitted' });
    expect(current.artifacts[0]?.evidenceRefs).toEqual(['tool-output-1']);
    expect(current.review?.verdict).toBe('accepted');
    expect(transport.requests).toHaveLength(4);
    expect(transport.requests[0]?.body.tools ?? []).toEqual([]);
    expect(transport.requests[1]?.body.tools).toEqual([expect.objectContaining({ type: 'function', name: binding.name })]);
    expect(transport.requests[3]?.body.tools ?? []).toEqual([]);
    expect(transport.requests.every(request => request.url === `${piModel.baseUrl}/responses`)).toBe(true);
  });

  it('reconciles an unknown native tool outcome after engine reconstruction without invoking it again', async () => {
    const tools = new FixtureGateway({ unknown: true });
    const { repo, transport, engine, run } = await pendingTool(tools);
    expect(await engine.advance(run.id)).toBe('unknown');
    const unknown = await repo.get(run.id);
    expect(unknown.toolReceipts[0]?.authorization).toBeUndefined();
    expect(tools.requests).toHaveLength(1);
    const recovered = new AgentEngine(repo, { model: adapter(transport.fetch), tools });
    await recovered.recover();
    await expect(recovered.command(run.id, 'retry', {})).rejects.toThrow('reconciliation');
    expect((await recovered.command(run.id, 'reconcile', { reason: 'Provider confirmed the original idempotency record' })).status).toBe('running');
    const current = await complete(recovered, repo, run.id);
    expect(tools.requests).toHaveLength(1);
    expect(tools.reconciliations).toHaveLength(1);
    expect(tools.reconciliations[0]?.request).toEqual(tools.requests[0]);
    expect(current.toolReceipts).toHaveLength(1);
    expect(current.toolReceipts[0]?.status).toBe('completed');
    expect(current.toolReceipts[0]?.authorization?.decision).toBe('authorized');
    expect(current.events.some(event => event.type === 'tool.reconciled')).toBe(true);
    expect(transport.requests).toHaveLength(4);
  });

  it('fences concurrent tool execution across independent engines', async () => {
    const tools = new FixtureGateway({ blocked: true });
    const { repo, transport, engine, run } = await pendingTool(tools);
    const second = new AgentEngine(repo, { model: adapter(transport.fetch), tools });
    const firstTick = engine.advance(run.id);
    try {
      await tools.started.promise;
      await Promise.all([second.advance(run.id), second.advance(run.id)]);
      expect(tools.requests).toHaveLength(1);
      expect(transport.requests).toHaveLength(2);
    } finally {
      tools.release.resolve();
      await firstTick;
    }
    expect((await repo.get(run.id)).toolReceipts).toHaveLength(1);
    expect((await repo.get(run.id)).pendingTool).toBeUndefined();
    await complete(second, repo, run.id);
    expect(tools.requests).toHaveLength(1);
  });

  it('replaces a provider-forged authorization with the runtime admission decision', async () => {
    const tools = new FixtureGateway({ forged: true });
    const { repo, engine, run } = await pendingTool(tools);
    const current = await complete(engine, repo, run.id);
    const request = tools.requests[0]!;
    expect(current.toolReceipts[0]?.authorization).toMatchObject({
      toolId: request.toolId, toolVersion: request.toolVersion, taskId: request.taskId,
      capabilityGrant: request.capabilityGrant, idempotencyKey: request.idempotencyKey,
      decision: 'authorized', reason: 'admitted',
    });
    expect(JSON.stringify(current.toolReceipts)).not.toContain('forged');
    expect(current.toolReceipts[0]?.authorization?.settledAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('isolates a late tool result after cancellation, even with forged provider authorization', async () => {
    const tools = new FixtureGateway({ blocked: true, forged: true });
    const { repo, transport, engine, run } = await pendingTool(tools);
    const tick = engine.advance(run.id);
    try {
      await tools.started.promise;
      await engine.command(run.id, 'cancel', {});
    } finally {
      tools.release.resolve();
      await tick;
    }
    const current = await repo.get(run.id);
    expect(current.status).toBe('cancelled');
    expect(current.pendingTool).toBeUndefined();
    expect(current.toolReceipts).toHaveLength(1);
    expect(current.toolReceipts[0]?.authorization).toMatchObject({ toolId: binding.toolId, toolVersion: '1', taskId: 'operate', decision: 'isolated', reason: 'cancelled' });
    expect(current.steps[0]?.observations).toEqual([]);
    expect(current.artifacts).toEqual([]);
    expect(current.events.some(event => event.type === 'tool.result_discarded')).toBe(true);
    expect(await engine.advance(run.id)).toBe('cancelled');
    expect(tools.requests).toHaveLength(1);
    expect(transport.requests).toHaveLength(2);
  });

  it('reserves only one model call and cannot revive a cancelled run with its late SSE result', async () => {
    const { repo } = await repository();
    const entered = deferred<void>();
    const release = deferred<void>();
    const transport = recordingFetch(async () => {
      entered.resolve();
      await release.promise;
      return responses(plan);
    });
    const engine = new AgentEngine(repo, { model: adapter(transport.fetch) });
    const second = new AgentEngine(repo, { model: adapter(transport.fetch) });
    const run = await engine.create({ goal: 'Cancel planning safely' });
    const tick = engine.advance(run.id);
    try {
      await entered.promise;
      await Promise.all([second.advance(run.id), engine.advance(run.id)]);
      expect(transport.requests).toHaveLength(1);
      await second.command(run.id, 'cancel', {});
    } finally {
      release.resolve();
      await tick;
    }
    const current = await repo.get(run.id);
    expect(current.status).toBe('cancelled');
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]?.state).toBe('discarded');
    expect(current.plans).toEqual([]);
    expect(current.artifacts).toEqual([]);
    expect(await second.advance(run.id)).toBe('cancelled');
    expect(transport.requests).toHaveLength(1);
  });

  it.each(['local validation', 'HTTP rejection'] as const)('settles known zero consumption for %s instead of leaving an unknown budget reservation', async kind => {
    const { repo } = await repository();
    const transport = recordingFetch(() => new Response('{"error":{"message":"fixture authorization rejected"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
    const model = adapter(transport.fetch);
    const budget = await globalBudget({ tokens: 1_000 });
    const engine = new AgentEngine(repo, { model: {
      pin: model.pin,
      complete: request => model.complete(request),
      requestDefaults: () => ({ ...model.requestDefaults(), ...(kind === 'local validation' ? { thinking: 'auto' as const } : {}) }),
    }, globalBudget: budget });
    const run = await engine.create({ goal: 'Account for a definitely rejected request', modelBudget: { tokens: 1_000 } });
    expect(await engine.advance(run.id)).toBe('failed');
    const current = await repo.get(run.id);
    expect(current.calls[0]).toMatchObject({ state: 'failed', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(current.modelUsage).toEqual({ tokens: 0, unreportedCalls: 0 });
    const account = await budget.ledger.get(current.calls[0]!.globalBudgetAccountKey!);
    expect(account).toMatchObject({ usedTokens: 0, unreportedTokenCalls: 0 });
    expect(Object.values(account!.entries)[0]).toMatchObject({ state: 'settled', usage: { tokens: 0 } });
    expect(transport.requests).toHaveLength(kind === 'local validation' ? 0 : 1);
  });

  it('rejects a run USD budget before any model request, despite frozen catalog prices', async () => {
    const { repo } = await repository();
    const transport = workflow();
    const model = adapter(transport.fetch);
    const tools = new FixtureGateway();
    const resolver = new CatalogModelResolver({ list: async () => [{
      model: piPin.model, provider: 'openai', endpoint: piPin.endpoint, capabilities: ['agent'],
      inputPricePerMillion: 10, outputPricePerMillion: 20, priceCurrency: 'USD',
    }] }, { create: () => model });
    const engine = new AgentEngine(repo, { resolver, tools });
    await expect(engine.create({ goal: 'Do not guess model charges', allowedTools: ['fixture.lookup@1'], modelBudget: { moneyUsd: 1 } })).rejects.toThrow(/tokens-only|USD/);
    expect(await repo.list()).toEqual([]);
    expect(tools.requests).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects a global USD budget before any model request, despite frozen catalog prices', async () => {
    const { repo } = await repository();
    const transport = workflow();
    const model = adapter(transport.fetch);
    const prices = { inputPricePerMillion: 10, outputPricePerMillion: 20, priceCurrency: 'USD' };
    const resolver = new CatalogModelResolver({ list: async () => [{ model: piPin.model, provider: 'openai', endpoint: piPin.endpoint, capabilities: ['agent'], ...prices }] }, { create: () => model });
    const budget = await globalBudget({ tokens: 1_000, moneyUsd: 1 });
    const engine = new AgentEngine(repo, { resolver, globalBudget: budget });
    const run = await engine.create({ goal: 'Reject unverifiable global USD spending' });
    expect(run.modelDecision).toMatchObject({ selected: prices });
    expect(run.model.usageAccounting).toBe('tokens-only');
    expect(await engine.advance(run.id)).toBe('failed');
    const current = await repo.get(run.id);
    expect(current.error).toMatch(/tokens-only|USD/);
    expect(current.calls).toEqual([]);
    const selection = budget.select(undefined, run.createdAt)!;
    expect(await budget.ledger.get(selection.accountKey)).toBeUndefined();
    expect(transport.requests).toHaveLength(0);
  });

  it.each(['invalid arguments', 'multiple calls', 'length', 'provider failure'] as const)('persists and globally accounts usage on a rejected %s response', async kind => {
    const { repo } = await repository();
    const usage: ResponsesUsage = {
      input_tokens: 120, output_tokens: 30, total_tokens: 150,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 8 },
    };
    const nativeCall = { name: binding.name, arguments: { input: { key: 'status' }, purpose: 'Read status' } };
    const transport = recordingFetch((_request, index) => {
      if (index === 0) return responses(plan);
      if (index !== 1) throw new Error('Rejected response must not trigger a provider retry');
      if (kind === 'invalid arguments') return responses(undefined, { usage, calls: [{ ...nativeCall, arguments: '{"input":{"key":"status"},"purpose":"Read status"' }] });
      if (kind === 'multiple calls') return responses(undefined, { usage, calls: [nativeCall, nativeCall] });
      return responses(finish, { usage, stopReason: kind === 'length' ? 'length' : 'error' });
    });
    const tools = new FixtureGateway();
    const budget = await globalBudget({ tokens: 1_000 });
    const engine = new AgentEngine(repo, { model: adapter(transport.fetch), tools, globalBudget: budget });
    const run = await engine.create({ goal: 'Retain billing for a rejected response', allowedTools: ['fixture.lookup@1'], modelBudget: { tokens: 1_000 } });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    await approve(engine, repo, run.id);
    expect(await engine.advance(run.id)).toBe('failed');
    const current = await repo.get(run.id);
    const call = current.calls[1]!;
    expect(call.state).toBe('failed');
    expect(current.error).toContain({
      'invalid arguments': 'strict validation', 'multiple calls': 'multiple native tool calls',
      length: 'not complete: length', 'provider failure': 'provider rejected the response',
    }[kind]);
    expect(call.usage).toEqual({ inputTokens: 120, outputTokens: 30, details: {
      source: 'pi-ai/1.3.0', accounting: 'tokens-only', reported: usage,
      cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 8,
      // pi does not populate its normalized counters for response.failed; raw provider usage still bills 150 tokens.
      normalized: kind === 'provider failure'
        ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }
        : { input: 70, output: 30, cacheRead: 40, cacheWrite: 10, totalTokens: 150 },
    } });
    expect(current.modelUsage).toEqual({ tokens: 175, unreportedCalls: 0 });
    const account = await budget.ledger.get(call.globalBudgetAccountKey!);
    expect(account).toMatchObject({ usedCalls: 2, usedTokens: 175, unreportedTokenCalls: 0 });
    expect(account?.entries[`aeeis:model:${run.id}:${call.id}`]).toMatchObject({ state: 'settled', usage: { tokens: 150 } });
    expect(tools.requests).toHaveLength(0);
    expect(current.pendingTool).toBeUndefined();
    expect(current.toolReceipts).toEqual([]);
    expect(await engine.advance(run.id)).toBe('failed');
    expect(transport.requests).toHaveLength(2);
    expect(await budget.ledger.get(call.globalBudgetAccountKey!)).toEqual(account);
  });

  it.each(['run', 'global'] as const)('does not turn missing usage into zero and stops a %s token budget', async scope => {
    const { repo } = await repository();
    const transport = recordingFetch(() => responses(plan, { usage: null }));
    const model = adapter(transport.fetch);
    const budget = await globalBudget({ tokens: 1_000 });
    const engine = new AgentEngine(repo, { model, ...(scope === 'global' ? { globalBudget: budget } : {}) });
    const run = await engine.create({ goal: 'Do not guess missing tokens', ...(scope === 'run' ? { modelBudget: { tokens: 1_000 } } : {}) });
    expect(await engine.advance(run.id)).toBe('failed');
    const current = await repo.get(run.id);
    expect(current.calls[0]).not.toHaveProperty('usage');
    expect(current.modelUsage).toEqual({ tokens: 0, unreportedCalls: 1 });
    expect(current.error).toMatch(/usage.*(?:reported|required)/i);
    expect(await engine.advance(run.id)).toBe('failed');
    if (scope === 'global') {
      const call = current.calls[0]!;
      const account = await budget.ledger.get(call.globalBudgetAccountKey!);
      expect(account).toMatchObject({ usedCalls: 1, usedTokens: 0, unreportedTokenCalls: 1 });
      expect(account?.entries[`aeeis:model:${run.id}:${call.id}`]).toMatchObject({ state: 'rejected', usage: {} });
      expect(account?.entries[`aeeis:model:${run.id}:${call.id}`]?.usage).not.toHaveProperty('tokens');
      const next = await engine.create({ goal: 'Must not continue after missing tokens' });
      expect(await engine.advance(next.id)).toBe('failed');
      expect((await repo.get(next.id)).error).toContain('Global token usage is missing');
      expect(await budget.ledger.get(call.globalBudgetAccountKey!)).toEqual(account);
    }
    expect(transport.requests).toHaveLength(1);
  });

  it('keeps reconciled model usage tokens-only after restart even when the operator supplies no details', async () => {
    const { directory, repo } = await repository();
    const transport = recordingFetch(() => { throw new Error('Fixture connection lost after dispatch'); });
    const model = adapter(transport.fetch);
    const prices = { inputPricePerMillion: 10, outputPricePerMillion: 20, priceCurrency: 'USD' };
    const resolver = new CatalogModelResolver({ list: async () => [{ model: piPin.model, provider: 'openai', endpoint: piPin.endpoint, capabilities: ['agent'], ...prices }] }, { create: () => model });
    const budget = await globalBudget({ tokens: 1_000 });
    const engine = new AgentEngine(repo, { resolver, globalBudget: budget });
    const run = await engine.create({ goal: 'Reconcile an ambiguous pi model call', modelBudget: { tokens: 1_000 } });
    expect(await engine.advance(run.id)).toBe('unknown');
    await repo.close();
    const reopened = new FileRunRepository(directory);
    resources.find(resource => resource.repo === repo)!.repo = reopened;
    await reopened.init();
    const recovered = new AgentEngine(reopened, { resolver, globalBudget: budget });
    await recovered.recover();
    const unknown = await reopened.get(run.id);
    expect(unknown.model.usageAccounting).toBe('tokens-only');
    expect(unknown.modelDecision).toMatchObject({ selected: prices });
    const call = unknown.calls[0]!;
    const simpleUsage = { inputTokens: 120, outputTokens: 30 };
    await recovered.reconcileModelCall(run.id, {
      callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash,
      outcome: 'completed', output: plan, usage: simpleUsage, reason: 'Provider located the original result',
      reconciliation: { source: 'provider', provider: 'fixture', reference: 'fixture-billing-record', reason: 'Matched the original idempotency key' },
    });
    expect(await recovered.advance(run.id)).toBe('needs_approval');
    const current = await reopened.get(run.id);
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]?.usage).toEqual(simpleUsage);
    expect(current.calls[0]?.usage).not.toHaveProperty('details');
    expect(current.modelUsage).toEqual({ tokens: 150, unreportedCalls: 0 });
    expect(current.modelUsage).not.toHaveProperty('moneyUsd');
    const account = await budget.ledger.get(call.globalBudgetAccountKey!);
    expect(account).toMatchObject({ usedCalls: 1, usedTokens: 150, usedMoneyUsd: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 1 });
    expect(account?.entries[`aeeis:model:${run.id}:${call.id}`]).toMatchObject({ state: 'settled', usage: { tokens: 150 } });
    expect(account?.entries[`aeeis:model:${run.id}:${call.id}`]?.usage).not.toHaveProperty('moneyUsd');
    expect(await recovered.advance(run.id)).toBe('needs_approval');
    expect(transport.requests).toHaveLength(1);
    expect(await budget.ledger.get(call.globalBudgetAccountKey!)).toEqual(account);
  });

  it('persists raw/normalized usage, counts cached input once, and never fabricates USD from frozen prices', async () => {
    const { directory, repo } = await repository();
    const usage: ResponsesUsage = {
      input_tokens: 120, output_tokens: 30, total_tokens: 150,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
      output_tokens_details: { reasoning_tokens: 8 },
    };
    const transport = workflow(usage);
    const model = adapter(transport.fetch);
    // The shared token budget covers tools too; this fixture explicitly reports a zero-token tool charge.
    const tools = new FixtureGateway({ tokenCost: 0 });
    const prices = { inputPricePerMillion: 10, outputPricePerMillion: 20, priceCurrency: 'USD' };
    const resolver = new CatalogModelResolver({ list: async () => [{ model: piPin.model, provider: 'openai', endpoint: piPin.endpoint, capabilities: ['agent'], ...prices }] }, { create: () => model });
    const budget = await globalBudget({ tokens: 1_000 });
    const engine = new AgentEngine(repo, { resolver, tools, globalBudget: budget });
    const run = await engine.create({ goal: 'Account for cached native tool workflow', allowedTools: ['fixture.lookup@1'], modelBudget: { tokens: 1_000 } });
    expect(run.modelDecision).toMatchObject({ selected: prices });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    await approve(engine, repo, run.id);
    await complete(engine, repo, run.id);
    await repo.close();
    const reopened = new FileRunRepository(directory);
    resources.find(resource => resource.repo === repo)!.repo = reopened;
    await reopened.init();
    const persisted = await reopened.get(run.id);
    expect(persisted.calls).toHaveLength(4);
    for (const call of persisted.calls) {
      expect(call.usage).toEqual({
        inputTokens: 120, outputTokens: 30,
        details: {
          source: 'pi-ai/1.3.0', accounting: 'tokens-only', reported: usage, cacheReadTokens: 40, cacheWriteTokens: 10, reasoningTokens: 8,
          normalized: { input: 70, output: 30, cacheRead: 40, cacheWrite: 10, totalTokens: 150 },
        },
      });
    }
    expect(persisted.modelUsage).toEqual({ tokens: 600, unreportedCalls: 0 });
    expect(persisted.modelUsage).not.toHaveProperty('moneyUsd');
    const account = await budget.ledger.get(persisted.calls[0]!.globalBudgetAccountKey!);
    expect(account).toMatchObject({ usedCalls: 5, usedTokens: 600, usedMoneyUsd: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 5 });
    for (const call of persisted.calls) {
      const entry = account?.entries[`aeeis:model:${run.id}:${call.id}`];
      expect(entry).toMatchObject({ state: 'settled', usage: { tokens: 150 } });
      expect(entry?.usage).not.toHaveProperty('moneyUsd');
    }
    const recovered = new AgentEngine(reopened, { resolver, tools, globalBudget: budget });
    expect(await recovered.advance(run.id)).toBe('succeeded');
    expect((await reopened.get(run.id)).modelUsage).toEqual(persisted.modelUsage);
    expect(await budget.ledger.get(persisted.calls[0]!.globalBudgetAccountKey!)).toEqual(account);
    expect(transport.requests).toHaveLength(4);
  });
});
