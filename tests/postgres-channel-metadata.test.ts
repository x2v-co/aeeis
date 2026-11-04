import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { AeeisService } from '../src/application/aeeis-service.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { withPostgresMigrationLock } from '../src/adapters/postgres-migration.js';
import { CHANNEL_METADATA_MIGRATION } from '../src/channel-metadata.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres channel metadata 009', () => {
  it.skipIf(!databaseUrl)('initializes concurrently and repeatedly; commits metadata and Room under one CAS and transaction', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresAeeisStore(db.url), second = new PostgresAeeisStore(db.url);
    const raw = new pg.Pool({ connectionString: db.url });
    try {
      await Promise.all([first.init(), second.init()]); await first.init();
      const service = new AeeisService(first), other = new AeeisService(second);
      const older = await service.createRoom({ title: '较早主题', category: 'topic' }, '2025-01-01T00:00:00.000Z', 'alice', 'team-a');
      const room = await service.createRoom({ title: '产品 A', category: 'product', topicRef: '主题说明' }, undefined, 'alice', 'team-a');
      expect(await other.getRoom(room.id, 'alice', 'team-a')).toMatchObject({ category: 'product', revision: 0, topicRef: '主题说明' });
      const writes = await Promise.allSettled([service, other].map((instance, i) => instance.updateRoom(room.id, { category: i ? 'general' : 'topic', expectedRevision: 0 }, undefined, 'alice', 'team-a')));
      expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1);
      const current = await other.getRoom(room.id, 'alice', 'team-a');
      // Failure occurs after UPDATE aeeis_rooms, proving the entire write rolls back.
      await expect(first.commitRoomUpdate(current, { ...current, title: 'must roll back', category: 'invalid' as 'general', revision: 2 })).rejects.toThrow(/check constraint/);
      expect(await other.getRoom(room.id, 'alice', 'team-a')).toEqual(current);
      const stored = (await raw.query('SELECT state FROM aeeis_rooms WHERE id=$1', [room.id])).rows[0].state;
      expect(stored).not.toHaveProperty('category'); expect(stored).not.toHaveProperty('topicRef'); expect(stored).not.toHaveProperty('revision');
      await service.updateRoom(room.id, { status: 'archived', expectedRevision: 1 }, undefined, 'alice', 'team-a');
      await second.init();
      expect(await other.updateRoom(room.id, { status: 'active', expectedRevision: 2 }, undefined, 'alice', 'team-a')).toMatchObject({ id: room.id, revision: 3, topicRef: '主题说明' });
      await expect(other.getRoom(room.id, 'bob', 'team-a')).rejects.toThrow(/Unknown room/);
      await expect(other.getRoom(room.id, 'alice', 'team-b')).rejects.toThrow(/Unknown room/);
      const page = await first.getRoomsPage(1); expect(page.rooms).toHaveLength(1); expect(page.rooms[0]).toMatchObject({ revision: 3 });
      expect(page.nextCursor).toBeTruthy();
      expect((await first.getRoomsPage(1, page.nextCursor)).rooms[0]).toMatchObject({ id: older.id, category: 'topic', revision: 0 });
    } finally { await first.close(); await second.close(); await raw.end(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('upgrades legacy Rooms, rolls failed migration back, recovers, and preserves original ids/status through DDL rollback', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresAeeisStore(db.url), raw = new pg.Pool({ connectionString: db.url });
    try {
      await store.init();
      await raw.query('DROP TABLE aeeis_channel_metadata');
      const at = '2026-01-01T00:00:00.000Z';
      for (const [id, description] of [['direct', '私聊'], ['group', '群聊'], ['unknown', '旧项目']]) {
        await raw.query('INSERT INTO aeeis_rooms(id,state,owner,tenant_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [id, { id, title: id, description, owner: 'alice', tenantId: 'team-a', status: 'archived', createdAt: at, updatedAt: at }, 'alice', 'team-a', at]);
      }
      await expect(withPostgresMigrationLock(raw, 'domain', async client => { await client.query(CHANNEL_METADATA_MIGRATION); await client.query('SELECT 1/0'); })).rejects.toThrow();
      expect((await raw.query("SELECT to_regclass('aeeis_channel_metadata') AS name")).rows[0].name).toBeNull();
      expect((await raw.query("SELECT state->>'chat' AS chat FROM aeeis_rooms WHERE id='direct'")).rows[0].chat).toBeNull();
      await store.init(); await store.init();
      const service = new AeeisService(store);
      for (const [id, chat] of [['direct', 'direct'], ['group', 'group'], ['unknown', 'unclassified']]) expect(await service.getRoom(id!, 'alice', 'team-a')).toMatchObject({ chat, category: 'general', revision: 0, status: 'archived' });
      await service.updateRoom('direct', { status: 'active', expectedRevision: 0 }, undefined, 'alice', 'team-a');
      await service.updateRoom('direct', { description: '群聊', expectedRevision: 1, category: 'topic' }, undefined, 'alice', 'team-a');
      await store.init(); expect(await service.getRoom('direct', 'alice', 'team-a')).toMatchObject({ chat: 'direct', revision: 2 });
      // Documented owner rollback leaves the Room compatible with the prior explicit-chat reader.
      await raw.query('BEGIN; DROP TABLE IF EXISTS aeeis_channel_metadata; COMMIT;');
      expect((await raw.query("SELECT state FROM aeeis_rooms WHERE id='direct'")).rows[0].state).toMatchObject({ id: 'direct', chat: 'direct', status: 'active' });
      await store.init(); expect(await service.getRoom('direct', 'alice', 'team-a')).toMatchObject({ id: 'direct', chat: 'direct', category: 'general' });
    } finally { await store.close(); await raw.end(); await db.close(); }
  });
});
