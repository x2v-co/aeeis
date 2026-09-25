import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { makeSyncReceipt, projectSourceContentHash, type ProjectSourceRecord } from '../src/project-sources.js';

const model: ModelAdapter = {
  pin: { model: 'fixture/model', endpoint: 'http://fixture', promptVersion: 'test' },
  async complete() { throw new Error('model should not be called during create'); },
};

function record(): ProjectSourceRecord {
  const content = 'Connector evidence';
  return { id: 'task:1', title: 'Task', content, source: 'fixture:task:1', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z', contentHash: projectSourceContentHash(content) };
}

describe('project source global budget integration', () => {
  it('counts a successful connector sync in the shared call budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-source-budget-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 1, tokens: 100, moneyUsd: 1 } }]);
    const source = { search: async () => [record()] };
    const engine = new AgentEngine(repository, { model, projectSources: source, globalBudget: { ledger, select } });
    try {
      await engine.create({ goal: 'Read connector evidence', projectSourceQuery: 'Task', privacy: 'internal' }, 'alice', 'team-a');
      await expect(engine.create({ goal: 'Read connector evidence again', projectSourceQuery: 'Task', privacy: 'internal' }, 'alice', 'team-a')).rejects.toThrow(/Global call budget exhausted/);
      const selection = select({ owner: 'alice', tenantId: 'team-a' }, new Date().toISOString())!;
      const account = await ledger.get(selection.accountKey);
      expect(account?.usedCalls).toBe(1);
      expect(account?.usedTokens).toBe(0);
      expect(account?.usedMoneyUsd).toBe(0);
    } finally { await ledger.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('marks a provider failure unknown so a token or money budget cannot be bypassed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-source-budget-unknown-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 2, tokens: 100, moneyUsd: 1 } }]);
    const source = { search: async () => { throw new Error('connector unavailable'); } };
    const engine = new AgentEngine(repository, { model, projectSources: source, globalBudget: { ledger, select } });
    try {
      await expect(engine.create({ goal: 'Read connector evidence', projectSourceQuery: 'Task' }, 'alice', 'team-a')).rejects.toThrow('connector unavailable');
      const selection = select({ owner: 'alice', tenantId: 'team-a' }, new Date().toISOString())!;
      const account = await ledger.get(selection.accountKey);
      expect(account?.unreportedTokenCalls).toBe(1);
      expect(account?.unreportedMoneyCalls).toBe(1);
      await expect(engine.create({ goal: 'Retry connector evidence', projectSourceQuery: 'Task' }, 'alice', 'team-a')).rejects.toThrow(/missing|unknown|Global/);
    } finally { await ledger.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('counts a remote Knowledge search in the same connector budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-knowledge-budget-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 1, tokens: 100, moneyUsd: 1 } }]);
    const knowledge = { search: async () => ({ hits: [{ record: { id: 'knowledge.1', title: 'Knowledge', content: 'Evidence', source: 'fixture:knowledge', contentHash: projectSourceContentHash('Evidence'), classification: 'internal' as const, tags: [], updatedAt: '2026-09-19T00:00:00.000Z' }, score: 1, matchedTerms: ['evidence'] }], usage: { tokens: 12, moneyUsd: 0.02 } }) };
    const budgeted = new AgentEngine(repository, { model, knowledge, globalBudget: { ledger, select } });
    try {
      await budgeted.create({ goal: 'Use knowledge', knowledgeQuery: 'Evidence' }, 'alice', 'team-a');
      await expect(budgeted.create({ goal: 'Use knowledge again', knowledgeQuery: 'Evidence' }, 'alice', 'team-a')).rejects.toThrow(/Global call budget exhausted/);
      expect(await ledger.get(select({ owner: 'alice', tenantId: 'team-a' }, new Date().toISOString())!.accountKey)).toMatchObject({ usedCalls: 1, usedTokens: 12, usedMoneyUsd: 0.02 });
    } finally { await ledger.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('settles provider usage from a project source receipt instead of treating it as free', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-source-usage-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 2, tokens: 100, moneyUsd: 1 } }]);
    const source = {
      sync: async (request: { query: string; maxItems: number; tenantId: string }) => {
        const records = [record()];
        const receipt = makeSyncReceipt('metered-fixture', request, records, 'cursor-1', { mode: 'snapshot' }, { tokens: 8, moneyUsd: 0.01 });
        return { records, nextCursor: 'cursor-1', receipt };
      },
    };
    const engine = new AgentEngine(repository, { model, projectSources: source, globalBudget: { ledger, select } });
    try {
      await engine.create({ goal: 'Read metered connector evidence', projectSourceQuery: 'Task' }, 'alice', 'team-a');
      const account = await ledger.get(select({ owner: 'alice', tenantId: 'team-a' }, new Date().toISOString())!.accountKey);
      expect(account).toMatchObject({ usedCalls: 1, usedTokens: 8, usedMoneyUsd: 0.01 });
    } finally { await ledger.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
