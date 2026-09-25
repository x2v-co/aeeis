import { describe, expect, it } from 'vitest';
import { createGlobalBudgetSelector, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';

const selection = { accountKey: 'global.test', owner: 'alice', tenantId: 'team-a', windowKey: '2026-09-19', budget: { calls: 2, tokens: 10, moneyUsd: 1 } };

describe('global durable budget ledger', () => {
  it('serializes reservations, keeps idempotency and settles usage exactly once', async () => {
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const [left, right] = await Promise.all([
      ledger.reserve(selection, 'call.one'),
      ledger.reserve(selection, 'call.one'),
    ]);
    expect([left.reserved, right.reserved].sort()).toEqual([false, true]);
    await ledger.settle(selection.accountKey, 'call.one', { tokens: 5, moneyUsd: 0.4 });
    await ledger.settle(selection.accountKey, 'call.one', { tokens: 5, moneyUsd: 0.4 });
    const account = await ledger.get(selection.accountKey);
    expect(account).toMatchObject({ usedCalls: 1, usedTokens: 5, usedMoneyUsd: 0.4 });
    expect(account?.entries['call.one']?.state).toBe('settled');
    await ledger.close();
  });

  it('settles decimal USD usage at the exact budget boundary without floating point drift', async () => {
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    const exact = { ...selection, budget: { calls: 3, moneyUsd: 0.3 } };
    for (const key of ['decimal.one', 'decimal.two', 'decimal.three']) await ledger.reserve(exact, key);
    for (const key of ['decimal.one', 'decimal.two', 'decimal.three']) await ledger.settle(exact.accountKey, key, { moneyUsd: 0.1 });
    expect((await ledger.get(exact.accountKey))?.usedMoneyUsd).toBe(0.3);
    expect((await ledger.get(exact.accountKey))?.entries['decimal.three']?.state).toBe('settled');
    await ledger.close();
  });

  it('does not treat missing usage as free and requires reconciliation before another call', async () => {
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    await ledger.reserve(selection, 'call.unknown');
    await ledger.markUnknown(selection.accountKey, 'call.unknown');
    await expect(ledger.reserve(selection, 'call.next')).rejects.toThrow('Global token usage is missing');
    await ledger.reconcile(selection.accountKey, 'call.unknown', { tokens: 4, moneyUsd: 0.2 }, { source: 'provider', provider: 'fixture', reference: 'provider-call-unknown', reason: 'Provider billing lookup completed' });
    const next = await ledger.reserve(selection, 'call.next');
    expect(next.reserved).toBe(true);
    expect((await ledger.get(selection.accountKey))?.entries['call.unknown']?.reconciliation).toMatchObject({ source: 'provider', reference: 'provider-call-unknown' });
    await ledger.close();
  });

  it('rejects a settlement that exceeds the shared limit while retaining the spend', async () => {
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    await ledger.reserve(selection, 'call.over');
    await expect(ledger.settle(selection.accountKey, 'call.over', { tokens: 11, moneyUsd: 0 })).rejects.toThrow('Global budget exceeded');
    const account = await ledger.get(selection.accountKey);
    expect(account?.usedTokens).toBe(11);
    expect(account?.entries['call.over']?.state).toBe('rejected');
    await expect(ledger.reserve(selection, 'call.next')).rejects.toThrow('Global token budget exhausted');
    await ledger.close();
  });

  it('retains reconciliation evidence when the confirmed invoice exceeds the limit', async () => {
    const ledger = new InMemoryGlobalBudgetLedger(); await ledger.init();
    await ledger.reserve(selection, 'call.invoice-over');
    await ledger.markUnknown(selection.accountKey, 'call.invoice-over');
    await expect(ledger.reconcile(selection.accountKey, 'call.invoice-over', { tokens: 11, moneyUsd: 0 }, {
      source: 'invoice', provider: 'fixture', reference: 'invoice-over', reason: 'Matched the provider invoice line',
    })).rejects.toThrow('Global budget exceeded');
    expect((await ledger.get(selection.accountKey))?.entries['call.invoice-over']).toMatchObject({
      state: 'rejected', reconciliation: { source: 'invoice', reference: 'invoice-over' },
    });
    await ledger.close();
  });

  it('selects tenant rules and derives stable UTC windows', () => {
    const select = createGlobalBudgetSelector([
      { window: 'day', budget: { calls: 10 } },
      { tenantId: 'team-a', window: 'hour', budget: { calls: 2 } },
    ]);
    expect(select({ owner: 'alice', tenantId: 'team-a' }, '2026-09-19T12:34:56.000Z')).toMatchObject({ tenantId: 'team-a', windowKey: '2026-09-19T12', budget: { calls: 2 } });
    expect(select({ owner: 'alice', tenantId: 'team-b' }, '2026-09-19T12:34:56.000Z')).toMatchObject({ tenantId: 'team-b', windowKey: '2026-09-19', budget: { calls: 10 } });
  });
});
