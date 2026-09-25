import { describe, expect, it } from 'vitest';
import { PostgresGrantLedger } from '../src/adapters/postgres-agent-ledger.js';
import { isolatedPostgres } from './support/postgres.js';
import { digestProtocol } from '../src/protocol.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres Grant ledger', () => {
  it.skipIf(!databaseUrl)('persists Grant registration and blocks reservations after revocation across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const grant = { schemaVersion: 'delegation-grant/1' as const, grantId: 'grant.registry', subjectAgentId: 'agent.registry', issuerAgentId: 'aeeis', taskId: 'task.registry', purpose: 'test', actions: ['return_result'] as const, resourceRefs: ['source.1'], dataScope: 'public' as const, issuedAt: '2029-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', budget: { calls: 2 }, delegationChain: [], revocationRef: 'revoke.registry', nonce: 'nonce-1234567890123456' };
    const first = new PostgresGrantLedger(db.url); await first.init();
    try {
      await first.ensureGrant({ grant, digest: digestProtocol(grant) });
      await first.reserve(grant.grantId, 'call.registry', grant.budget);
      await first.revokeGrant(grant.grantId, { actor: 'ops', reason: 'suspended' });
      // Revocation fences new work but does not erase accounting for a call
      // that crossed the provider boundary before the operator action.
      await first.settle(grant.grantId, 'call.registry', { tokens: 7, money: 0.25 });
      await expect(first.settle(grant.grantId, 'call.registry', { tokens: 7, money: 0.25 })).resolves.toMatchObject({ decision: 'isolated', grantStatus: 'revoked' });
      await expect(first.reserve(grant.grantId, 'call.after-revoke', grant.budget)).rejects.toThrow('revoked');
    } finally { await first.close(); }
    const recovered = new PostgresGrantLedger(db.url); await recovered.init();
    try {
      expect(await recovered.getGrant(grant.grantId)).toMatchObject({ status: 'revoked', revokedBy: 'ops', revocationReason: 'suspended' });
      await expect(recovered.ensureGrant({ grant, digest: digestProtocol(grant) })).resolves.toMatchObject({ status: 'revoked' });
    } finally { await recovered.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('serializes concurrent reservations and preserves unknown work across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresGrantLedger(db.url), second = new PostgresGrantLedger(db.url);
    await first.init(); await second.init();
    try {
      const results = await Promise.allSettled([
        first.reserve('grant.pg', 'call-a', { calls: 1, tokens: 100 }),
        second.reserve('grant.pg', 'call-b', { calls: 1, tokens: 100 }),
      ]);
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(item => item.status === 'rejected').map(item => item.reason.message)).toEqual(['Delegation grant call budget is exhausted']);
      const winner = results[0]?.status === 'fulfilled' ? first : second;
      const winnerKey = results[0]?.status === 'fulfilled' ? 'call-a' : 'call-b';
      await winner.markUnknown('grant.pg', winnerKey);

      const recovered = new PostgresGrantLedger(db.url);
      await recovered.init();
      await expect(recovered.reserve('grant.pg', 'call-c', { calls: 1, tokens: 100 })).rejects.toThrow('budget');
      await recovered.settle('grant.pg', winnerKey, { tokens: 42 });
      await expect(recovered.settle('grant.pg', winnerKey, { tokens: 42 })).resolves.toMatchObject({ decision: 'isolated', grantStatus: 'unregistered' });
      await recovered.close();
    } finally {
      await first.close();
      await second.close();
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('persists a terminal budget rejection before returning the error', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const ledger = new PostgresGrantLedger(db.url);
    await ledger.init();
    try {
      await ledger.reserve('grant.cost', 'call-1', { calls: 2, tokens: 10 });
      await expect(ledger.settle('grant.cost', 'call-1', { tokens: 11 })).rejects.toThrow('token budget');
      await expect(ledger.settle('grant.cost', 'call-1', { tokens: 1 })).rejects.toThrow('already rejected');
    } finally { await ledger.close(); await db.close(); }
  });
});
