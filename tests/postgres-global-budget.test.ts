import { describe, expect, it } from 'vitest';
import { PostgresGlobalBudgetLedger } from '../src/global-budget.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const account = { accountKey: 'global.pg.test', owner: 'owner', tenantId: 'team-pg', windowKey: '2026-09-19', budget: { calls: 2, tokens: 20, moneyUsd: 1 } };

describe('Postgres global budget ledger', () => {
  it.skipIf(!databaseUrl)('refunds an unused reservation once across instances and retains the released key after restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const left = new PostgresGlobalBudgetLedger(db.url), right = new PostgresGlobalBudgetLedger(db.url);
    try {
      await left.init(); await right.init();
      await left.reserve(account, 'call.used');
      await left.settle(account.accountKey, 'call.used', { tokens: 4, moneyUsd: 0.2 });
      await right.reserve(account, 'call.unused');
      await Promise.all([left.release(account.accountKey, 'call.unused'), right.release(account.accountKey, 'call.unused')]);
      const restored = new PostgresGlobalBudgetLedger(db.url); await restored.init();
      try {
        expect(await restored.get(account.accountKey)).toMatchObject({ usedCalls: 1, usedTokens: 4, usedMoneyUsd: 0.2, unreportedTokenCalls: 0, unreportedMoneyCalls: 0 });
        expect(await restored.reserve(account, 'call.unused')).toEqual({ reserved: false, state: 'released' });
        await restored.release(account.accountKey, 'call.unused');
        await expect(restored.release(account.accountKey, 'call.used')).rejects.toThrow('Only reserved');
        expect((await restored.reserve(account, 'call.next')).reserved).toBe(true);
        expect((await restored.get(account.accountKey))?.usedCalls).toBe(2);
      } finally { await restored.close(); }
    } finally { await left.close(); await right.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('serializes concurrent reservations and survives restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const left = new PostgresGlobalBudgetLedger(db.url), right = new PostgresGlobalBudgetLedger(db.url);
    await left.init(); await right.init();
    try {
      const same = await Promise.all([left.reserve(account, 'call.same'), right.reserve(account, 'call.same')]);
      expect(same.map(item => item.reserved).sort()).toEqual([false, true]);
      expect((await left.reserve(account, 'call.two')).reserved).toBe(true);
      await expect(right.reserve(account, 'call.three')).rejects.toThrow('Global call budget exhausted');
      await right.settle(account.accountKey, 'call.same', { tokens: 4, moneyUsd: 0.2 });
      const restored = new PostgresGlobalBudgetLedger(db.url); await restored.init();
      try { expect(await restored.get(account.accountKey)).toMatchObject({ usedCalls: 2, usedTokens: 4, usedMoneyUsd: 0.2 }); }
      finally { await restored.close(); }
    } finally { await left.close(); await right.close(); await db.close(); }
  });
});
