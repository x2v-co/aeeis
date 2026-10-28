import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemoryOwnedBotStore, JsonOwnedBotStore, OWNED_BOT_CAP, OwnedBotConflict } from '../src/owned-bots.js';

const profile = { name: '阿核', mark: 'letter' as const, color: '#176b45', background: '核对清单上的每一项。' };
const scope = { owner: 'alice', tenantId: 'team-a' };

describe('owned bots', () => {
  it('keeps one profile per account and reloads it from the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-owned-bots-'));
    const first = new JsonOwnedBotStore(join(directory, 'owned-bots.json'));
    await first.init();
    let savedId = '';
    try {
      const saved = await first.create(profile, scope, '2026-10-27T00:00:00.000Z');
      savedId = saved.id;
      expect(saved.id).toMatch(/^bot_[a-z0-9-]{8,80}$/);
      const again = await first.create({ ...profile, id: saved.id, name: '改名' }, scope, '2026-10-27T00:00:01.000Z');
      expect(again).toMatchObject({ id: saved.id, name: '阿核' });
      await expect(first.create({ ...profile, name: '阿核' }, scope)).rejects.toBeInstanceOf(OwnedBotConflict);
      await expect(first.create({ ...profile, name: '所有人' }, scope)).rejects.toThrow('请换一个名字');
      await expect(first.create({ ...profile, id: saved.id }, { owner: 'bob', tenantId: 'team-a' })).rejects.toThrow('另一个账号');
      expect(await first.list({ owner: 'bob', tenantId: 'team-a' })).toEqual([]);
      expect(await first.list(scope)).toHaveLength(1);
      await first.remove(saved.id, scope, '2026-10-28T00:00:00.000Z');
      expect(await first.list(scope)).toEqual([]);
      await expect(first.create({ ...profile, id: saved.id, name: '换了个人' }, scope)).rejects.toThrow('已经撤下');
    } finally { await first.close(); }

    const second = new JsonOwnedBotStore(join(directory, 'owned-bots.json'));
    await second.init();
    try {
      expect(await second.list(scope)).toEqual([]);
      await expect(second.create({ ...profile, id: savedId, name: '换了个人' }, { owner: 'bob', tenantId: 'team-a' })).rejects.toThrow('已经撤下');
    }
    finally { await second.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('stops at the account cap', async () => {
    const bots = new InMemoryOwnedBotStore();
    for (let index = 0; index < OWNED_BOT_CAP; index += 1) {
      await bots.create({ ...profile, name: `人${index}` }, scope, '2026-10-27T00:00:00.000Z');
    }
    await expect(bots.create({ ...profile, name: '再一位' }, scope)).rejects.toThrow('最多留下 30');
    expect(await bots.list(scope)).toHaveLength(OWNED_BOT_CAP);
    const [first] = await bots.list(scope);
    await bots.remove(first!.id, scope, '2026-10-28T00:00:00.000Z');
    await expect(bots.create({ ...profile, id: first!.id, name: '原号' }, scope)).rejects.toThrow('已经撤下');
    await expect(bots.create({ ...profile, name: '再一位' }, scope)).resolves.toMatchObject({ name: '再一位' });
    expect(await bots.list(scope)).toHaveLength(OWNED_BOT_CAP);
  });

  it('lists and creates only inside the signed-in account', async () => {
    const bots = new InMemoryOwnedBotStore();
    const app = buildApp({
      repository: new InMemoryRunRepository(),
      ownedBots: bots,
      principalTokens: {
        alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
        bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
        viewer: { id: 'viewer', tenantId: 'team-a', roles: ['agent'] },
      },
    });
    try {
      const denied = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer viewer' }, payload: profile });
      expect(denied.statusCode).toBe(403);
      const created = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: { ...profile, role: '核对发布清单' } });
      expect(created.statusCode).toBe(200);
      const saved = created.json() as { id: string; name: string; role?: string; owner?: string };
      expect(saved).toMatchObject({ name: '阿核', role: '核对发布清单' });
      expect(saved.owner).toBeUndefined();
      const replay = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: { ...profile, id: saved.id, name: '改名' } });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ id: saved.id, name: '阿核' });
      const other = await app.inject({ method: 'GET', url: '/api/bots', headers: { authorization: 'Bearer bob' } });
      expect(other.statusCode).toBe(200);
      expect(other.json()).toEqual([]);
      const mine = await app.inject({ method: 'GET', url: '/api/bots', headers: { authorization: 'Bearer alice' } });
      expect(mine.json()).toEqual([expect.objectContaining({ id: saved.id, name: '阿核' })]);
      const taken = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer bob' }, payload: { ...profile, id: saved.id } });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error).toContain('另一个账号');
    } finally { await app.close(); await bots.close(); }
  });

  it('renames and removes a Bot, and shows that name to other people in the room', async () => {
    const bots = new InMemoryOwnedBotStore();
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships, undefined, bots);
    const app = buildApp({
      repository: new InMemoryRunRepository(), domain, ownedBots: bots,
      principalTokens: {
        alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
        bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
      },
    });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: profile });
      expect(created.statusCode).toBe(200);
      const saved = created.json() as { id: string };
      const renamed = await app.inject({ method: 'PATCH', url: `/api/bots/${saved.id}`, headers: { authorization: 'Bearer alice' }, payload: { ...profile, name: '阿核二' } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ id: saved.id, name: '阿核二' });
      const foreign = await app.inject({ method: 'DELETE', url: `/api/bots/${saved.id}`, headers: { authorization: 'Bearer bob' } });
      expect(foreign.statusCode).toBe(404);
      const room = await app.inject({ method: 'POST', url: '/api/rooms', headers: { authorization: 'Bearer alice' }, payload: { title: '一组', description: '群聊' } });
      expect(room.statusCode).toBe(200);
      const roomId = room.json().id as string;
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/members`, headers: { authorization: 'Bearer alice' }, payload: { principalId: 'bob', role: 'editor' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/members`, headers: { authorization: 'Bearer alice' }, payload: { principalId: saved.id, role: 'agent' } })).statusCode).toBe(200);
      const second = await app.inject({ method: 'POST', url: '/api/rooms', headers: { authorization: 'Bearer alice' }, payload: { title: '二组', description: '群聊' } });
      expect(second.statusCode).toBe(200);
      const roomId2 = second.json().id as string;
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${roomId2}/members`, headers: { authorization: 'Bearer alice' }, payload: { principalId: saved.id, role: 'agent' } })).statusCode).toBe(200);
      const members = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/members`, headers: { authorization: 'Bearer bob' } });
      expect(members.statusCode).toBe(200);
      expect(members.json()).toEqual(expect.arrayContaining([expect.objectContaining({ principalId: saved.id, displayName: '阿核二' })]));
      const removed = await app.inject({ method: 'DELETE', url: `/api/bots/${saved.id}`, headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, payload: '' });
      expect(removed.statusCode).toBe(200);
      for (const id of [roomId, roomId2]) {
        const after = await app.inject({ method: 'GET', url: `/api/rooms/${id}/members`, headers: { authorization: 'Bearer alice' } });
        const botMember = (after.json() as Array<{ principalId: string; status: string; displayName?: string }>).find(member => member.principalId === saved.id);
        expect(botMember).toMatchObject({ status: 'revoked' });
        expect(botMember?.displayName).toBeUndefined();
      }
      expect(await bots.list(scope)).toEqual([]);
      const reused = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: { ...profile, id: saved.id, name: '换了个人' } });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error).toContain('已经撤下');
      const stolen = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer bob' }, payload: { ...profile, id: saved.id, name: '换了个人' } });
      expect(stolen.statusCode).toBe(409);
      expect(stolen.json().error).toContain('已经撤下');
      const again = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: { ...profile, name: '新人' } });
      expect(again.statusCode).toBe(200);
    } finally { await app.close(); await bots.close(); }
  });
});
