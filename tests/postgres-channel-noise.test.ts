import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ContentCipher, InMemoryContentKeyStore, configureContentEncryption, contentEncryption } from '../src/content-encryption.js';
import { isolatedPostgres } from './support/postgres.js';
import { noiseAt, noiseDraft, noiseScope } from './support/channel-noise.js';
import { PostgresChannelNoiseStore } from '../src/channel-noise.js';
import { PostgresSessionEventRepository } from '../src/session-events.js';
import { ChannelDigestDelivery } from '../src/channel-digest.js';
import { applyRowLevelSecurity } from '../src/adapters/postgres-pool.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL 频道防噪', () => {
  it('两个服务并发共用限流；设置和队列重启不丢，并发 pump 只写一张摘要', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    let first = new PostgresSessionEventRepository(db.url);
    let firstSettings = new PostgresChannelNoiseStore(db.url);
    const second = new PostgresSessionEventRepository(db.url);
    const secondSettings = new PostgresChannelNoiseStore(db.url);
    let now = noiseAt;
    try {
      await Promise.all([first.init(), firstSettings.init(), second.init(), secondSettings.init()]);
      await firstSettings.put(noiseScope, { digestMinutes: 20, mode: 'lively', quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Singapore' } });
      expect(await secondSettings.get(noiseScope)).toMatchObject({ digestMinutes: 20, mode: 'lively', quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Singapore' } });
      const a = new ChannelDigestDelivery(first, firstSettings, () => now), b = new ChannelDigestDelivery(second, secondSettings, () => now);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
        const delivery = i % 2 ? a : b, repository = i % 2 ? first : second;
        return delivery.write(noiseDraft(`concurrent-${i}`), item => repository.append(item));
      }));
      expect(results.filter(item => item.botDelivery?.mode === 'immediate')).toHaveLength(6);
      expect(results.filter(item => item.botDelivery?.mode === 'digest')).toHaveLength(14);
      await first.close(); await firstSettings.close();
      first = new PostgresSessionEventRepository(db.url); firstSettings = new PostgresChannelNoiseStore(db.url);
      await first.init(); await firstSettings.init();
      expect(await firstSettings.get(noiseScope)).toMatchObject({ mode: 'lively', digestMinutes: 20 });
      now += 20 * 60_000;
      const restarted = new ChannelDigestDelivery(first, firstSettings, () => now);
      expect((await Promise.all([restarted.pump(), b.pump()])).reduce((sum, value) => sum + value, 0)).toBe(1);
      const events = (await first.page(noiseScope.roomId, noiseScope, 200)).items;
      expect(events.filter(item => item.type === 'digest')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ content: '已合并 14 条', digest: { eventIds: results.filter(item => item.botDelivery?.mode === 'digest').sort((left, right) => left.sequence - right.sequence).map(item => item.id) } });
      expect(await new ChannelDigestDelivery(second, secondSettings, () => now).pump()).toBe(0);
      expect((await restarted.write(noiseDraft('after-window'), item => first.append(item))).botDelivery?.mode).toBe('immediate');
      const pool = new pg.Pool({ connectionString: db.url });
      try {
        expect((await applyRowLevelSecurity(pool)).secured).toContain('aeeis_channel_noise_settings');
        expect((await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='aeeis_channel_noise_settings'::regclass")).rows[0].relrowsecurity).toBe(true);
      } finally { await pool.end(); }
    } finally { await first.close(); await firstSettings.close(); await second.close(); await secondSettings.close(); await db.close(); }
  });
  it('开启内容加密后仍能发现待摘要、合并并按原文读取', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const previousCipher = contentEncryption();
    configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
    const repository = new PostgresSessionEventRepository(db.url), settings = new PostgresChannelNoiseStore(db.url);
    const pool = new pg.Pool({ connectionString: db.url });
    let now = noiseAt;
    try {
      await repository.init(); await settings.init();
      const delivery = new ChannelDigestDelivery(repository, settings, () => now);
      const event = await delivery.write(noiseDraft('sealed-progress', { type: 'task_update' }), item => repository.append(item));
      const state = (await pool.query('SELECT state FROM aeeis_session_events WHERE id=$1', [event.id])).rows[0].state;
      expect(state.content).toBeUndefined();
      expect(state.botDelivery.mode).toBe('digest');
      now += 15 * 60_000;
      expect(await delivery.pump()).toBe(1);
      expect(await repository.get(event.id, noiseScope)).toMatchObject({ content: 'sealed-progress' });
      expect((await repository.page(noiseScope.roomId, noiseScope, 200)).items.at(-1)).toMatchObject({ type: 'digest', content: '已合并 1 条' });
      expect(await new ChannelDigestDelivery(repository, settings, () => now).pump()).toBe(0);
    } finally { await repository.close(); await settings.close(); await pool.end(); configureContentEncryption(previousCipher); await db.close(); }
  });

});
