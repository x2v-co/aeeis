import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { InMemoryTenantMemberStore, JsonTenantMemberStore, TenantMembers, type ListedMember } from '../src/tenant-members.js';
import type { Principal } from '../src/security/principal.js';

const alice: Principal = { id: 'alice', tenantId: 'team-a', roles: ['owner', 'operator'] };
const bob: Principal = { id: 'bob', tenantId: 'team-a', roles: ['owner'] };
const dana: Principal = { id: 'dana', tenantId: 'team-a', roles: ['owner'] };
// Same id as a team-a person, in another tenant.
const bobB: Principal = { id: 'bob', tenantId: 'team-b', roles: ['owner'] };
const carol: Principal = { id: 'carol', tenantId: 'team-b', roles: ['owner', 'operator'] };
const listed: ListedMember[] = [
  { email: 'alice@a.example', principalId: 'alice', tenantId: 'team-a' },
  { email: 'bob@a.example', principalId: 'bob', tenantId: 'team-a' },
  { email: 'dana@a.example', principalId: 'dana', tenantId: 'team-a' },
  { email: 'bob@b.example', principalId: 'bob', tenantId: 'team-b' },
  { email: 'carol@b.example', principalId: 'carol', tenantId: 'team-b' },
];

describe('Tenant members', () => {
  it('lists only the viewer’s tenant: allow-list entries, domain sign-ins and the viewer', async () => {
    const members = new TenantMembers(new InMemoryTenantMemberStore(), listed);
    await members.signedIn({ id: 'google:42', tenantId: 'team-a', roles: ['owner'] }, { email: 'erin@a.example', googleName: 'Erin', via: 'domain' });
    await members.signedIn({ id: 'google:77', tenantId: 'team-b', roles: ['owner'] }, { email: 'frank@b.example', googleName: 'Frank', via: 'domain' });
    await members.signedIn(bobB, { email: 'bob@b.example', googleName: 'Bob of B', via: 'listed' });

    const seenByAlice = await members.list(alice);
    expect(seenByAlice.map(member => member.principalId).sort()).toEqual(['alice', 'bob', 'dana', 'google:42']);
    expect(seenByAlice[0]).toMatchObject({ principalId: 'alice', isSelf: true });
    expect(seenByAlice.find(member => member.principalId === 'google:42')).toMatchObject({ name: 'Erin', email: 'erin@a.example', source: 'domain' });
    // team-b's bob signed in with a Google name; team-a's bob is still only an address.
    expect(seenByAlice.find(member => member.principalId === 'bob')).toMatchObject({ name: 'bob@a.example', email: 'bob@a.example', source: 'listed' });
    expect(JSON.stringify(seenByAlice)).not.toMatch(/frank|carol|b\.example|Bob of B/);

    const seenByCarol = await members.list(carol);
    expect(seenByCarol.map(member => member.principalId).sort()).toEqual(['bob', 'carol', 'google:77']);
    expect(JSON.stringify(seenByCarol)).not.toMatch(/alice|dana|erin|a\.example/);

    expect(await members.find(alice, 'carol')).toBeUndefined();
    expect(await members.find(alice, 'google:77')).toBeUndefined();
    expect(await members.find(carol, 'dana')).toBeUndefined();
  });

  it('keeps a display name per tenant, across later sign-ins, and uses it as the label', async () => {
    const members = new TenantMembers(new InMemoryTenantMemberStore(), listed);
    await members.rename(alice, 'bob', '小鲍');
    await members.signedIn(bob, { email: 'bob@a.example', googleName: 'Robert', via: 'listed' });
    expect(await members.find(alice, 'bob')).toMatchObject({ name: '小鲍', displayName: '小鲍', googleName: 'Robert' });
    expect(await members.label('bob', 'team-a')).toBe('小鲍');
    // The same id in another tenant is another person.
    expect(await members.label('bob', 'team-b')).toBeUndefined();
    expect((await members.find(carol, 'bob'))?.name).toBe('bob@b.example');
    // Renaming someone outside the tenant finds no one and writes nothing.
    expect(await members.rename(alice, 'carol', 'x')).toBeUndefined();
    expect(await members.label('carol', 'team-b')).toBeUndefined();
    await members.rename(alice, 'bob', undefined);
    expect(await members.find(alice, 'bob')).toMatchObject({ name: 'Robert' });
    await expect(members.rename(alice, 'bob', 'a\u0007b')).rejects.toThrow();
  });

  it('persists records in a JSON file', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'aeeis-members-')), 'members.json');
    const first = new JsonTenantMemberStore(path);
    await new TenantMembers(first, listed).rename(alice, 'dana', '达娜');
    await first.close();
    const second = new TenantMembers(new JsonTenantMemberStore(path), listed);
    expect(await second.find(alice, 'dana')).toMatchObject({ name: '达娜' });
    expect(await second.find(carol, 'dana')).toBeUndefined();
  });
});

describe('Members and people over HTTP', () => {
  async function setup() {
    const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
    const tenantMembers = new TenantMembers(new InMemoryTenantMemberStore(), listed);
    const app = buildApp({
      repository: new InMemoryRunRepository(), domain, tenantMembers,
      principalTokens: { alice, bob, dana, 'bob-b': bobB, carol, ops: { id: 'ops', tenantId: 'team-a', roles: ['operator'] } },
    });
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    return { app, domain, tenantMembers, as };
  }

  it('shows the viewer’s tenant only, and lets only an administrator name people', async () => {
    const { app, as } = await setup();
    try {
      const forAlice = await app.inject({ method: 'GET', url: '/api/members', headers: as('alice') });
      expect(forAlice.statusCode).toBe(200);
      expect(forAlice.json()).toMatchObject({ canName: true });
      expect(forAlice.json().members.map((member: { principalId: string }) => member.principalId).sort()).toEqual(['alice', 'bob', 'dana']);
      expect(forAlice.body).not.toMatch(/carol|b\.example/);

      const forCarol = (await app.inject({ method: 'GET', url: '/api/members', headers: as('carol') })).json();
      expect(forCarol.members.map((member: { principalId: string }) => member.principalId).sort()).toEqual(['bob', 'carol']);
      expect(JSON.stringify(forCarol)).not.toMatch(/alice|dana|a\.example/);

      const renamed = await app.inject({ method: 'PUT', url: '/api/members/dana', headers: as('alice'), payload: { displayName: '达娜' } });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({ principalId: 'dana', name: '达娜' });
      // Not an administrator.
      expect((await app.inject({ method: 'PUT', url: '/api/members/dana', headers: as('bob'), payload: { displayName: 'x' } })).statusCode).toBe(403);
      // An administrator of another tenant cannot reach this tenant's people, even with a colliding id.
      expect((await app.inject({ method: 'PUT', url: '/api/members/dana', headers: as('carol'), payload: { displayName: 'x' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'PUT', url: '/api/members/bob', headers: as('carol'), payload: { displayName: 'B 的鲍' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/people/bob', headers: as('alice') })).json()).toMatchObject({ name: 'bob@a.example' });
      expect((await app.inject({ method: 'GET', url: '/api/people/dana', headers: as('bob') })).json()).toMatchObject({ name: '达娜' });
      // Clearing the name falls back to the address.
      expect((await app.inject({ method: 'PUT', url: '/api/members/dana', headers: as('alice'), payload: { displayName: null } })).json()).toMatchObject({ name: 'dana@a.example' });
      // A machine principal without the owner role is not a person here.
      expect((await app.inject({ method: 'GET', url: '/api/members', headers: as('ops') })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('shows only group chats the viewer shares with the person, never another tenant’s', async () => {
    const { app, domain, as } = await setup();
    try {
      const shared = await domain.createRoom({ title: '共同的群', description: '群聊' }, undefined, 'alice', 'team-a');
      await domain.addRoomMember(shared.id, 'bob', 'editor', 'alice', 'team-a');
      const bobsOwn = await domain.createRoom({ title: '鲍自己的群', description: '群聊' }, undefined, 'bob', 'team-a');
      await domain.addRoomMember(bobsOwn.id, 'alice', 'viewer', 'bob', 'team-a');
      // Bob and Dana's group: Alice is not in it, so it never shows to her.
      const without = await domain.createRoom({ title: '没有 Alice 的群', description: '群聊' }, undefined, 'dana', 'team-a');
      await domain.addRoomMember(without.id, 'bob', 'editor', 'dana', 'team-a');
      // Alice's group without Bob.
      await domain.createRoom({ title: 'Alice 一个人的群', description: '群聊' }, undefined, 'alice', 'team-a');
      // Alice's private room with Bob is not a group chat.
      const direct = await domain.createRoom({ title: '私聊', description: '私聊' }, undefined, 'alice', 'team-a');
      await domain.addRoomMember(direct.id, 'bob', 'editor', 'alice', 'team-a');
      // Another tenant: a group owned by team-b's bob, with carol in it.
      const other = await domain.createRoom({ title: 'B 的群', description: '群聊' }, undefined, 'carol', 'team-b');
      await domain.addRoomMember(other.id, 'bob', 'editor', 'carol', 'team-b');
      // An archived shared group drops out.
      const archived = await domain.createRoom({ title: '归档的群', description: '群聊' }, undefined, 'alice', 'team-a');
      await domain.addRoomMember(archived.id, 'bob', 'editor', 'alice', 'team-a');
      await domain.updateRoom(archived.id, { status: 'archived', expectedRevision: 0 }, undefined, 'alice', 'team-a');

      const bobForAlice = await app.inject({ method: 'GET', url: '/api/people/bob', headers: as('alice') });
      expect(bobForAlice.statusCode).toBe(200);
      expect(bobForAlice.json()).toMatchObject({ principalId: 'bob', email: 'bob@a.example', isSelf: false });
      expect(bobForAlice.json().sharedGroups.map((group: { title: string }) => group.title).sort()).toEqual(['共同的群', '鲍自己的群']);

      const aliceForBob = (await app.inject({ method: 'GET', url: '/api/people/alice', headers: as('bob') })).json();
      expect(aliceForBob.sharedGroups.map((group: { title: string }) => group.title).sort()).toEqual(['共同的群', '鲍自己的群']);

      const bobForCarol = (await app.inject({ method: 'GET', url: '/api/people/bob', headers: as('carol') })).json();
      expect(bobForCarol).toMatchObject({ principalId: 'bob', email: 'bob@b.example' });
      expect(bobForCarol.sharedGroups).toEqual([{ id: other.id, title: 'B 的群' }]);

      // Someone from another tenant is not a person here at all.
      expect((await app.inject({ method: 'GET', url: '/api/people/carol', headers: as('alice') })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/people/dana', headers: as('carol') })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/people/nobody', headers: as('alice') })).statusCode).toBe(404);

      // Room members carry the person's name for the group header.
      await app.inject({ method: 'PUT', url: '/api/members/bob', headers: as('alice'), payload: { displayName: '小鲍' } });
      const roster = (await app.inject({ method: 'GET', url: `/api/rooms/${shared.id}/members`, headers: as('alice') })).json();
      expect(roster.find((member: { principalId: string }) => member.principalId === 'bob')).toMatchObject({ displayName: '小鲍' });
      const rosterB = (await app.inject({ method: 'GET', url: `/api/rooms/${other.id}/members`, headers: as('carol') })).json();
      expect(rosterB.find((member: { principalId: string }) => member.principalId === 'bob').displayName).toBeUndefined();
    } finally { await app.close(); }
  });
});

describe('Privacy page', () => {
  it('opens without sign-in, also from Google’s consent screen, and says what is stored', async () => {
    const app = buildApp({ repository: new InMemoryRunRepository(), token: 'local-token', privacy: { contact: 'privacy@example.com', backupDays: 14, encrypted: true } });
    try {
      const page = await app.inject({ method: 'GET', url: '/privacy', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toMatch(/text\/html/);
      for (const text of ['从 Google 拿到什么', '存了什么', '谁能看见', '怎么删', 'Brain', 'Run 记录和回执', '每个租户有自己的数据密钥', '加密备份保留 14 天', 'mailto:privacy@example.com', '有限使用']) expect(page.body).toContain(text);
      // Cloudflare leaves the contact address alone, so it reads the same without JavaScript.
      expect(page.body).toContain('<!--email_off--><a href="mailto:privacy@example.com">privacy@example.com</a><!--/email_off-->');
      expect((await app.inject({ method: 'GET', url: '/privacy.css' })).statusCode).toBe(200);
      // Other pages still refuse a cross-site navigation.
      expect((await app.inject({ method: 'GET', url: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('does not claim encryption a deployment does not have, and escapes the contact', async () => {
    const app = buildApp({ repository: new InMemoryRunRepository(), privacy: { contact: '<b>admin</b>' } });
    try {
      const body = (await app.inject({ method: 'GET', url: '/privacy' })).body;
      expect(body).toContain('这台部署没有开启内容加密');
      expect(body).not.toContain('每个租户有自己的数据密钥');
      expect(body).toContain('&lt;b&gt;admin&lt;/b&gt;');
    } finally { await app.close(); }
  });
});
