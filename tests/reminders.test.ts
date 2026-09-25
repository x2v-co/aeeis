import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileReminderStore, InMemoryReminderStore, ReminderConflict, ReminderPump } from '../src/reminders.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const otherScope = { owner: 'bob', tenantId: 'team-b' };
function input(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Release review', message: 'Review the migration before release.',
    dueAt: new Date(Date.now() - 1000).toISOString(), delivery: { channel: 'feishu', destination: 'chat.release' },
    idempotencyKey: 'release-review-1', ...overrides,
  };
}

describe('durable reminders', () => {
  it('claims due reminders once, recovers an expired lease, and preserves idempotency', async () => {
    const store = new InMemoryReminderStore(); await store.init();
    const request = input();
    const created = await store.create(request, scope);
    expect(await store.create(request, scope)).toMatchObject({ id: created.id });
    const claimed = await store.claimDue(scope, new Date().toISOString(), 10, 1000);
    expect(claimed).toHaveLength(1); expect(claimed[0]).toMatchObject({ status: 'firing', attempts: 1 });
    expect(await store.claimDue(scope, new Date().toISOString(), 10, 1000)).toHaveLength(0);
    const recovered = await store.claimDue(scope, new Date(Date.now() + 1100).toISOString(), 10, 1000);
    expect(recovered).toHaveLength(1); expect(recovered[0]).toMatchObject({ id: created.id, status: 'firing', attempts: 2 });
    await store.markProjected(created.id, 'projection_1', scope);
    expect((await store.get(created.id, scope)).status).toBe('projected');
    await expect(store.get(created.id, otherScope)).rejects.toThrow('Unknown reminder');
  });

  it('does not silently change an idempotency key payload and supports cancel/retry', async () => {
    const store = new InMemoryReminderStore(); await store.init();
    await store.create(input({ dueAt: new Date(Date.now() + 60_000).toISOString() }), scope);
    await expect(store.create(input({ message: 'different' }), scope)).rejects.toBeInstanceOf(ReminderConflict);
    const delayed = await store.create(input({ idempotencyKey: 'delayed', dueAt: new Date(Date.now() + 60_000).toISOString() }), scope);
    await store.cancel(delayed.id, scope);
    expect((await store.retry(delayed.id, scope)).status).toBe('scheduled');
  });

  it('restarts a file store without losing scheduled reminders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-reminders-'));
    const path = join(directory, 'reminders.json');
    try {
      const first = new FileReminderStore(path); await first.init(); const created = await first.create(input({ idempotencyKey: 'restart' }), scope); await first.close();
      const second = new FileReminderStore(path); await second.init(); expect(await second.get(created.id, scope)).toMatchObject({ status: 'scheduled', idempotencyKey: 'restart' }); await second.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['memory', 'file'])('paginates %s history across timestamp ties and new inserts without crossing scope', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-reminder-pages-'));
    const path = join(directory, 'reminders.json');
    let store = kind === 'file' ? new FileReminderStore(path) : new InMemoryReminderStore();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));
    try {
      await store.init();
      const created = await Promise.all([1, 2, 3].map(index => store.create(input({ idempotencyKey: `page-${index}` }), scope)));
      await store.create(input({ idempotencyKey: 'other-owner' }), { ...scope, owner: 'bob' });
      await store.create(input({ idempotencyKey: 'other-tenant' }), { ...scope, tenantId: 'team-b' });
      const cancelled = await store.create(input({ idempotencyKey: 'cancelled' }), scope);
      await store.cancel(cancelled.id, scope);
      const first = await store.listPage(scope, 2, undefined, 'scheduled');
      expect(first.items).toHaveLength(2); expect(first.nextCursor).toBeDefined();
      vi.setSystemTime(new Date('2026-09-21T00:01:00.000Z'));
      await store.create(input({ idempotencyKey: 'new-insert' }), scope);
      if (kind === 'file') { await store.close(); store = new FileReminderStore(path); await store.init(); }
      const second = await store.listPage(scope, 2, first.nextCursor, 'scheduled');
      expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeUndefined();
      expect([...first.items, ...second.items].map(item => item.id)).toEqual(created.map(item => item.id).sort());
      expect((await store.listPage(scope, 2, undefined, 'cancelled')).items.map(item => item.id)).toEqual([cancelled.id]);
      const active = await store.listActivePage!(2);
      expect(active.items.every(item => !['projected', 'cancelled'].includes(item.status))).toBe(true);
      expect(active.items).toHaveLength(2);
      expect(active.nextCursor).toBeDefined();
      const activeTail = await store.listActivePage!(2, active.nextCursor);
      expect(activeTail.items.every(item => !['projected', 'cancelled'].includes(item.status))).toBe(true);
      const unrelated = await store.listPage({ ...scope, owner: 'nobody' }, 2, first.nextCursor);
      expect(unrelated).toEqual({ items: [] });
      await expect(store.listPage(scope, 2, 'invalid')).rejects.toThrow('Invalid collection cursor');
      await expect(store.listPage(scope, 0)).rejects.toThrow('Collection limit');
      first.items[0]!.title = 'changed by caller';
      expect((await store.get(first.items[0]!.id, scope)).title).toBe('Release review');
    } finally { vi.useRealTimers(); await store.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('projects through an idempotent outbox boundary and records projection state', async () => {
    const store = new InMemoryReminderStore(); await store.init();
    const created = await store.create(input({ idempotencyKey: 'pump' }), scope);
    const calls: Array<{ key: string; aggregateType: string }> = [];
    const projector = { enqueue: async (value: { idempotencyKey: string; aggregateType: string }) => { calls.push({ key: value.idempotencyKey, aggregateType: value.aggregateType }); return { id: 'projection_pump' }; } };
    const pump = new ReminderPump(store, projector);
    expect(await pump.pump()).toMatchObject({ claimed: 1, projected: 1, failed: 0 });
    expect(calls).toEqual([{ key: `reminder:${created.id}:0`, aggregateType: 'reminder' }]);
    expect((await store.get(created.id, scope)).status).toBe('projected');
  });

  it('shares one in-flight pump with a concurrent Temporal advance', async () => {
    const store = new InMemoryReminderStore(); await store.init();
    const created = await store.create(input({ idempotencyKey: 'concurrent-advance' }), scope);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const projector = { enqueue: async () => { entered(); await releasePromise; return { id: 'projection-concurrent' }; } };
    const pump = new ReminderPump(store, projector);
    const first = pump.pump();
    await enteredPromise;
    const second = pump.advance(created.id);
    release();
    await expect(first).resolves.toMatchObject({ claimed: 1, projected: 1, failed: 0 });
    await expect(second).resolves.toMatchObject({ status: 'projected', terminal: true });
    expect((await store.get(created.id, scope)).status).toBe('projected');
  });

  it('does not turn a reminder terminal in a competing lease into a retry', async () => {
    const store = new InMemoryReminderStore(); await store.init();
    const created = await store.create(input({ idempotencyKey: 'lease-race' }), scope);
    const projector = { enqueue: async () => { await store.markProjected(created.id, 'projection-race', scope); throw new Error('late sink response'); } };
    const result = await new ReminderPump(store, projector).pump();
    expect(result).toMatchObject({ claimed: 1, failed: 0 });
    expect((await store.get(created.id, scope)).status).toBe('projected');
  });

  it('advances a recurring schedule with occurrence-scoped outbox idempotency', async () => {
    const store = new InMemoryReminderStore(); await store.init();
    const created = await store.create(input({ idempotencyKey: 'recurring', recurrence: { intervalMs: 60_000, maxOccurrences: 2 } }), scope);
    const calls: Array<{ key: string; occurrence: number }> = [];
    const projector = { enqueue: async (value: { idempotencyKey: string; payload: unknown }) => {
      calls.push({ key: value.idempotencyKey, occurrence: (value.payload as { occurrence: number }).occurrence });
      return { id: `projection-${calls.length}` };
    } };
    const pump = new ReminderPump(store, projector);
    await pump.pump();
    const next = await store.get(created.id, scope);
    expect(next).toMatchObject({ status: 'scheduled', occurrence: 1, recurrence: { maxOccurrences: 2 } });
    await pump.pump(new Date(Date.parse(next.dueAt) + 1).toISOString());
    expect(calls).toEqual([{ key: `reminder:${created.id}:0`, occurrence: 0 }, { key: `reminder:${created.id}:1`, occurrence: 1 }]);
    expect((await store.get(created.id, scope)).status).toBe('projected');
  });

  it('exposes owner-scoped reminder scheduling and cancellation over HTTP', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-reminders-http-'));
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const store = new InMemoryReminderStore(); await store.init();
    const reminderNotifications: string[] = [];
    const app = buildApp({ repository, reminders: store, dispatcher: { notify: async () => {}, notifyReminder: async id => { reminderNotifications.push(id); }, close: async () => {} }, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-b', roles: ['owner'] },
    } });
    try {
      const headers = { authorization: 'Bearer alice' };
      const request = input({ dueAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: 'http', delivery: { channel: 'feishu', destination: 'chat.http' } });
      const created = await app.inject({ method: 'POST', url: '/api/reminders', headers, payload: { title: request.title, message: request.message, dueAt: request.dueAt, channel: request.delivery.channel, destination: request.delivery.destination, idempotencyKey: request.idempotencyKey } });
      expect(created.statusCode).toBe(200);
      const reminder = created.json() as { id: string; status: string };
      expect(reminder.status).toBe('scheduled');
      expect(reminderNotifications).toEqual([reminder.id]);
      expect((await app.inject({ method: 'GET', url: '/api/reminders?limit=1', headers })).json()).toHaveLength(1);
      const page = await app.inject({ method: 'GET', url: '/api/reminders/page?limit=1', headers });
      expect(page.statusCode).toBe(200); expect(page.json().items).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/reminders/page', headers })).statusCode).toBe(400);
      for (const query of ['limit=0', 'limit=201', 'limit=1&cursor=invalid', 'limit=1&status=invalid']) {
        expect((await app.inject({ method: 'GET', url: `/api/reminders/page?${query}`, headers })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'GET', url: '/api/reminders/page?limit=1', headers: { authorization: 'Bearer bob' } })).json()).toEqual({ items: [] });
      expect((await app.inject({ method: 'GET', url: `/api/reminders/${reminder.id}`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/reminders/${reminder.id}/cancel`, headers })).statusCode).toBe(200);
      expect(reminderNotifications).toEqual([reminder.id, reminder.id]);
      expect((await app.inject({ method: 'GET', url: `/api/reminders/${reminder.id}`, headers })).json()).toMatchObject({ status: 'cancelled' });
      expect((await app.inject({ method: 'GET', url: '/api/reminders/page?limit=1&status=cancelled', headers })).json().items).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/reminders/page?limit=1&status=scheduled', headers })).json()).toEqual({ items: [] });
    } finally { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
