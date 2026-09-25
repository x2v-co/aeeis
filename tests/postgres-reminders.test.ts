import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PostgresReminderStore } from '../src/reminders.js';

const url = process.env.AEEIS_TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL durable reminders', () => {
  it('claims and projects a reminder across store instances', async () => {
    const first = new PostgresReminderStore(url!); await first.init();
    const second = new PostgresReminderStore(url!); await second.init();
    const scope = { owner: `reminder-test-${randomUUID()}`, tenantId: 'team-a' };
    const dueAt = new Date(Date.now() - 1000).toISOString();
    try {
      const created = await first.create({ title: 'PG reminder', message: 'Check PostgreSQL', dueAt, delivery: { channel: 'test', destination: 'local' }, idempotencyKey: `pg-${randomUUID()}` }, scope);
      expect(await second.claimDue(scope, new Date().toISOString())).toHaveLength(1);
      await second.markProjected(created.id, 'projection_pg', scope);
      expect((await first.get(created.id, scope)).status).toBe('projected');
    } finally { await first.close(); await second.close(); }
  });

  it('advances recurring occurrences without reusing an outbox identity', async () => {
    const first = new PostgresReminderStore(url!); await first.init();
    const scope = { owner: `reminder-recur-${randomUUID()}`, tenantId: 'team-a' };
    try {
      const created = await first.create({ title: 'PG recurring', message: 'Check again', dueAt: new Date(Date.now() - 1000).toISOString(), delivery: { channel: 'test', destination: 'local' }, recurrence: { intervalMs: 60_000, maxOccurrences: 2 }, idempotencyKey: `pg-recur-${randomUUID()}` }, scope);
      const claimed = await first.claimDue(scope); expect(claimed).toHaveLength(1);
      const next = await first.markProjected(created.id, 'projection_pg_recur_0', scope);
      expect(next).toMatchObject({ status: 'scheduled', occurrence: 1 });
    } finally { await first.close(); }
  });

  it('honors each reminder maxAttempts in the SQL claim predicate', async () => {
    const first = new PostgresReminderStore(url!);
    const scope = { owner: `reminder-attempts-${randomUUID()}`, tenantId: 'team-a' };
    await first.init();
    const dueAt = new Date(Date.now() - 1000).toISOString();
    try {
      const created = await first.create({
        title: 'PG bounded retries', message: 'Do not claim after the configured limit', dueAt,
        delivery: { channel: 'test', destination: 'local' }, maxAttempts: 1, idempotencyKey: `pg-attempts-${randomUUID()}`,
      }, scope);
      const claimed = await first.claimDue(scope);
      expect(claimed).toHaveLength(1);
      await first.markFailed(created.id, 'sink unavailable', dueAt, scope);
      expect(await first.claimDue(scope, new Date(Date.now() + 1000).toISOString())).toHaveLength(0);
      expect((await first.get(created.id, scope)).attempts).toBe(1);
    } finally {
      await first.close();
    }
  });

  it('paginates reminders with the indexed owner scope and stable cursor', async () => {
    const store = new PostgresReminderStore(url!); await store.init();
    const scope = { owner: `reminder-page-${randomUUID()}`, tenantId: 'team-a' };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));
    try {
      const created = await Promise.all([1, 2, 3].map(index => store.create({
        title: `PG page ${index}`, message: 'Page history', dueAt: new Date(Date.now() + index * 60_000).toISOString(),
        delivery: { channel: 'test', destination: 'local' }, idempotencyKey: `pg-page-${index}-${randomUUID()}`,
      }, scope)));
      await store.create({ title: 'Other tenant', message: 'Private', dueAt: new Date().toISOString(), delivery: { channel: 'test', destination: 'local' } }, { ...scope, tenantId: 'team-b' });
      const cancelled = await store.create({ title: 'Cancelled', message: 'Filtered out', dueAt: new Date().toISOString(), delivery: { channel: 'test', destination: 'local' } }, scope);
      await store.cancel(cancelled.id, scope);
      const first = await store.listPage(scope, 2, undefined, 'scheduled');
      expect(first.items).toHaveLength(2); expect(first.nextCursor).toBeDefined();
      const second = await store.listPage(scope, 2, first.nextCursor, 'scheduled');
      expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeUndefined();
      expect([...first.items, ...second.items].map(item => item.id)).toEqual(created.map(item => item.id).sort());
      expect((await store.listPage(scope, 2, undefined, 'cancelled')).items.map(item => item.id)).toEqual([cancelled.id]);
      await expect(store.listPage(scope, 2, 'invalid')).rejects.toThrow('Invalid collection cursor');
    } finally { vi.useRealTimers(); await store.close(); }
  });
});
