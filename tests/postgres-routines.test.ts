import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContentCipher, InMemoryContentKeyStore, PostgresContentKeyStore, configureContentEncryption, contentKeysMigration } from '../src/content-encryption.js';
import { PostgresRoutineStore, RoutineService, signRoutineWebhook } from '../src/routines.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'team-a' };
const daily = { kind: 'schedule' as const, calendar: { frequency: 'daily' as const, timeZone: 'Asia/Singapore', time: '09:00' } };
beforeEach(() => configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore())));
afterEach(() => configureContentEncryption(undefined));

describe('Postgres routine store', () => {
  it.skipIf(!databaseUrl)('seals secrets with persisted tenant keys, upgrades plaintext and deduplicates concurrent signed nonces', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const pool = new pg.Pool({ connectionString: db.url });
    const first = new PostgresRoutineStore(db.url), second = new PostgresRoutineStore(db.url);
    try {
      await first.init(); await second.init();
      await pool.query(contentKeysMigration);
      const master = randomBytes(32);
      const cipher = () => new ContentCipher(master, new PostgresContentKeyStore(pool));
      configureContentEncryption(cipher());
      let starts = 0;
      const now = '2026-10-29T00:00:00.000Z';
      const starter = async () => { starts += 1; return { conversationId: 'conv', taskId: 'task', runId: 'run_hook' }; };
      const options = { now: () => now, runActive: async () => false, webhooksEnabled: true };
      const one = new RoutineService(first, starter, options), two = new RoutineService(second, starter, options);
      const { routine, webhookSecret } = await one.create({ agentId: 'writer', name: 'hook', prompt: 'read', trigger: { kind: 'webhook' } }, scope);
      const stored = async () => (await pool.query('SELECT state FROM aeeis_routines WHERE id=$1', [routine.id])).rows[0].state;
      const sealed = await stored();
      expect(sealed.webhookSecret).toMatch(/^aeeis-enc\/1:/);
      expect(JSON.stringify(sealed)).not.toContain(webhookSecret);
      configureContentEncryption(undefined);
      await expect(two.receiveWebhook(routine.id, '{}', {})).rejects.toThrow('Unknown routine');
      await expect(second.get(routine.id, { owner: 'bob', tenantId: 'team-b' })).rejects.toThrow('Unknown routine');
      const legacy = { ...sealed, webhookSecret };
      delete legacy.webhookEnabled;
      await pool.query('UPDATE aeeis_routines SET state=$2 WHERE id=$1', [routine.id, legacy]);
      expect(await second.get(routine.id, scope)).toMatchObject({ webhookSecret, webhookEnabled: false });
      await expect(two.update(routine.id, { expectedRevision: 0, webhookEnabled: true }, scope)).rejects.toThrow('AEEIS_CONTENT_ENCRYPTION_KEY_FILE');
      configureContentEncryption(cipher());
      await two.update(routine.id, { expectedRevision: 0, webhookEnabled: true }, scope);
      expect((await stored()).webhookSecret).toMatch(/^aeeis-enc\/1:/);
      const timestamp = String(Date.parse(now) / 1000);
      const headers = { 'x-aeeis-timestamp': timestamp, 'x-aeeis-delivery': 'nonce-1', 'x-aeeis-signature': signRoutineWebhook(webhookSecret!, timestamp, 'nonce-1', '{}') };
      await Promise.all([one.receiveWebhook(routine.id, '{}', headers), two.receiveWebhook(routine.id, '{}', headers)]);
      expect(starts).toBe(1);
      // A new cipher must reload the wrapped tenant key from PostgreSQL.
      configureContentEncryption(cipher());
      const restarted = new PostgresRoutineStore(db.url);
      try {
        await restarted.init();
        expect((await restarted.get(routine.id, scope)).webhookSecret).toBe(webhookSecret);
        const service = new RoutineService(restarted, starter, options);
        expect(await service.receiveWebhook(routine.id, '{}', headers)).toMatchObject({ status: 'duplicate', runId: 'run_hook' });
        const rotated = await service.rotateSecret(routine.id, scope);
        expect(rotated.webhookSecret).not.toBe(webhookSecret);
        expect(JSON.stringify(await stored())).not.toContain(rotated.webhookSecret);
        expect((await second.get(routine.id, scope)).webhookSecret).toBe(rotated.webhookSecret);
      } finally { await restarted.close(); }
      expect(starts).toBe(1);
    } finally { await first.close(); await second.close(); await pool.end(); await db.close(); }
  });

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
