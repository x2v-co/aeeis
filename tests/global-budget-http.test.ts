import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';

describe('global budget reconciliation HTTP boundary', () => {
  it('settles an unknown connector reservation and enforces account scope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-global-budget-http-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 2, tokens: 100, moneyUsd: 1 } }]);
    const selected = select({ owner: 'alice', tenantId: 'team-a' }, '2026-09-19T00:00:00.000Z')!;
    await ledger.reserve(selected, 'aeeis:connector:run-x:query');
    await ledger.reserve(selected, 'aeeis:connector:run-in-flight:query');
    await ledger.markUnknown(selected.accountKey, 'aeeis:connector:run-x:query');
    const app = buildApp({ repository, globalBudget: { ledger, select }, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-b', roles: ['owner'] },
    } });
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/budgets/global/reconcile', headers: { authorization: 'Bearer bob' }, payload: { accountKey: selected.accountKey, idempotencyKey: 'aeeis:connector:run-x:query', usage: { tokens: 0, moneyUsd: 0 } } });
      expect(denied.statusCode).toBe(403);
      const inFlight = await app.inject({ method: 'POST', url: '/api/budgets/global/reconcile', headers: { authorization: 'Bearer alice' }, payload: { accountKey: selected.accountKey, idempotencyKey: 'aeeis:connector:run-in-flight:query', usage: { tokens: 0, moneyUsd: 0 } } });
      expect(inFlight.statusCode).toBe(409);
      const response = await app.inject({ method: 'POST', url: '/api/budgets/global/reconcile', headers: { authorization: 'Bearer alice' }, payload: { accountKey: selected.accountKey, idempotencyKey: 'aeeis:connector:run-x:query', usage: { tokens: 12, moneyUsd: 0.02 }, reconciliation: { source: 'invoice', provider: 'fixture', reference: 'invoice-2026-09-19-001', reason: 'Matched provider invoice line item', evidenceHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' } } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ reconciled: true, account: { usedTokens: 12, usedMoneyUsd: 0.02, unreportedTokenCalls: 0, unreportedMoneyCalls: 0, entries: { 'aeeis:connector:run-x:query': { reconciliation: { source: 'invoice', reference: 'invoice-2026-09-19-001' } } } } });
    } finally { await app.close(); await ledger.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('imports an invoice batch only inside the principal scope and keeps rejected spend evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-global-budget-import-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const select = createGlobalBudgetSelector([{ tenantId: 'team-a', window: 'day', budget: { calls: 3, tokens: 10, moneyUsd: 1 } }]);
    const selected = select({ owner: 'alice', tenantId: 'team-a' }, '2026-09-19T00:00:00.000Z')!;
    await ledger.reserve(selected, 'invoice-call-1');
    await ledger.reserve(selected, 'invoice-call-2');
    await ledger.markUnknown(selected.accountKey, 'invoice-call-1');
    await ledger.markUnknown(selected.accountKey, 'invoice-call-2');
    const app = buildApp({ repository, globalBudget: { ledger, select }, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-b', roles: ['owner'] } } });
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/budgets/global/import', headers: { authorization: 'Bearer bob' }, payload: {
        protocol: 'aeeis-billing-import/1', lines: [{ accountKey: selected.accountKey, idempotencyKey: 'invoice-call-1', usage: { tokens: 1 }, reconciliation: { source: 'invoice', provider: 'fixture', reference: 'invoice-1', reason: 'matched' } }],
      } });
      expect(denied.statusCode).toBe(403);
      const imported = await app.inject({ method: 'POST', url: '/api/budgets/global/import', headers: { authorization: 'Bearer alice' }, payload: {
        protocol: 'aeeis-billing-import/1', lines: [
          { accountKey: selected.accountKey, idempotencyKey: 'invoice-call-1', usage: { tokens: 4, moneyUsd: 0.1 }, reconciliation: { source: 'invoice', provider: 'fixture', reference: 'invoice-1', reason: 'matched first line' } },
          { accountKey: selected.accountKey, idempotencyKey: 'invoice-call-2', usage: { tokens: 9, moneyUsd: 0.2 }, reconciliation: { source: 'invoice', provider: 'fixture', reference: 'invoice-2', reason: 'matched second line' } },
        ],
      } });
      expect(imported.statusCode).toBe(200);
      expect(imported.json()).toMatchObject({ protocol: 'aeeis-billing-import/1', imported: 1, rejected: 1 });
      const account = await ledger.get(selected.accountKey);
      expect(account?.entries['invoice-call-1']).toMatchObject({ state: 'settled', reconciliation: { reference: 'invoice-1' } });
      expect(account?.entries['invoice-call-2']).toMatchObject({ state: 'rejected', reconciliation: { reference: 'invoice-2' } });
    } finally { await app.close(); await ledger.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
