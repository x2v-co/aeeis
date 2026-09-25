import { expect, it, vi } from 'vitest';
import { AgentEngine } from '../../src/runtime/engine.js';
import { AgentDirectory, AgentGateway, type AgentTransport, type AgentTransportResponse, type DelegationRequest } from '../../src/agent-gateway.js';
import type { GrantLedger } from '../../src/agent-ledger.js';
import type { AgentCard } from '../../src/protocol.js';
import type { RunRepository } from '../../src/runtime/repository.js';
import type { ModelAdapter } from '../../src/runtime/model.js';
import { createGlobalBudgetSelector, type GlobalBudgetLedger } from '../../src/global-budget.js';

export interface AgentFencingHarness {
  runs: [RunRepository, RunRepository];
  budgets: [GlobalBudgetLedger, GlobalBudgetLedger];
  grants: [GrantLedger, GrantLedger];
  close(): Promise<void>;
}

const card: AgentCard = {
  schemaVersion: 'agent-card/1', agentId: 'agent.partner', name: 'Partner', owner: 'partner',
  protocols: ['aeeis-task/1'], capabilities: ['research'], inputSchemas: ['task-brief/1'],
  outputSchemas: ['result-envelope/1'], auth: ['local'],
  privacy: { dataRetention: 'session', regions: ['local'] }, pricing: { unit: 'run' }, cardVersion: '1',
};

const model: ModelAdapter = {
  pin: { model: 'fixture', endpoint: 'http://127.0.0.1:9999', promptVersion: 'fixture/1' },
  async complete(request) {
    return { usage: { inputTokens: 1, outputTokens: 1 }, value: request.system.includes('Plan a real deliverable')
      ? { summary: 'Delegate research', nodes: [{ id: 'research', title: 'Research', instruction: 'Ask partner', dependsOn: [] }] }
      : { type: 'delegate', agentId: card.agentId, goal: 'Research', expectedOutput: 'research/1' } };
  },
};

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function response(request: DelegationRequest, receiptRef = 'receipt.final', accepted = false): AgentTransportResponse {
  return {
    status: accepted ? 'accepted' : 'completed', receiptRef,
    acknowledgement: { schemaVersion: 'context-ack/1', taskId: request.taskBrief.taskId, contextVersion: request.contextPack.id, understoodGoal: true, missingInformation: [], assumptions: [], conflicts: [], ready: true },
    ...(!accepted ? { result: {
      schemaVersion: 'result-envelope/1' as const, taskId: request.taskBrief.taskId, agentId: request.agentId,
      status: 'completed' as const, resultType: 'research/1', summary: receiptRef, claims: [], artifacts: [],
      unresolved: [], requestedFollowups: [], cost: { tokens: 7, money: 0.1, currency: 'USD' },
      capabilitiesUsed: [], contextVersion: request.contextPack.id, receiptRef,
    } } : {}),
  };
}

function engines(h: AgentFencingHarness, transport: AgentTransport) {
  const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 10 } }]);
  const directory = new AgentDirectory(); directory.register(card);
  const pair = [0, 1].map(index => new AgentEngine(h.runs[index]!, {
    model, agents: new AgentGateway(directory, transport, h.grants[index]!),
    globalBudget: { ledger: h.budgets[index]!, select },
  }));
  return { first: pair[0]!, second: pair[1]!, select };
}

async function prepare(engine: AgentEngine, repo: RunRepository) {
  const run = await engine.create({ goal: 'Durable external research', allowedAgents: [card.agentId] }, 'alice', 'team-a');
  expect(await engine.advance(run.id)).toBe('needs_approval');
  await engine.command(run.id, 'approve', { planHash: (await repo.get(run.id)).plans[0]!.hash });
  expect(await engine.advance(run.id)).toBe('running');
  expect((await repo.get(run.id)).pendingDelegation).toBeDefined();
  return run.id;
}

/** File uses one local writer; PostgreSQL supplies distinct repository and
 * ledger connections so the same invariants exercise cross-instance locks. */
export function agentFencingContract(create: () => Promise<AgentFencingHarness>) {
  it('admits one submit across independent Engines and strips local bookkeeping', async () => {
    const h = await create(); const started = latch(); const release = latch();
    let attempt: Promise<unknown> | undefined;
    const submit = vi.fn(async (_card: AgentCard, request: DelegationRequest) => {
      started.resolve(); await release.promise;
      for (const key of ['executionToken', 'receiptRef', 'reconcileRequested', 'reconcileInFlight', 'globalBudgetAccountKey']) expect(request).not.toHaveProperty(key);
      return response(request);
    });
    try {
      const { first, second } = engines(h, { submit });
      const id = await prepare(first, h.runs[0]);
      attempt = first.advance(id); await started.promise;
      expect((await h.runs[1].get(id)).pendingDelegation?.executionToken).toBeTruthy();
      await second.advance(id);
      expect(submit).toHaveBeenCalledTimes(1);
      release.resolve(); await attempt;
      const run = await h.runs[1].get(id);
      expect(run.pendingDelegation).toBeUndefined();
      expect(run.delegationOutcomes).toHaveLength(1);
      expect(run.steps[0]?.observations).toHaveLength(1);
    } finally { release.resolve(); await attempt; await h.close(); }
  });

  it.each(['running', 'paused', 'cancelled'] as const)('fences late submit after recovery while %s, then accounts through reconciliation', async disposition => {
    const h = await create(); const started = latch(); const release = latch();
    let attempt: Promise<unknown> | undefined;
    const submit = vi.fn(async (_card: AgentCard, request: DelegationRequest) => {
      started.resolve(); await release.promise; return response(request, 'receipt.stale');
    });
    const reconcile = vi.fn(async (_card: AgentCard, request: DelegationRequest) => response(request, 'receipt.reconciled'));
    try {
      const { first, second, select } = engines(h, { submit, reconcile });
      const id = await prepare(first, h.runs[0]);
      attempt = first.advance(id); await started.promise;
      if (disposition !== 'running') await second.command(id, disposition === 'paused' ? 'pause' : 'cancel');
      await second.recover();
      const recovered = await h.runs[1].get(id);
      const pending = recovered.pendingDelegation!;
      expect(pending.executionToken).toBeUndefined();
      expect(recovered.status).toBe(disposition === 'running' ? 'unknown' : disposition);
      release.resolve(); await attempt;
      const late = await h.runs[1].get(id);
      expect(late.delegationOutcomes?.at(-1)?.status).toBe('unknown');
      expect(late.steps[0]?.observations).toHaveLength(0);
      const key = select({ owner: 'alice', tenantId: 'team-a' }, late.createdAt)!.accountKey;
      const entryKey = `aeeis:external:${id}:${pending.idempotencyKey}`;
      expect((await h.budgets[1].get(key))?.entries[entryKey]?.state).toBe('unknown');
      if (disposition === 'cancelled') await second.reconcileCancelledExternal(id, { reason: 'Provider verified prior work' });
      else {
        if (disposition === 'paused') await second.command(id, 'resume', {});
        await second.command(id, 'reconcile', { reason: 'Provider verified prior work' });
        await second.advance(id);
      }
      const final = await h.runs[1].get(id);
      expect(final.pendingDelegation).toBeUndefined();
      expect(final.delegationOutcomes?.at(-1)?.receiptRef).toBe('receipt.reconciled');
      expect((await h.budgets[1].get(key))?.entries[entryKey]).toMatchObject({ state: 'settled', usage: { tokens: 7, moneyUsd: 0.1 } });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      if (disposition === 'cancelled') {
        expect(final.status).toBe('cancelled');
        expect(final.steps[0]?.observations).toHaveLength(0);
      }
    } finally { release.resolve(); await attempt; await h.close(); }
  });

  it('releases execution admission after a global reservation failure', async () => {
    const h = await create(); const submit = vi.fn(async (_card: AgentCard, request: DelegationRequest) => response(request));
    try {
      const { first } = engines(h, { submit });
      const id = await prepare(first, h.runs[0]);
      vi.spyOn(h.budgets[0], 'reserve').mockRejectedValueOnce(new Error('Budget storage unavailable'));
      expect(await first.advance(id)).toBe('failed');
      const run = await h.runs[0].get(id);
      expect(run.pendingDelegation?.executionToken).toBeUndefined();
      expect(run.error).toContain('Budget storage unavailable');
      expect(submit).not.toHaveBeenCalled();
      await first.command(id, 'retry', { reason: 'Budget storage restored' });
      expect(await first.advance(id)).toBe('running');
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await h.runs[0].get(id)).pendingDelegation).toBeUndefined();
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it('applies and settles one callback when independent reconciliation returns late', async () => {
    const h = await create(); const started = latch(); const release = latch();
    let attempt: Promise<unknown> | undefined;
    try {
      const { first, second, select } = engines(h, {
        submit: async (_card, request) => response(request, 'receipt.accepted', true),
        reconcile: async (_card, request) => { started.resolve(); await release.promise; return response(request, 'receipt.reconcile-late'); },
      });
      const id = await prepare(first, h.runs[0]);
      expect(await first.advance(id)).toBe('waiting_external');
      const accepted = await h.runs[0].get(id);
      const pending = accepted.pendingDelegation!;
      expect(pending.executionToken).toBeUndefined();
      await first.command(id, 'reconcile', { reason: 'Provider lookup' });
      attempt = first.advance(id); await started.promise;
      await second.acceptAgentCallback(id, response(pending, 'receipt.callback'));
      release.resolve(); await attempt;
      // Repeated authenticated delivery cannot add observations or usage.
      await first.acceptAgentCallback(id, response(pending, 'receipt.callback'));
      const run = await h.runs[1].get(id);
      expect(run.status).toBe('running');
      expect(run.pendingDelegation).toBeUndefined();
      expect(run.delegationOutcomes).toHaveLength(1);
      expect(run.delegationOutcomes?.[0]?.receiptRef).toBe('receipt.callback');
      expect(run.steps[0]?.observations).toHaveLength(1);
      expect(run.events.filter(event => event.type === 'agent.reconciled')).toHaveLength(1);
      const account = await h.budgets[1].get(select({ owner: 'alice', tenantId: 'team-a' }, run.createdAt)!.accountKey);
      expect(account?.entries[`aeeis:external:${id}:${pending.idempotencyKey}`]).toMatchObject({ state: 'settled', usage: { tokens: 7, moneyUsd: 0.1 } });
    } finally { release.resolve(); await attempt; await h.close(); }
  });

  it('retains a recovered budget account from the pre-binding crash window', async () => {
    const h = await create();
    try {
      const { first, second, select } = engines(h, { submit: async (_card, request) => response(request), reconcile: async (_card, request) => response(request) });
      const id = await prepare(first, h.runs[0]);
      // Crash occurred before the selection was written to the pending Run.
      expect((await h.runs[0].get(id)).pendingDelegation?.globalBudgetAccountKey).toBeUndefined();
      await second.recover();
      const run = await h.runs[1].get(id);
      const accountKey = select({ owner: 'alice', tenantId: 'team-a' }, run.updatedAt)!.accountKey;
      expect(run.pendingDelegation?.globalBudgetAccountKey).toBe(accountKey);
      await second.command(id, 'reconcile', { reason: 'Resolve pre-binding interruption' });
      expect(await second.advance(id)).toBe('running');
      const account = await h.budgets[1].get(accountKey);
      expect(account?.entries[`aeeis:external:${id}:${run.pendingDelegation!.idempotencyKey}`]?.state).toBe('settled');
    } finally { await h.close(); }
  });
}
