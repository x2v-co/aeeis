import { describe, expect, it } from 'vitest';
import { PostgresRoomMembershipRepository } from '../src/room-membership.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres room membership repository', () => {
  it.skipIf(!databaseUrl)('persists roles and revocation across repository instances', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRoomMembershipRepository(db.url); await first.init();
    const member = await first.add('room.1', 'bob', 'team-a', 'editor', 'alice', '2026-09-19T00:00:00.000Z');
    await first.close();
    const second = new PostgresRoomMembershipRepository(db.url); await second.init();
    try {
      expect(await second.get('room.1', 'bob', 'team-a')).toMatchObject({ id: member.id, role: 'editor', status: 'active' });
      expect(await second.revoke('room.1', 'bob', 'team-a', 'alice', '2026-09-19T00:00:01.000Z')).toMatchObject({ status: 'revoked' });
    } finally { await second.close(); await db.close(); }
  });
});
