import { describe, expect, it } from 'vitest';
import { ActionPolicyConflict, PostgresActionPolicyStore } from '../src/action-policy-store.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres owner action policy store', () => {
  it.skipIf(!databaseUrl)('keeps the lists across restart and serializes concurrent changes by revision', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const scope = { owner: 'alice', tenantId: 'team-a' };
    const first = new PostgresActionPolicyStore(db.url); await first.init();
    try {
      await first.change(scope, { expectedRevision: 0, allow: ['lookup'], block: [] });
      const results = await Promise.allSettled([
        first.change(scope, { expectedRevision: 1, add: { list: 'allow', ref: 'publish@1' } }),
        first.change(scope, { expectedRevision: 1, add: { list: 'block', ref: 'publish@1' } }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ActionPolicyConflict);
    } finally { await first.close(); }
    const second = new PostgresActionPolicyStore(db.url); await second.init();
    try {
      const policy = await second.get(scope);
      expect(policy.revision).toBe(2);
      expect([...policy.allow, ...policy.block].filter(ref => ref === 'publish@1')).toHaveLength(1);
      expect((await second.get({ owner: 'bob', tenantId: 'team-a' })).revision).toBe(0);
    } finally { await second.close(); await db.close(); }
  });
});
