import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryRoomMembershipRepository, JsonRoomMembershipRepository } from '../src/room-membership.js';

describe('Room membership repository', () => {
  it('reactivates a revoked member without changing its stable identity', async () => {
    const repository = new InMemoryRoomMembershipRepository();
    const first = await repository.add('room.1', 'bob', 'team-a', 'viewer', 'alice', '2026-09-19T00:00:00.000Z');
    const revoked = await repository.revoke('room.1', 'bob', 'team-a', 'alice', '2026-09-19T00:00:01.000Z');
    const restored = await repository.add('room.1', 'bob', 'team-a', 'editor', 'alice', '2026-09-19T00:00:02.000Z');
    expect(revoked.status).toBe('revoked');
    expect(restored).toMatchObject({ id: first.id, status: 'active', role: 'editor' });
  });

  it('persists members across a JSON repository restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-room-membership-'));
    const path = join(directory, 'members.json');
    const first = new JsonRoomMembershipRepository(path); await first.init();
    await first.add('room.1', 'bob', 'team-a', 'viewer', 'alice'); await first.close();
    const second = new JsonRoomMembershipRepository(path); await second.init();
    expect(await second.list('room.1', 'team-a')).toHaveLength(1);
    await second.close();
  });
});

it('keeps archive and restore with the owner while an editor can classify and rename', async () => {
  const service = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
  const room = await service.createRoom({ title: '主题', category: 'topic' }, undefined, 'alice', 'team-a');
  await service.addRoomMember(room.id, 'bob', 'editor', 'alice', 'team-a');
  await service.updateRoom(room.id, { title: '新主题', expectedRevision: 0 }, undefined, 'bob', 'team-a');
  await expect(service.updateRoom(room.id, { status: 'archived', expectedRevision: 1 }, undefined, 'bob', 'team-a')).rejects.toThrow(/owner/);
  await service.updateRoom(room.id, { status: 'archived', expectedRevision: 1 }, undefined, 'alice', 'team-a');
  expect(await service.getRoomForPrincipal(room.id, 'bob', 'team-a')).toMatchObject({ canEdit: false, canWrite: false });
  await expect(service.updateRoom(room.id, { status: 'active', expectedRevision: 2 }, undefined, 'bob', 'team-a')).rejects.toThrow(/owner/);
  expect(await service.updateRoom(room.id, { status: 'active', expectedRevision: 2 }, undefined, 'alice', 'team-a')).toMatchObject({ id: room.id, title: '新主题', category: 'topic' });
});
