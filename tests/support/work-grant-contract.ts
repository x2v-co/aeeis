import { expect, it } from 'vitest';
import { WorkGrantConflict, WorkGrantNotFound, workGrantRemaining, workGrantState, type WorkGrantStore } from '../../src/work-grant-store.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const input = { title: 'Site A', tools: ['shell', 'edit', 'edit'], budget: { perRun: { tokens: 1000, moneyUsd: 0.5 }, total: { tokens: 2500, moneyUsd: 1.2 } }, durationHours: 24 };

/** The same behavior for every store: ownership, reservations, revoke, and that all of it survives a restart. */
export function runWorkGrantStoreContract(label: string, open: () => Promise<{ store: WorkGrantStore; reopen: (store: WorkGrantStore) => Promise<WorkGrantStore>; dispose?: () => Promise<void> }>, skip = false): void {
  it.skipIf(skip)(`${label}: reserves budgets per Run, keeps grants to their owner and survives a restart`, async () => {
    const { store, reopen, dispose } = await open();
    let current = store;
    try {
      const grant = await current.create(scope, input, '2026-11-05T00:00:00.000Z');
      expect(grant.tools).toEqual(['edit', 'shell']);
      expect(grant.expiresAt).toBe('2026-11-06T00:00:00.000Z');
      await expect(current.get({ owner: 'bob', tenantId: 'team-a' }, grant.grantId)).rejects.toThrow(WorkGrantNotFound);
      await expect(current.get({ owner: 'alice', tenantId: 'team-b' }, grant.grantId)).rejects.toThrow(WorkGrantNotFound);
      expect(await current.list({ owner: 'bob', tenantId: 'team-a' })).toEqual([]);

      const at = '2026-11-05T01:00:00.000Z';
      expect((await current.allocate(scope, grant.grantId, 'run_1', undefined, at)).allocation).toMatchObject({ tokens: 1000, moneyUsd: 0.5 });
      expect((await current.allocate(scope, grant.grantId, 'run_1', { tokens: 1 }, at)).allocation).toMatchObject({ tokens: 1000 });
      expect((await current.allocate(scope, grant.grantId, 'run_2', { tokens: 300 }, at)).allocation).toMatchObject({ tokens: 300, moneyUsd: 0.5 });
      expect((await current.allocate(scope, grant.grantId, 'run_3', undefined, at)).allocation).toMatchObject({ tokens: 1000, moneyUsd: 0.2 });
      const spent = await current.get(scope, grant.grantId);
      expect(workGrantRemaining(spent)).toEqual({ tokens: 200, moneyUsd: 0 });
      expect(workGrantState(spent, at)).toBe('exhausted');
      await expect(current.allocate(scope, grant.grantId, 'run_4', undefined, at)).rejects.toThrow(WorkGrantConflict);

      current = await reopen(current);
      const reloaded = await current.get(scope, grant.grantId);
      expect(reloaded.allocations.map(item => item.runId)).toEqual(['run_1', 'run_2', 'run_3']);

      const second = await current.create(scope, { ...input, title: 'Site B' }, at);
      const revoked = await current.revoke(scope, second.grantId, '2026-11-05T02:00:00.000Z');
      expect(revoked).toMatchObject({ status: 'revoked', revokedAt: '2026-11-05T02:00:00.000Z' });
      await expect(current.allocate(scope, second.grantId, 'run_5', undefined, '2026-11-05T03:00:00.000Z')).rejects.toThrow('已撤销');
      // Concurrent reservations never take more than the total.
      const third = await current.create(scope, { ...input, title: 'Site C', budget: { perRun: { tokens: 1000 }, total: { tokens: 2500 } } }, at);
      const settled = await Promise.allSettled(['a', 'b', 'c', 'd', 'e'].map(runId => current.allocate(scope, third.grantId, `run_${runId}`, undefined, at)));
      const reserved = (await current.get(scope, third.grantId)).allocations.reduce((sum, item) => sum + (item.tokens ?? 0), 0);
      expect(reserved).toBe(2500);
      expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(3);
      current = await reopen(current);
      expect((await current.list(scope)).map(item => [item.title, item.status])).toEqual([['Site A', 'active'], ['Site B', 'revoked'], ['Site C', 'active']]);
    } finally { await current.close?.(); await dispose?.(); }
  });
}
