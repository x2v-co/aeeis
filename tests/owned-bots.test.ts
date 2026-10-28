import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryConversationStore } from '../src/adapters/conversation-store.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, SessionEventService } from '../src/session-events.js';
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
      const rejoined = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/members`, headers: { authorization: 'Bearer alice' }, payload: { principalId: saved.id, role: 'agent' } });
      expect(rejoined.statusCode).toBe(409);
      expect(rejoined.json().error).toContain('已经撤下');
    } finally { await app.close(); await bots.close(); }
  });

  it('returns an open task to the channel and keeps a running task in place', async () => {
    const bots = new InMemoryOwnedBotStore();
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships, undefined, bots);
    const conversations = new InMemoryConversationStore();
    const sessionEvents = new SessionEventService(new InMemorySessionEventRepository(), domain);
    const app = buildApp({
      repository: new InMemoryRunRepository(), domain, ownedBots: bots, conversationStore: conversations, sessionEvents,
      principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } },
    });
    const life = {
      schemaVersion: 'conversation/1' as const,
      id: 'conv_00000000-0000-4000-8000-0000000000aa',
      owner: 'alice', tenantId: 'team-a', title: '阿核', revision: 1,
      createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
      recentTaskIds: [] as string[], messages: [],
    };
    try {
      const created = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: profile });
      const saved = created.json() as { id: string };
      const room = await app.inject({ method: 'POST', url: '/api/rooms', headers: { authorization: 'Bearer alice' }, payload: { title: '一组', description: '群聊' } });
      const roomId = room.json().id as string;
      expect((await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/members`, headers: { authorization: 'Bearer alice' }, payload: { principalId: saved.id, role: 'agent' } })).statusCode).toBe(200);
      const goal = await app.inject({ method: 'POST', url: '/api/goals', headers: { authorization: 'Bearer alice' }, payload: { title: '一组', roomId } });
      const goalId = goal.json().id as string;
      const manifest = await app.inject({ method: 'POST', url: `/api/goals/${goalId}/context-manifests`, headers: { authorization: 'Bearer alice' }, payload: { purpose: '群聊消息', audienceMode: 'room' } });
      const manifestId = manifest.json().id as string;
      await conversations.create({ ...life, agentId: saved.id, tasks: [{ id: 'task_note', threadId: 'thread_00000000-0000-4000-8000-0000000000aa', title: '整理纪要', createdAt: '2026-10-28T00:00:00.000Z' }] });
      const cited = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/session-events`, headers: { authorization: 'Bearer alice' }, payload: { goalId, type: 'system', content: '已交给阿核', contextManifestId: manifestId, evidenceRefs: [life.id, 'task_note', saved.id], idempotencyKey: 'handoff-note-1' } });
      expect(cited.statusCode).toBe(200);
      const removed = await app.inject({ method: 'DELETE', url: `/api/bots/${saved.id}`, headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, payload: '' });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().returned).toEqual([{ id: 'task_note', title: '整理纪要' }]);
      expect((await conversations.get(life.id, scope)).tasks).toEqual([expect.objectContaining({ id: 'task_note', title: '整理纪要' })]);
      const events = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/session-events?limit=20`, headers: { authorization: 'Bearer alice' } });
      expect(events.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'task_update', content: '退回待领取：整理纪要', evidenceRefs: [life.id, 'task_note'] })]));
      const busy = await app.inject({ method: 'POST', url: '/api/bots', headers: { authorization: 'Bearer alice' }, payload: { ...profile, name: '阿忙' } });
      const busyId = busy.json().id as string;
      await conversations.create({
        ...life, id: 'conv_00000000-0000-4000-8000-0000000000bb', agentId: busyId, title: '阿忙',
        tasks: [{ id: 'task_busy', threadId: 'thread_00000000-0000-4000-8000-0000000000bb', title: '还在核对', createdAt: '2026-10-28T00:00:00.000Z', latestRunId: 'run_00000000-0000-4000-8000-0000000000bb' }],
      });
      const blocked = await app.inject({ method: 'DELETE', url: `/api/bots/${busyId}`, headers: { authorization: 'Bearer alice' } });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toContain('还在核对');
      expect(await bots.list(scope)).toEqual([expect.objectContaining({ id: busyId, name: '阿忙' })]);
    } finally { await app.close(); await bots.close(); }
  });
});
