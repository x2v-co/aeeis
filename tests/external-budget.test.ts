import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import type { Receipt, ToolGateway, ToolInvocation, ToolResult } from '../src/integrations.js';
import { AgentDirectory, AgentGateway, type AgentTransportResponse, type DelegationRequest } from '../src/agent-gateway.js';
import { InMemoryGrantLedger } from '../src/agent-ledger.js';
import { projectRunGraphs } from '../src/runtime/graphs.js';
import type { ExternalBudget } from '../src/runtime/contracts.js';

const resources: Array<{ directory: string; repo: FileRunRepository }> = [];
afterEach(async () => { for (const { directory, repo } of resources.splice(0)) { await repo.close(); await rm(directory, { recursive: true, force: true }); } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function toolResult(request: ToolInvocation, cost?: Receipt['cost'], status: ToolResult['status'] = 'completed'): ToolResult {
  return { status, output: 'tool output', receipt: {
    schemaVersion: 'receipt/1', receiptId: `receipt_${randomUUID()}`, provider: 'fixture', operation: request.toolId,
    requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: [], capabilitiesUsed: [],
    startedAt: new Date().toISOString(), status, ...(cost ? { cost } : {}),
  } };
}
function agentResult(request: DelegationRequest, cost: { tokens?: number; money?: number; currency?: string } = {}, status: 'completed' | 'accepted' = 'completed'): AgentTransportResponse {
  const receiptRef = `receipt_${randomUUID()}`;
  return { status, receiptRef,
    acknowledgement: { schemaVersion: 'context-ack/1', taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true },
    ...(status === 'accepted' ? {} : { result: {
      schemaVersion: 'result-envelope/1' as const, taskId: request.taskBrief.taskId, agentId: request.agentId, status,
      resultType: 'research/1', summary: 'Agent output', claims: [], artifacts: [], unresolved: [], requestedFollowups: [],
      cost, capabilitiesUsed: [], contextVersion: request.contextPack.id, receiptRef,
    } }),
  };
}
async function setup(options: { cost?: Receipt['cost']; sequence?: Array<'tool' | 'agent'>; ledger?: InMemoryGrantLedger; invoke?: ToolGateway['invoke']; submit?: (request: DelegationRequest) => Promise<AgentTransportResponse> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-external-budget-'));
  const repo = new FileRunRepository(directory); await repo.init(); resources.push({ directory, repo });
  let toolCalls = 0, agentCalls = 0, modelCalls = 0, reconciles = 0;
  const tools: ToolGateway = {
    listTools: async () => [{ id: 'lookup', version: '1', capabilities: ['read'], inputSchema: {}, outputSchema: {} }],
    invoke: async request => { toolCalls++; return options.invoke ? options.invoke(request) : toolResult(request, options.cost); },
    reconcile: async request => { reconciles++; return toolResult(request, options.cost); },
  };
  const registry = new AgentDirectory();
  registry.register({ schemaVersion: 'agent-card/1', agentId: 'agent.partner', name: 'Partner', owner: 'partner', protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'], outputSchemas: ['result-envelope/1'], auth: ['local'], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1' });
  const agents = new AgentGateway(registry, {
    submit: async (_card, request) => { agentCalls++; return options.submit ? options.submit(request) : agentResult(request, options.cost); },
    reconcile: async (_card, request) => { reconciles++; return agentResult(request, options.cost); },
  }, options.ledger);
  const model: ModelAdapter = {
    pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
    complete: async request => {
      modelCalls++;
      const input = request.input as { observations?: unknown[] };
      const next = (options.sequence ?? ['tool'])[input.observations?.length ?? 0];
      const value = request.system.includes('Plan a real deliverable')
        ? { summary: 'Use capabilities', nodes: [{ id: 'work', title: 'Work', instruction: 'Inspect and deliver', dependsOn: [] }] }
        : request.system.includes('Independently review') ? { verdict: 'accepted', summary: 'Done', issues: [] }
        : next === 'tool' ? { type: 'capability', toolId: 'lookup', toolVersion: '1', input: {}, purpose: 'Inspect' }
        : next === 'agent' ? { type: 'delegate', agentId: 'agent.partner', goal: 'Research', expectedOutput: 'research/1' }
        : { type: 'finish', title: 'Result', content: 'Delivered', evidenceRefs: [] };
      return { value, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const engine = new AgentEngine(repo, { model, tools, agents });
  const prepare = async (externalBudget?: ExternalBudget, extra: Record<string, unknown> = {}) => {
    const run = await engine.create({ goal: 'Deliver', allowedTools: ['lookup'], allowedAgents: ['agent.partner'], ...(externalBudget ? { externalBudget } : {}), ...extra });
    await engine.advance(run.id);
    await engine.command(run.id, 'approve', { planHash: (await repo.get(run.id)).plans[0]!.hash });
    await engine.advance(run.id);
    return run.id;
  };
  const restart = () => new AgentEngine(repo, { model, tools, agents });
  return { engine, repo, prepare, restart, counts: () => ({ toolCalls, agentCalls, modelCalls, reconciles }) };
}

describe('Run external capability budgets', () => {
  it.each(['running', 'paused', 'cancelled'] as const)('accounts isolated results without evidence or revival while %s', async control => {
    const ledger = new InMemoryGrantLedger();
    const entered = deferred<DelegationRequest>(); const release = deferred<void>();
    const { engine, repo, prepare } = await setup({ ledger, sequence: ['agent'], submit: async request => {
      entered.resolve(request); await release.promise;
      return agentResult(request, { tokens: 10, money: 0.1, currency: 'USD' });
    } });
    const runId = await prepare({ calls: 1, tokens: 20, moneyUsd: 1 });
    const running = engine.advance(runId);
    const request = await entered.promise;
    if (control !== 'running') await engine.command(runId, control === 'paused' ? 'pause' : 'cancel');
    await ledger.revokeGrant(request.grant.grantId, { actor: 'ops' });
    release.resolve(); await running;
    const run = await repo.get(runId);
    expect(run.status).toBe(control === 'running' ? 'failed' : control);
    if (control === 'paused') expect(run.resumeStatus).toBe('failed');
    expect(run.externalUsage).toMatchObject({ calls: 1, tokens: 10, moneyUsd: 0.1, unreportedCalls: 0 });
    expect(run.pendingDelegation).toBeUndefined();
    expect(run.steps[0]?.observations).toEqual([]); expect(run.artifacts).toEqual([]);
    const outcome = run.delegationOutcomes![0]!;
    expect(outcome.disposition).toBe('isolated'); expect(outcome.result).toBeUndefined();
    expect(projectRunGraphs(run).evidence.nodes.some(node => node.id === outcome.receiptRef)).toBe(false);
    await repo.close(); await repo.init();
    expect((await repo.get(runId)).externalUsage).toEqual(run.externalUsage);
  });

  it('sums Tool and Agent receipts across restart and permits synthesis at the exact limit', async () => {
    const { engine, repo, prepare, restart, counts } = await setup({ sequence: ['tool', 'agent'], cost: { tokens: 10, money: 0.1, currency: 'USD' } });
    const id = await prepare({ calls: 2, tokens: 20, moneyUsd: 0.2 });
    await engine.advance(id);
    await repo.close(); await repo.init();
    const resumed = restart(); await resumed.recover();
    for (let i = 0; i < 6; i++) await resumed.advance(id);
    const run = await repo.get(id);
    expect(run.status).toBe('succeeded');
    expect(run.externalUsage).toEqual({ calls: 2, tokens: 20, moneyUsd: 0.2, unreportedCalls: 0, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 });
    expect(counts()).toMatchObject({ toolCalls: 1, agentCalls: 1 });
  });

  it.each(['calls', 'tokens', 'moneyUsd'] as const)('prevents a second external call at the %s limit', async dimension => {
    const { engine, repo, prepare, counts } = await setup({ sequence: ['tool', 'agent'], cost: { tokens: 10, money: 1, currency: 'USD' } });
    const id = await prepare({ [dimension]: dimension === 'tokens' ? 10 : 1 });
    await engine.advance(id);
    expect(await engine.advance(id)).toBe('failed');
    expect((await repo.get(id)).pendingDelegation).toBeUndefined();
    expect(counts()).toMatchObject({ toolCalls: 1, agentCalls: 0 });
  });

  it('does not dispatch external work for a zero USD budget', async () => {
    const { repo, prepare, counts } = await setup();
    const id = await prepare({ moneyUsd: 0 });
    expect((await repo.get(id)).status).toBe('failed');
    expect((await repo.get(id)).pendingTool).toBeUndefined();
    expect(counts().toolCalls).toBe(0);
  });

  it.each(['tool', 'agent'] as const)('records %s overshoot and prevents retry/replan or downstream application', async type => {
    const { engine, repo, prepare, restart, counts } = await setup({ sequence: [type], cost: { tokens: 11, money: 0.1, currency: 'USD' } });
    const id = await prepare({ tokens: 10 });
    expect(await engine.advance(id)).toBe('failed');
    const run = await repo.get(id);
    expect(run.externalUsage).toMatchObject({ calls: 1, tokens: 11, moneyUsd: 0.1 });
    expect(run.steps[0]?.observations).toEqual([]);
    expect(run.artifacts).toEqual([]);
    const resumed = restart(); await resumed.recover();
    await expect(resumed.command(id, 'retry', {})).rejects.toThrow('External token budget exceeded');
    await expect(resumed.command(id, 'replan', {})).rejects.toThrow('External token budget exceeded');
    expect(counts().modelCalls).toBe(2);
  });

  it.each([
    { budget: { tokens: 10 }, cost: undefined },
    { budget: { moneyUsd: 1 }, cost: { tokens: 2, money: 0.1, currency: 'CNY' } },
    { budget: { moneyUsd: 1 }, cost: { money: 0 } },
  ])('stops when a required usage dimension cannot be verified: %j', async ({ budget, cost }) => {
    const { engine, repo, prepare } = await setup(cost ? { cost } : {});
    const id = await prepare(budget);
    expect(await engine.advance(id)).toBe('failed');
    expect((await repo.get(id)).externalUsage?.moneyUsd).toBeUndefined();
    await expect(engine.command(id, 'retry', {})).rejects.toThrow('did not report');
  });

  it('allows a calls-only limit with missing cost without reporting free USD spend', async () => {
    const { engine, repo, prepare } = await setup();
    const id = await prepare({ calls: 1 });
    for (let i = 0; i < 5; i++) await engine.advance(id);
    expect((await repo.get(id)).status).toBe('succeeded');
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, unreportedTokenCalls: 1, unreportedMoneyCalls: 1 });
    expect((await repo.get(id)).externalUsage?.moneyUsd).toBeUndefined();
  });

  it('reconciles a Tool with no remaining call slots, replacing unknown usage exactly once', async () => {
    const { engine, repo, prepare, restart, counts } = await setup({ cost: { tokens: 3, money: 0.1, currency: 'USD' }, invoke: async request => toolResult(request, undefined, 'unknown') });
    const id = await prepare({ calls: 1, tokens: 10, moneyUsd: 1 });
    expect(await engine.advance(id)).toBe('unknown');
    const resumed = restart(); await resumed.recover();
    await resumed.command(id, 'reconcile', { reason: 'Query provider receipt' });
    expect(await resumed.advance(id)).toBe('running');
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, tokens: 3, moneyUsd: 0.1, unreportedMoneyCalls: 0 });
    for (let i = 0; i < 4; i++) await resumed.advance(id);
    expect((await repo.get(id)).status).toBe('succeeded');
    expect(counts()).toMatchObject({ toolCalls: 1, reconciles: 1 });
  });

  it('settles accepted Agent work on callback, with USD currency and duplicate delivery', async () => {
    let delegated!: DelegationRequest;
    const { engine, repo, prepare } = await setup({ sequence: ['agent'], submit: async request => { delegated = request; return agentResult(request, {}, 'accepted'); } });
    const id = await prepare({ calls: 1, tokens: 10, moneyUsd: 1 });
    expect(await engine.advance(id)).toBe('waiting_external');
    const response = agentResult(delegated, { tokens: 4, money: 0.3, currency: 'USD' });
    const callbacks = await Promise.all([engine.acceptAgentCallback(id, response), engine.acceptAgentCallback(id, response)]);
    expect(callbacks.every(run => run.status === 'running')).toBe(true);
    await engine.acceptAgentCallback(id, response);
    const run = await repo.get(id);
    expect(run.externalUsage).toMatchObject({ calls: 1, tokens: 4, moneyUsd: 0.3 });
    expect(run.steps[0]?.observations).toHaveLength(1);
  });

  it.each(['tool', 'agent'] as const)('keeps a thrown %s transport failure unknown until provider reconciliation', async type => {
    const { engine, repo, prepare, counts } = await setup({ sequence: [type], cost: { tokens: 4 },
      invoke: async () => { throw new Error('connection lost after dispatch'); },
      submit: async () => { throw new Error('connection lost after dispatch'); },
    });
    const id = await prepare({ calls: 1, tokens: 10 });
    expect(await engine.advance(id)).toBe('unknown');
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, unreportedTokenCalls: 1 });
    await expect(engine.command(id, 'retry', {})).rejects.toThrow('reconciliation');
    await engine.command(id, 'reconcile', { reason: 'Provider confirms completion' });
    expect(await engine.advance(id)).toBe('running');
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, tokens: 4 });
    expect(counts()).toMatchObject({ toolCalls: type === 'tool' ? 1 : 0, agentCalls: type === 'agent' ? 1 : 0, reconciles: 1 });
  });

  it('allows external reconciliation after exhausting the model budget without allowing another model call', async () => {
    const { engine, repo, prepare, counts } = await setup({ cost: { tokens: 4 }, invoke: async request => toolResult(request, undefined, 'unknown') });
    const id = await prepare({ calls: 1, tokens: 10 }, { modelBudget: { tokens: 4 } });
    expect(await engine.advance(id)).toBe('unknown');
    await engine.command(id, 'reconcile', { reason: 'Read provider receipt only' });
    expect(await engine.advance(id)).toBe('running');
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, tokens: 4 });
    expect(await engine.advance(id)).toBe('failed');
    expect(counts().modelCalls).toBe(2);
  });

  it.each(['tool', 'agent'] as const)('keeps cancelled interrupted %s work cancelled on restart and records unknown cost', async type => {
    const { engine, repo, prepare, restart, counts } = await setup({ sequence: [type] });
    const id = await prepare({ calls: 1, tokens: 10 });
    await engine.command(id, 'cancel', {});
    await restart().recover();
    const run = await repo.get(id);
    expect(run.status).toBe('cancelled');
    expect(run.externalUsage).toMatchObject({ calls: 1, unreportedTokenCalls: 1 });
    expect(counts()).toMatchObject({ toolCalls: 0, agentCalls: 0 });
  });

  it('records failed Tool spend and rejects a retry if it overshot the limit', async () => {
    const { engine, repo, prepare } = await setup({ invoke: async request => toolResult(request, { money: 2, currency: 'USD' }, 'failed') });
    const id = await prepare({ moneyUsd: 1 });
    expect(await engine.advance(id)).toBe('failed');
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, moneyUsd: 2 });
    await expect(engine.command(id, 'retry', {})).rejects.toThrow('money budget exceeded');
  });

  it.each(['tool', 'agent'] as const)('keeps %s accepted/unknown reconciliation inside its original budget reservation', async type => {
    const { engine, repo, prepare, counts } = await setup({ sequence: [type], cost: { tokens: 4, money: 0.2, currency: 'USD' },
      invoke: async request => toolResult(request, undefined, 'unknown'), submit: async request => agentResult(request, {}, 'accepted'),
    });
    const id = await prepare({ calls: 1, tokens: 10, moneyUsd: 1 });
    await engine.advance(id);
    await engine.command(id, 'reconcile', { reason: 'Provider lookup' });
    await engine.advance(id);
    expect((await repo.get(id)).externalUsage).toMatchObject({ calls: 1, tokens: 4, moneyUsd: 0.2 });
    expect(counts().reconciles).toBe(1);
  });

  it.each([['tool', 'cancel'], ['tool', 'pause'], ['agent', 'cancel'], ['agent', 'pause']] as const)('accounts an in-flight %s after %s without reviving it', async (type, action) => {
    const started = deferred<void>(); const finish = deferred<void>();
    const cost = { tokens: 11, money: 0.2, currency: 'USD' };
    const { engine, repo, prepare } = await setup({ sequence: [type],
      invoke: async request => { started.resolve(); await finish.promise; return toolResult(request, cost); },
      submit: async request => { started.resolve(); await finish.promise; return agentResult(request, cost); },
    });
    const id = await prepare({ tokens: 10 });
    const advancing = engine.advance(id); await started.promise;
    await engine.command(id, action, {}); finish.resolve(); await advancing;
    const run = await repo.get(id);
    expect(run.status).toBe(action === 'cancel' ? 'cancelled' : 'paused');
    if (action === 'pause') expect(run.resumeStatus).toBe('failed');
    expect(run.externalUsage).toMatchObject({ calls: 1, tokens: 11, moneyUsd: 0.2 });
    expect(run.steps[0]?.observations).toEqual([]);
  });

  it('validates and persists external budgets at the HTTP boundary', async () => {
    const { engine, repo } = await setup();
    const app = buildApp({ repository: repo, engine, dispatcher: { notify: async () => {}, close: async () => {} } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Deliver', externalBudget: { calls: 3, tokens: 100, moneyUsd: 1 } } });
      expect(response.statusCode).toBe(202);
      expect((await repo.get(response.json().id)).externalBudget).toEqual({ calls: 3, tokens: 100, moneyUsd: 1 });
      for (const budget of [{}, { calls: 0 }, { tokens: 1.2 }, { moneyUsd: -1 }, { currency: 'USD' }]) {
        const invalid = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Deliver', externalBudget: budget } });
        expect(invalid.statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });
});
