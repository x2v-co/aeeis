import { describe, expect, it } from 'vitest';
import { PostgresRoutineStore, RoutineService } from '../src/routines.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'team-a' };
const daily = { kind: 'schedule' as const, calendar: { frequency: 'daily' as const, timeZone: 'Asia/Singapore', time: '09:00' } };

describe('Postgres routine store', () => {
  it.skipIf(!databaseUrl)('starts a due routine once under concurrent pumps and keeps it across restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    let now = '2026-10-29T00:00:00.000Z';
    let starts = 0;
    const starter = async () => { starts += 1; return { conversationId: 'conv', taskId: 'task', runId: `run_${starts}` }; };
    const first = new PostgresRoutineStore(db.url); await first.init();
    const second = new PostgresRoutineStore(db.url); await second.init();
    try {
      const options = { now: () => now, runActive: async () => false };
      const one = new RoutineService(first, starter, options), two = new RoutineService(second, starter, options);
      const { routine } = await one.create({ agentId: 'writer', name: '早报', prompt: '整理', trigger: daily }, scope);
      const webhook = await one.create({ agentId: 'writer', name: '工单', prompt: '读工单', trigger: { kind: 'webhook' } }, scope);
      expect((await second.get(webhook.routine.id)).webhookSecret).toBe(webhook.webhookSecret);
      now = '2026-11-01T02:00:00.000Z';
      await Promise.all([one.pump(), two.pump(), one.pump()]);
      expect(starts).toBe(1);
      const deliveries = await second.deliveries(routine.id, scope, 10);
      expect(deliveries).toMatchObject([{ deliveryId: 'schedule:2026-10-29T01:00:00.000Z', state: 'started', missed: 3, runId: 'run_1' }]);
      expect((await second.get(routine.id, scope)).nextDueAt).toBe('2026-11-02T01:00:00.000Z');
      expect(await second.list({ owner: 'bob', tenantId: 'team-a' })).toEqual([]);
      await expect(second.get(routine.id, { owner: 'bob', tenantId: 'team-a' })).rejects.toThrow('Unknown routine');
      await one.remove(routine.id, scope);
      expect(await second.deliveries(routine.id, scope, 10)).toEqual([]);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
