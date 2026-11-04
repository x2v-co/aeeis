import { ChannelBoardService } from '../src/channel-board.js';
import { InMemorySessionEventRepository, SessionEventService } from '../src/session-events.js';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { vi } from 'vitest';
import { renderChannelManager } from '../src/ui/channel-management.js';
import { ContentCipher, InMemoryContentKeyStore, configureContentEncryption, contentEncryption } from '../src/content-encryption.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHANNEL_METADATA_MIGRATION } from '../src/channel-metadata.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';
import { dialogueFixture, dialogueScope as scope } from './support/bot-dialogues.js';

it('keeps migration 009 identical to the embedded idempotent SQL', async () => {
  expect(await readFile('src/adapters/migrations/009-channel-metadata.sql', 'utf8')).toBe(CHANNEL_METADATA_MIGRATION);
});

describe.each(['memory', 'file'])('%s channel management contract', kind => {
  it('freezes legacy types before description edits, defaults unknown rooms, and atomically persists metadata with CAS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-contract-'));
    const file = join(directory, 'domain.json');
    const store = kind === 'file' ? new JsonFileStore(file) : new InMemoryStore();
    if (store instanceof JsonFileStore) await store.init();
    const service = new AeeisService(store);
    try {
      const at = '2026-01-01T00:00:00.000Z';
      await store.commitRoomCreation({ id: 'room_legacy', title: '旧频道', owner: 'alice', tenantId: 'team-a', description: '私聊', status: 'active', createdAt: at, updatedAt: at });
      expect(await service.getRoom('room_legacy', 'alice', 'team-a')).toMatchObject({ chat: 'direct', category: 'general', revision: 0 });
      const changed = await service.updateRoom('room_legacy', { description: '群聊', category: 'product', topicRef: '产品 A', expectedRevision: 0 }, at, 'alice', 'team-a');
      expect(changed).toMatchObject({ chat: 'direct', category: 'product', topicRef: '产品 A', revision: 1 });
      await expect(service.updateRoom(changed.id, { title: '陈旧标题', expectedRevision: 0 }, at, 'alice', 'team-a')).rejects.toThrow(/版本冲突/);
      const attempts = await Promise.allSettled(['topic', 'general'].map(category => service.updateRoom(changed.id, { category: category as 'topic' | 'general', expectedRevision: 1 }, at, 'alice', 'team-a')));
      expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      expect(await service.getRoom(changed.id, 'alice', 'team-a')).toMatchObject({ revision: 2, title: '旧频道', chat: 'direct' });
      await store.commitRoomCreation({ id: 'room_unknown', title: '无法推断', description: '旧项目', status: 'active', createdAt: at, updatedAt: at });
      expect(await service.getRoom('room_unknown')).toMatchObject({ chat: 'unclassified', category: 'general', revision: 0 });
      const room = await service.createRoom({ title: '产品 A', category: 'product' }, at, 'alice', 'team-a');
      expect(room).toMatchObject({ chat: 'group', category: 'product', revision: 0 });
      const archived = await service.updateRoom(room.id, { status: 'archived', expectedRevision: 0 }, at, 'alice', 'team-a');
      await expect(service.updateRoom(room.id, { title: '不可改', expectedRevision: 1 }, at, 'alice', 'team-a')).rejects.toThrow(/只读/);
      expect(await service.updateRoom(room.id, { status: 'active', expectedRevision: archived.revision! }, at, 'alice', 'team-a')).toMatchObject({ id: room.id, revision: 2, category: 'product' });
      const pagedIds: string[] = []; let cursor: string | undefined;
      do {
        const page = await store.getRoomsPage!(1, cursor);
        expect(page.rooms).toHaveLength(1); expect(page.rooms[0]).toMatchObject({ category: expect.any(String), revision: expect.any(Number) });
        pagedIds.push(page.rooms[0]!.id); cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(pagedIds).size).toBe(3);
      if (store instanceof JsonFileStore) {
        await store.close(); const reopened = new JsonFileStore(file); await reopened.init();
        try { expect(await new AeeisService(reopened).getRoom(changed.id, 'alice', 'team-a')).toMatchObject({ revision: 2, chat: 'direct', topicRef: '产品 A' }); }
        finally { await reopened.close(); }
      }
    } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

it('exposes owner/editor/viewer/agent permissions, revocation, tenant isolation and bounded lists', async () => {
  const memberships = new InMemoryRoomMembershipRepository(), service = new AeeisService(new InMemoryStore(), [], memberships);
  const room = await service.createRoom({ title: '产品' }, undefined, 'alice', 'team-a');
  for (const role of ['editor', 'viewer', 'agent'] as const) {
    await service.addRoomMember(room.id, role, role, 'alice', 'team-a');
    expect(await service.getRoomForPrincipal(room.id, role, 'team-a')).toMatchObject({ memberRole: role, canEdit: role === 'editor', canArchive: false, canWrite: role !== 'viewer' });
    if (role === 'editor') await service.updateRoom(room.id, { title: '编辑后的产品', expectedRevision: 0 }, undefined, role, 'team-a');
    else await expect(service.updateRoom(room.id, { title: '越权', expectedRevision: 1 }, undefined, role, 'team-a')).rejects.toThrow(/editor/);
    await expect(service.updateRoom(room.id, { status: 'archived', expectedRevision: 1 }, undefined, role, 'team-a')).rejects.toThrow();
  }
  await expect(service.getRoomForPrincipal(room.id, 'alice', 'team-b')).rejects.toThrow(/Unknown room/);
  await expect(service.getRoomForPrincipal(room.id, 'stranger', 'team-a')).rejects.toThrow(/Unknown room/);
  expect(await service.listRoomsForPrincipal('stranger', 'team-a')).toEqual([]);
  expect(await service.listRoomsForPrincipal('alice', 'team-a', 1)).toHaveLength(1);
  await service.revokeRoomMember(room.id, 'editor', 'alice', 'team-a');
  expect(await service.listRoomsForPrincipal('editor', 'team-a')).toEqual([]);
  await service.updateRoom(room.id, { status: 'archived', expectedRevision: 1 }, undefined, 'alice', 'team-a');
  for (const actor of ['alice', 'viewer', 'agent']) await expect(service.assertRoomEventWriter(room.id, actor, 'team-a')).rejects.toThrow();
  await expect(service.addRoomMember(room.id, 'new', 'editor', 'alice', 'team-a')).rejects.toThrow(/只读/);
});

it('keeps archived direct history readable and its Run alive; both send paths reject until the original Room is restored', async () => {
  const f = await dialogueFixture();
  try {
    const binding = await f.ensure();
    const sent = await f.request(`/rooms/${binding.roomId}/dialogue/messages`, { text: '执行核对', expectedRevision: 0, newTask: { title: '核对任务' }, intent: 'execute' }, 'first-run');
    expect(sent.statusCode, sent.body).toBe(202);
    const run = (await f.runs.list(scope))[0]!;
    await f.domain.updateRoom(binding.roomId, { status: 'archived', expectedRevision: 0 }, undefined, scope.owner, scope.tenantId);
    expect((await f.request(`/rooms/${binding.roomId}/dialogue`)).json().messages).toHaveLength(1);
    expect((await f.ensure()).roomId).toBe(binding.roomId);
    expect((await f.ensure()).conversationId).toBe(binding.conversationId);
    const body = { text: '归档后消息', expectedRevision: 1, unassigned: true, intent: 'discuss' };
    for (const path of [`/rooms/${binding.roomId}/dialogue/messages`, `/conversations/${binding.conversationId}/messages`]) {
      const response = await f.request(path, body, path); expect(response.statusCode, response.body).toBe(409);
    }
    expect((await f.runs.get(run.id, scope)).status).toBe(run.status);
    await f.engine.advance(run.id); expect((await f.runs.get(run.id, scope)).status).toBe('needs_approval');
    expect(await f.aggregates.list(scope)).toHaveLength(1);
    await f.domain.updateRoom(binding.roomId, { status: 'active', expectedRevision: 1 }, undefined, scope.owner, scope.tenantId);
    expect((await f.ensure()).conversationId).toBe(binding.conversationId);
    const current = (await f.request(`/rooms/${binding.roomId}/dialogue`)).json();
    const restored = await f.request(`/rooms/${binding.roomId}/dialogue/messages`, { ...body, expectedRevision: current.revision }, 'after-restore');
    expect(restored.statusCode, restored.body).toBe(200);
  } finally { await f.close(); }
});

it('seals File topic metadata in the journal/snapshot while retaining CAS and restart behavior', async () => {
  const previous = contentEncryption();
  configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
  const directory = await mkdtemp(join(tmpdir(), 'channel-encryption-')), path = join(directory, 'domain.json');
  const store = new JsonFileStore(path, { compactAfterEntries: 2 }); await store.init();
  try {
    const service = new AeeisService(store, [{ channel: 'internal', destination: 'room', aggregateTypes: ['room'] }]);
    const room = await service.createRoom({ title: '产品', category: 'product', topicRef: '私密主题文字' });
    const changed = await service.updateRoom(room.id, { expectedRevision: 0, topicRef: '新私密主题文字' });
    expect(await service.getRoom(room.id)).toMatchObject({ topicRef: '新私密主题文字', revision: 1 });
    const snapshot = await readFile(path, 'utf8'); expect(snapshot).not.toContain('私密主题文字'); expect(snapshot).toContain('aeeis-enc/1:');
    await store.close(); const reopened = new JsonFileStore(path); await reopened.init();
    try {
      expect(await new AeeisService(reopened).getRoom(room.id)).toEqual(changed);
      expect((await reopened.getRoomsPage(1)).rooms[0]).toMatchObject({ topicRef: '新私密主题文字', revision: 1 });
    } finally { await reopened.close(); }
  } finally { await store.close(); configureContentEncryption(previous); await rm(directory, { recursive: true, force: true }); }
});

it('homepage compact manager uses the same Room CRUD for product/topic channels, rename and archive/restore', async () => {
  const f = await dialogueFixture(), dom = new JSDOM('<div id="manager"></div>', { url: 'http://localhost/' });
  vi.stubGlobal('document', dom.window.document);
  const container = dom.window.document.getElementById('manager')!;
  const api = async (path: string, body?: unknown, method?: string) => {
    const result = await f.app.inject({ method: (method ?? 'GET') as 'GET' | 'POST' | 'PATCH', url: `/api${path}`, headers: { authorization: 'Bearer alice' }, ...(body === undefined ? {} : { payload: body as object }) });
    if (result.statusCode >= 400) throw new Error(result.body); return result.json();
  };
  let error = '';
  const refresh = async () => renderChannelManager(container, await api('/rooms'), api, refresh, message => { error = message; });
  const wait = async (check: () => boolean) => { for (let i=0; i<100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); expect(check(), error).toBe(true); };
  const click = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent === text)!.click();
  try {
    await refresh();
    for (const [name, category] of [['产品一', 'product'], ['主题二', 'topic']]) {
      click('新建频道'); await wait(() => Boolean(container.querySelector('form')));
      container.querySelector<HTMLInputElement>('[aria-label="频道名称"]')!.value = name!;
      container.querySelector<HTMLSelectElement>('select')!.value = category!;
      container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
      await wait(() => !container.querySelector('form') && Boolean([...container.querySelectorAll('a')].find(node => node.textContent === name)));
    }
    const rooms = await api('/rooms'); expect(rooms).toHaveLength(2); expect(rooms.map((room: any) => room.category).sort()).toEqual(['product', 'topic']);
    click('改名 / 分类'); await wait(() => Boolean(container.querySelector('form')));
    container.querySelector<HTMLInputElement>('[aria-label="频道名称"]')!.value = '已改名'; container.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await wait(() => !container.querySelector('form') && container.textContent!.includes('已改名'));
    click('归档'); await wait(() => container.querySelectorAll('a').length === 1);
    const filter = container.querySelector<HTMLInputElement>('input[type=checkbox]')!; filter.checked = true; filter.dispatchEvent(new dom.window.Event('change'));
    expect(container.querySelectorAll('a')).toHaveLength(1); const originalLink = container.querySelector('a')!.href;
    click('恢复'); await wait(() => container.querySelectorAll('a').length === 0);
    const list = await api('/rooms'); expect(list).toHaveLength(2); expect(list.every((room: any) => room.status === 'active')).toBe(true);
    expect(list.some((room: any) => originalLink.endsWith(encodeURIComponent(room.id)))).toBe(true); expect(error).toBe('');
  } finally { vi.unstubAllGlobals(); dom.window.close(); await f.close(); }
});

it('keeps an archived group history and task board readable while rejecting task actions and new events', async () => {
  const domain = new AeeisService(new InMemoryStore(), [], new InMemoryRoomMembershipRepository());
  const repository = new InMemorySessionEventRepository(), events = new SessionEventService(repository, domain);
  const room = await domain.createRoom({ title: '主题', category: 'topic' });
  const goal = await domain.createGoal({ title: '目标', roomId: room.id });
  const manifest = await domain.createContextManifest(goal.id, { purpose: '讨论', audienceMode: 'room' });
  await events.create(room.id, { type: 'system', content: '引用任务', goalId: goal.id, contextManifestId: manifest.id, evidenceRefs: ['conv_example', 'task_example'], idempotencyKey: 'cite' }, 'owner', 'local');
  const board = new ChannelBoardService(events, domain, async () => ({ id: 'conv_example', tasks: [{ id: 'task_example', title: '已有任务', status: 'discussion' }] }));
  const before = await board.board(room.id, 'owner', 'local'); expect(before.cards).toHaveLength(1);
  await domain.updateRoom(room.id, { status: 'archived', expectedRevision: 0 });
  await expect(board.act(room.id, { kind: 'block', conversationId: 'conv_example', taskId: 'task_example', contextManifestId: manifest.id, reason: '停止', idempotencyKey: 'blocked' }, 'owner', 'local')).rejects.toThrow(/归档/);
  await expect(events.create(room.id, { type: 'message', content: '新消息', contextManifestId: manifest.id, idempotencyKey: 'new' }, 'owner', 'local')).rejects.toThrow(/归档/);
  expect((await board.board(room.id, 'owner', 'local')).cards).toEqual(before.cards);
  expect(await events.history(room.id, 'owner', 'local')).toHaveLength(1);
});
