import { it, expect } from 'vitest';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemorySessionEventRepository, SessionEventService } from '../src/session-events.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryChannelNoiseStore } from '../src/channel-noise.js';
import { buildApp } from '../src/runtime/http.js';

const headers = (token: string) => ({ authorization: `Bearer ${token}` });
it('频道设置遵守群主、成员、旁人和租户权限；校验失败不改已有设置', async () => {
  const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
  const room = await domain.createRoom({ title: '安静协作' }, undefined, 'alice', 'team-a');
  await domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a');
  const events = new SessionEventService(new InMemorySessionEventRepository(), domain);
  const app = buildApp({ domain, sessionEvents: events, repository: new InMemoryRunRepository(), principalTokens: {
    alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
    outsider: { id: 'outsider', tenantId: 'team-a', roles: ['owner'] }, other: { id: 'alice', tenantId: 'team-b', roles: ['owner'] },
  } });
  const url = `/api/rooms/${room.id}/noise-settings`;
  try {
    expect((await app.inject({ method: 'GET', url, headers: headers('alice') })).json()).toEqual({ mode: 'quiet', digestMinutes: 15, quietHours: null, canEdit: true });
    const payload = { mode: 'lively', digestMinutes: 25, quietHours: { start: '23:00', end: '07:00', timeZone: 'Asia/Singapore' } };
    expect((await app.inject({ method: 'PUT', url, headers: headers('alice'), payload })).json()).toEqual({ ...payload, canEdit: true });
    expect((await app.inject({ method: 'GET', url, headers: headers('bob') })).json()).toEqual({ ...payload, canEdit: false });
    expect((await app.inject({ method: 'PUT', url, headers: headers('bob'), payload })).statusCode).toBe(409);
    for (const token of ['outsider', 'other']) expect((await app.inject({ method: 'GET', url, headers: headers(token) })).statusCode).toBe(404);
    for (const change of [{ digestMinutes: 14 }, { digestMinutes: 31 }, { mode: 'invalid' }, { unknown: true }, { quietHours: { start: '25:00', end: '07:00', timeZone: 'UTC' } }]) {
      expect((await app.inject({ method: 'PUT', url, headers: headers('alice'), payload: { ...payload, ...change } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'GET', url, headers: headers('alice') })).json()).toEqual({ ...payload, canEdit: true });
    await domain.revokeRoomMember(room.id, 'bob', 'alice', 'team-a');
    expect((await app.inject({ method: 'GET', url, headers: headers('bob') })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it('频道时间线在服务端合并普通进展，原事件仍可读，审批和升级始终可见', async () => {
  const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
  const room = await domain.createRoom({ title: '摘要频道' }, undefined, 'alice', 'team-a');
  const goal = await domain.createGoal({ title: '工作', roomId: room.id }, undefined, 'alice', 'team-a');
  const manifest = await domain.createContextManifest(goal.id, { purpose: '频道消息', audienceMode: 'room' }, undefined, 'alice', 'team-a');
  let now = Date.now();
  const events = new SessionEventService(new InMemorySessionEventRepository(), domain, new InMemoryChannelNoiseStore(), () => now);
  const app = buildApp({ domain, sessionEvents: events, repository: new InMemoryRunRepository(), principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
  const url = `/api/rooms/${room.id}/session-events`;
  const create = (key: string, type: 'message' | 'task_update' | 'decision' = 'message', notificationKind?: 'channel-upgrade') => events.create(room.id, { goalId: goal.id, type, content: key, contextManifestId: manifest.id, idempotencyKey: key, ...(notificationKind ? { notificationKind } : {}) }, 'alice', 'team-a', 'system');
  try {
    const progress = await create('ordinary-progress', 'task_update');
    for (let i = 0; i < 7; i++) await create(`bot-${i}`);
    const approval = await create('approval', 'decision');
    const upgrade = await create('upgrade', 'task_update', 'channel-upgrade');
    const visible = (await app.inject({ method: 'GET', url, headers: headers('alice') })).json().items;
    expect(visible).toHaveLength(8);
    expect(visible.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([approval.id, upgrade.id]));
    expect(visible.some((item: { id: string }) => item.id === progress.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: `${url}?includeQueued=1`, headers: headers('alice') })).json().items).toHaveLength(10);
    expect((await app.inject({ method: 'GET', url: `${url}/${progress.id}`, headers: headers('alice') })).json()).toMatchObject({ content: 'ordinary-progress' });
    now += 15 * 60_000;
    expect(await events.delivery.pump()).toBe(1);
    expect((await app.inject({ method: 'GET', url, headers: headers('alice') })).json().items.at(-1)).toMatchObject({ type: 'digest', content: '已合并 2 条' });
    // Queued facts remain available to the board and inbox's projections throughout.
    expect((await events.history(room.id, 'alice', 'team-a')).map(item => item.id)).toContain(progress.id);
    expect((await app.inject({ method: 'POST', url, headers: headers('alice'), payload: { goalId: goal.id, type: 'message', content: '不能自己标成审批', contextManifestId: manifest.id, idempotencyKey: 'spoof', notificationKind: 'approval' } })).statusCode).toBe(400);
  } finally { await app.close(); }
});
