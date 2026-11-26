import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresChatSummaryStore, type ChatSummary } from '../src/chat-summaries.js';
import { ContentCipher, InMemoryContentKeyStore, configureContentEncryption } from '../src/content-encryption.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'team-a' };
const summary = (extra: Partial<ChatSummary> = {}): ChatSummary => ({ chatId: 'room_1', ...scope, kind: 'group', backing: 'room', title: '机密的群名', preview: '机密的一句', lastActivityAt: '2026-11-26T08:00:00.000Z', newCount: 2, sourceRevision: 5, ...extra });

describe('Postgres chat summaries', () => {
  it.skipIf(!databaseUrl)('seals title and preview, keeps the newer row, and only raises read markers', async () => {
    configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresChatSummaryStore(db.url), second = new PostgresChatSummaryStore(db.url);
    const raw = new pg.Pool({ connectionString: db.url });
    try {
      await Promise.all([first.init(), second.init()]); await first.init();
      await first.put(summary());
      await second.put(summary({ newCount: 1, sourceRevision: 4, preview: '旧的' }));
      await second.put(summary({ owner: 'bob', sourceRevision: 9 }));
      expect(await second.get('room_1', scope)).toEqual(summary());
      expect(await second.get('room_1', { owner: 'bob', tenantId: 'team-a' })).toBeUndefined();
      const stored = (await raw.query('SELECT * FROM aeeis_chat_summaries')).rows[0];
      expect(JSON.stringify(stored)).not.toContain('机密');
      expect(stored).toMatchObject({ owner: 'alice', kind: 'group', new_count: 2 });
      await first.put(summary({ chatId: 'conversation_1', backing: 'conversation', kind: 'direct', counterpart: 'bot_1', lastActivityAt: '2026-11-26T09:00:00.000Z', sourceRevision: 1 }));
      expect((await second.list(scope)).map(item => item.chatId)).toEqual(['conversation_1', 'room_1']);
      await first.markRead({ principalId: 'alice', tenantId: 'team-a', chatId: 'room_1', readCount: 2, readAt: '2026-11-26T08:01:00.000Z' });
      await second.markRead({ principalId: 'alice', tenantId: 'team-a', chatId: 'room_1', readCount: 1, readAt: '2026-11-26T08:02:00.000Z' });
      expect((await first.reads('alice', 'team-a')).map(item => item.readCount)).toEqual([2]);
      expect(await first.reads('alice', 'team-b')).toEqual([]);
      expect(await first.seeded()).toBe(false);
      await Promise.all([first.markSeeded(), second.markSeeded()]);
      expect(await second.seeded()).toBe(true);
    } finally { configureContentEncryption(undefined); await first.close(); await second.close(); await raw.end(); await db.close(); }
  });
});
