import { describe, expect, it } from 'vitest';
import { PostgresProjectionOutbox, ProjectionNotFound, ProjectionOutcomeUnknown } from '../src/collaboration-projection.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const alice = { owner: 'alice', tenantId: 'tenant-a' };
const bob = { owner: 'bob', tenantId: 'tenant-b' };

describe('Postgres projection outbox', () => {
  it.skipIf(!databaseUrl)('persists idempotent scoped delivery and unknown reconciliation', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const outbox = new PostgresProjectionOutbox(db.url);
    try {
      await outbox.init();
      const input = { channel: 'test', destination: 'tenant-a', aggregateType: 'run' as const, aggregateId: 'run.projection.pg', payload: { status: 'running' }, idempotencyKey: 'projection.pg.1', ...alice };
      const first = await outbox.enqueue(input);
      expect(await outbox.enqueue(input)).toEqual(first);
      expect(await outbox.list(undefined, bob)).toEqual([]);
      await expect(outbox.get(first.id, bob)).rejects.toBeInstanceOf(ProjectionNotFound);
      const delivered = await outbox.deliver(first.id, { deliver: async () => ({ externalId: 'external.1' }) }, alice);
      expect(delivered.status).toBe('delivered');
      const unknown = await outbox.enqueue({ ...input, idempotencyKey: 'projection.pg.2' });
      await expect(outbox.deliver(unknown.id, { deliver: async () => { throw new ProjectionOutcomeUnknown('transport unknown'); } }, alice)).rejects.toThrow('transport unknown');
      expect((await outbox.get(unknown.id, alice)).status).toBe('unknown');
      expect((await outbox.reconcile(unknown.id, 'completed', 'Provider receipt confirmed', 'external.2', alice)).status).toBe('delivered');
    } finally { await outbox.close(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('serializes delivery across two outbox processes', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresProjectionOutbox(db.url);
    const second = new PostgresProjectionOutbox(db.url);
    let calls = 0;
    try {
      await first.init(); await second.init();
      const event = await first.enqueue({ channel: 'test', destination: 'tenant-a', aggregateType: 'run', aggregateId: 'run.projection.race', payload: { status: 'running' }, idempotencyKey: 'projection.pg.race', ...alice });
      const sink = { deliver: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 30)); return { externalId: 'external.race' }; } };
      const results = await Promise.all([first.deliver(event.id, sink, alice), second.deliver(event.id, sink, alice)]);
      expect(results.map(result => result.status)).toEqual(['delivered', 'delivered']);
      expect(calls).toBe(1);
      expect((await second.get(event.id, alice)).attempts).toBe(1);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
