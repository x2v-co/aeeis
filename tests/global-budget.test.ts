import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGlobalBudgetSelector, FileGlobalBudgetLedger, InMemoryGlobalBudgetLedger } from '../src/global-budget.js';

const selection = { accountKey: 'global.test', owner: 'alice', tenantId: 'team-a', windowKey: '2026-09-19', budget: { calls: 2, tokens: 10, moneyUsd: 1 } };

describe('global durable budget ledger', () => {
  it.each(['memory', 'file'])('refunds an unused call once and retains its key in the %s ledger', async adapter => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-budget-release-'));
    const path = join(directory, 'budget.json');
    let ledger = adapter === 'file' ? new FileGlobalBudgetLedger(path) : new InMemoryGlobalBudgetLedger();
    try {
      await ledger.reserve(selection, 'call.used');
      await ledger.settle(selection.accountKey, 'call.used', { tokens: 5, moneyUsd: 0.4 });
      await ledger.reserve(selection, 'call.unused');
      await expect(ledger.reserve(selection, 'call.next')).rejects.toThrow('Global call budget exhausted');
      await Promise.all([ledger.release(selection.accountKey, 'call.unused'), ledger.release(selection.accountKey, 'call.unused')]);
      if (adapter === 'file') { await ledger.close(); ledger = new FileGlobalBudgetLedger(path); await ledger.init(); }
      expect(await ledger.get(selection.accountKey)).toMatchObject({ usedCalls: 1, usedTokens: 5, usedMoneyUsd: 0.4, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 });
      expect(await ledger.reserve(selection, 'call.unused')).toEqual({ reserved: false, state: 'released' });
      await ledger.release(selection.accountKey, 'call.unused');
      await expect(ledger.markUnknown(selection.accountKey, 'call.unused')).rejects.toThrow('released');
      await expect(ledger.settle(selection.accountKey, 'call.unused', { tokens: 1, moneyUsd: 0 })).rejects.toThrow('released');
      await expect(ledger.release(selection.accountKey, 'call.missing')).rejects.toThrow('reservation is missing');
      expect(await ledger.reserve(selection, 'call.next')).toEqual({ reserved: true, state: 'reserved' });
      expect((await ledger.get(selection.accountKey))?.usedCalls).toBe(2);
    } finally { await ledger.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['unknown', 'settled', 'rejected'])('refuses to release a %s call or change its accounting', async state => {
    const ledger = new InMemoryGlobalBudgetLedger();
    try {
      await ledger.reserve(selection, 'call.used');
      if (state === 'unknown') await ledger.markUnknown(selection.accountKey, 'call.used');
      else if (state === 'settled') await ledger.settle(selection.accountKey, 'call.used', { tokens: 4, moneyUsd: 0.2 });
      else await expect(ledger.settle(selection.accountKey, 'call.used', { tokens: 11, moneyUsd: 0 })).rejects.toThrow('Global budget exceeded');
      const original = await ledger.get(selection.accountKey);
      await expect(ledger.release(selection.accountKey, 'call.used')).rejects.toThrow('Only reserved');
      expect(await ledger.get(selection.accountKey)).toEqual(original);
    } finally { await ledger.close(); }
  });

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
