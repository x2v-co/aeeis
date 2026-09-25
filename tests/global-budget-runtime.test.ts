import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';

describe('global budget runtime integration', () => {
  it('limits model calls across independent Runs in one tenant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-global-runtime-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    let calls = 0;
    const model: ModelAdapter = {
      pin: { model: 'fixture', provider: 'test', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
      complete: async request => { calls++; const value = request.system.includes('Plan a real deliverable') ? { summary: 'Plan', nodes: [{ id: 'work', title: 'Work', instruction: 'Work', dependsOn: [] }] } : { type: 'finish', title: 'Done', content: 'Done', evidenceRefs: [] }; return { value, usage: { inputTokens: 1, outputTokens: 1 } }; },
    };
    const globalBudget = { ledger, select: createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day' as const, budget: { calls: 2, tokens: 100 } }]) };
    const left = new AgentEngine(repository, { model, globalBudget });
    const right = new AgentEngine(repository, { model, globalBudget });
    try {
      const [a, b] = await Promise.all([left.create({ goal: 'A' }, 'alice', 'team-a'), right.create({ goal: 'B' }, 'bob', 'team-a')]);
      await Promise.all([left.advance(a.id), right.advance(b.id)]);
      expect(calls).toBe(2);
      expect((await repository.get(a.id)).status).toBe('needs_approval');
      expect((await repository.get(b.id)).status).toBe('needs_approval');
      const key = globalBudget.select({ owner: 'alice', tenantId: 'team-a' }, new Date().toISOString())!.accountKey;
      expect(await ledger.get(key)).toMatchObject({ usedCalls: 2, usedTokens: 4 });
    } finally { await repository.close(); await ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('requires provider audit metadata to reconcile an unknown model reservation and settles shared usage once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-global-reconcile-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    let first = true; let calls = 0;
    const model: ModelAdapter = {
      pin: { model: 'fixture', provider: 'test', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
      complete: async request => {
        calls++;
        if (first) { first = false; throw new ModelOutcomeUnknown('provider timeout'); }
        const value = request.system.includes('Plan a real deliverable') ? { summary: 'Plan', nodes: [{ id: 'work', title: 'Work', instruction: 'Work', dependsOn: [] }] } : { type: 'finish', title: 'Done', content: 'Done', evidenceRefs: [] };
        return { value, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const globalBudget = { ledger, select: createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day' as const, budget: { calls: 2, tokens: 4 } }]) };
    const engine = new AgentEngine(repository, { model, globalBudget });
    try {
      const run = await engine.create({ goal: 'Reconcile me' }, 'alice', 'team-a');
      expect(await engine.advance(run.id)).toBe('unknown');
      const unknown = await repository.get(run.id); const call = unknown.calls[0]!;
      const accountKey = globalBudget.select({ owner: 'alice', tenantId: 'team-a' }, unknown.createdAt)!.accountKey;
      await expect(engine.reconcileModelCall(run.id, { callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash, outcome: 'completed', reason: 'billing lookup' , output: { summary: 'Plan', nodes: [{ id: 'work', title: 'Work', instruction: 'Work', dependsOn: [] }] }, usage: { inputTokens: 1, outputTokens: 1 } })).rejects.toThrow('audit metadata');
      const reconciled = await engine.reconcileModelCall(run.id, {
        callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash, outcome: 'completed', reason: 'billing lookup',
        output: { summary: 'Plan', nodes: [{ id: 'work', title: 'Work', instruction: 'Work', dependsOn: [] }] }, usage: { inputTokens: 1, outputTokens: 1 },
        reconciliation: { source: 'provider', provider: 'fixture', reference: 'call-1', reason: 'Provider billing record matched' },
      });
      expect(reconciled.status).toBe('planning');
      expect(await engine.advance(run.id)).toBe('needs_approval');
      const account = await ledger.get(accountKey);
      expect(account).toMatchObject({ usedCalls: 1, usedTokens: 2, unreportedTokenCalls: 0 });
      expect(account?.entries[`aeeis:model:${run.id}:${call.id}`]).toMatchObject({ state: 'settled', reconciliation: { reference: 'call-1' } });
      expect(calls).toBe(1);
    } finally { await repository.close(); await ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('retains global reconciliation evidence when confirmed usage exceeds the shared limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-global-reconcile-over-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const model: ModelAdapter = { pin: { model: 'fixture', provider: 'test', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' }, complete: async () => { throw new ModelOutcomeUnknown('provider timeout'); } };
    const globalBudget = { ledger, select: createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day' as const, budget: { calls: 1, tokens: 1 } }]) };
    const engine = new AgentEngine(repository, { model, globalBudget });
    try {
      const run = await engine.create({ goal: 'Over budget' }, 'alice', 'team-a'); await engine.advance(run.id);
      const unknown = await repository.get(run.id); const call = unknown.calls[0]!;
      const accountKey = globalBudget.select({ owner: 'alice', tenantId: 'team-a' }, unknown.createdAt)!.accountKey;
      await expect(engine.reconcileModelCall(run.id, {
        callId: call.id, idempotencyKey: call.idempotencyKey, inputHash: call.inputHash, outcome: 'completed', reason: 'invoice matched',
        output: { summary: 'Plan', nodes: [{ id: 'work', title: 'Work', instruction: 'Work', dependsOn: [] }] }, usage: { inputTokens: 1, outputTokens: 1 },
        reconciliation: { source: 'invoice', provider: 'fixture', reference: 'invoice-1', reason: 'Invoice line matched' },
      })).rejects.toThrow('Global budget exceeded');
      expect((await ledger.get(accountKey))?.entries[`aeeis:model:${run.id}:${call.id}`]).toMatchObject({ state: 'rejected', reconciliation: { reference: 'invoice-1' } });
    } finally { await repository.close(); await ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
