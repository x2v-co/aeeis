import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PostgresBotDialogueStore, type BotDialogue } from '../src/bot-dialogues.js';
import { isolatedPostgres } from './support/postgres.js';
import { dialogueFixture, dialogueScope as scope } from './support/bot-dialogues.js';
import { PostgresChannelNoiseStore } from '../src/channel-noise.js';
import { BotDialogueService } from '../src/application/bot-dialogue-service.js';
import { openAggregate } from '../src/content-encryption.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL Bot dialogue contract', () => {
  it('initializes concurrently, serializes independent pools, persists aliases/operations and supports documented DDL rollback', async () => {
    const db = await isolatedPostgres(databaseUrl!), first = new PostgresBotDialogueStore(db.url), second = new PostgresBotDialogueStore(db.url), pool = new pg.Pool({ connectionString: db.url });
    const at = new Date().toISOString();
    const value: BotDialogue = { ...scope, botId: 'bot-a', roomId: 'room-a', conversationId: 'conv-a', phase: 'preparing', version: 0, createdAt: at, updatedAt: at, state: { roomIds: [], revision: 0, highWater: {} } };
    try {
      const previous = new PostgresChannelNoiseStore(db.url); await previous.init(); await previous.close();
      await Promise.all([first.init(), second.init()]); await first.init(); await first.put(value);
      await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? first : second).withOwner(scope, async () => {
        const row = (await first.list(scope))[0]!; row.version++; await first.put(row);
      })));
      expect((await second.list(scope))[0]?.version).toBe(24);
      await first.alias({ ...scope, aliasRoomId: 'old-room', canonicalRoomId: value.roomId, botId: value.botId });
      await first.operation({ ...scope, botId: value.botId, operationKey: 'import:one', kind: 'import', sourceId: 'event-one', targetId: 'message-one', status: 'pending', state: { sequence: 1 } });
      expect(await second.aliases(scope)).toMatchObject([{ aliasRoomId: 'old-room', canonicalRoomId: value.roomId }]);
      expect(await second.operations(scope)).toMatchObject([{ status: 'pending', targetId: 'message-one' }]);
      expect(await first.list({ ...scope, owner: 'bob' })).toEqual([]); expect(await first.list({ ...scope, tenantId: 'team-b' })).toEqual([]);
      await expect(first.put({ ...value, botId: 'other' })).rejects.toThrow();
      await expect(first.alias({ ...scope, aliasRoomId: value.roomId, canonicalRoomId: 'old-room', botId: value.botId })).rejects.toThrow();
      await pool.query('BEGIN; DROP TABLE aeeis_bot_dialogue_operations; DROP TABLE aeeis_bot_dialogue_room_aliases; DROP TABLE aeeis_bot_dialogues; COMMIT;');
      await first.init(); expect(await first.list(scope)).toEqual([]);
    } finally { await Promise.allSettled([first.close(), second.close(), pool.end()]); await db.close(); }
  });
  it('rolls failed init back and can retry the same migration', async () => {
    const db = await isolatedPostgres(databaseUrl!), store = new PostgresBotDialogueStore(db.url), pool = new pg.Pool({ connectionString: db.url });
    try {
      await pool.query('CREATE TABLE aeeis_bot_dialogue_operations(broken text)');
      await expect(store.init()).rejects.toThrow();
      expect((await pool.query("SELECT to_regclass('aeeis_bot_dialogues') AS name")).rows[0].name).toBeNull();
      await pool.query('DROP TABLE aeeis_bot_dialogue_operations'); await store.init(); await store.init();
      expect(await store.list(scope)).toEqual([]);
    } finally { await store.close(); await pool.end(); await db.close(); }
  });
  it('uses canonical message/task/run IDs after backfill, alias and server/store restart; content sealing survives import', async () => {
    const db = await isolatedPostgres(databaseUrl!), f = await dialogueFixture({ url: db.url });
    const pool = new pg.Pool({ connectionString: db.url });
    try {
      const one = await f.legacy('旧一', '2026-01-01T00:00:00.000Z'), two = await f.legacy('旧二', '2026-02-01T00:00:00.000Z');
      await one.say('原始历史'); await two.say('别名历史');
      const secondStore = new PostgresBotDialogueStore(db.url); await secondStore.init();
      const secondService = new BotDialogueService(secondStore, f.conversations, f.aggregates, f.domain, f.events, f.bots);
      const bindings = await Promise.all([f.service.ensure(f.bot.id, scope), secondService.ensure(f.bot.id, scope)]);
      expect(bindings[0]?.conversationId).toBe(bindings[1]?.conversationId); await secondStore.close();
      const binding = await f.ensure();
      const body = { text: '真实任务', expectedRevision: (await f.aggregates.get(binding.conversationId, scope)).revision, newTask: { title: '真实任务' }, intent: 'execute' };
      const key = randomUUID(); const sent = await f.request(`/rooms/${two.room.id}/dialogue/messages`, body, key);
      expect(sent.statusCode, sent.body).toBe(202);
      const replay = await f.request(`/conversations/${binding.conversationId}/messages`, body, key); expect(replay.json().runId).toBe(sent.json().runId);
      expect(await f.runs.list(scope)).toHaveLength(1);
      const raw = (await pool.query('SELECT state FROM aeeis_conversations WHERE id=$1', [binding.conversationId])).rows[0].state;
      const aggregate = await openAggregate<any>('conversation', binding.conversationId, raw); expect(aggregate.messages[0].text).toBe('原始历史');
      const reopened = new PostgresBotDialogueStore(db.url); await reopened.init();
      try { expect(await reopened.list(scope)).toMatchObject([{ phase: 'ready', roomId: one.room.id }]); expect(await reopened.aliases(scope)).toMatchObject([{ aliasRoomId: two.room.id }]); expect((await reopened.operations(scope)).every(op => op.status === 'completed')).toBe(true); }
      finally { await reopened.close(); }
      const alias = (await f.request(`/rooms/${two.room.id}/dialogue`)).json(), home = (await f.request(`/conversations/${binding.conversationId}`)).json();
      expect(alias.messages).toEqual(home.messages); expect(alias.tasks[0].runId).toBe(home.tasks[0].runId);
    } finally { await f.close(); await pool.end(); await db.close(); }
  });
});
