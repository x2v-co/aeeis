import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PostgresPushStore, PushPump, type PushMessage } from '../src/push.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const alice = { owner: 'alice', tenantId: 'team-a' };
const web = () => { const receiver = createECDH('prime256v1'); receiver.generateKeys(); return { channel: 'web' as const, label: 'Chrome', endpoint: `https://push.example.test/${randomBytes(4).toString('hex')}`, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; };

describe('Postgres push store', () => {
  it.skipIf(!databaseUrl)('keeps one row per device across instances, scopes removal, records delivery and the announced keys', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresPushStore(db.url), second = new PostgresPushStore(db.url);
    try {
      await first.init(); await second.init();
      const device = web();
      await first.add(alice, device);
      const again = await second.add(alice, { ...device, label: 'Chrome again' });
      const phone = await first.add({ owner: 'bob', tenantId: 'team-b' }, { channel: 'apns', label: 'iPhone', token: 'ab'.repeat(32), sandbox: false });
      expect((await first.list(alice)).map(item => [item.id, item.label])).toEqual([[again.id, 'Chrome again']]);
      expect((await second.scopes()).sort((a, b) => a.owner.localeCompare(b.owner))).toEqual([alice, { owner: 'bob', tenantId: 'team-b' }]);
      expect(await first.remove(alice, phone.id)).toBe(false);
      await first.mark(again.id, { error: 'Web Push 503' });
      expect((await second.list(alice))[0]!.lastError).toBe('Web Push 503');
      await first.mark(again.id, { sentAt: '2026-11-03T00:00:00.000Z' });
      expect((await second.list(alice))[0]).toMatchObject({ lastSentAt: '2026-11-03T00:00:00.000Z' });
      expect((await second.list(alice))[0]!.lastError).toBeUndefined();
      expect(await first.seen(alice)).toBeUndefined();
      await first.setSeen(alice, ['run:a']);
      await second.setSeen(alice, ['run:a', 'run:b']);
      expect(await first.seen(alice)).toEqual(['run:a', 'run:b']);
      const sent: string[] = [];
      let waiting = ['run:a', 'run:b'];
      const pump = new PushPump(second, { web: { send: async (_subscription, item: PushMessage) => { sent.push(item.key); return { ok: true }; } } }, async scope => scope.owner === 'alice' ? waiting.map(key => ({ key, title: key, body: '', url: '/' })) : []);
      await pump.tick();
      waiting = ['run:a', 'run:b', 'run:c'];
      await pump.tick();
      expect(sent).toEqual(['run:c']);
      expect(await first.remove(alice, again.id)).toBe(true);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
