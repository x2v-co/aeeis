import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileConversationStore } from '../src/adapters/conversation-store.js';
import { botDialoguesMigration, FileBotDialogueStore } from '../src/bot-dialogues.js';
import { ContentCipher, InMemoryContentKeyStore, configureContentEncryption, contentEncryption } from '../src/content-encryption.js';
import { TENANT_POLICIES } from '../src/adapters/postgres-pool.js';
import { dialogueFixture, dialogueScope as scope } from './support/bot-dialogues.js';

describe('Bot dialogue canonical dataflow', () => {
  it('007 SQL matches init, includes three RLS policies and documented rollback', async () => {
    expect(await readFile('src/adapters/migrations/007-bot-dialogues.sql', 'utf8')).toBe(botDialoguesMigration);
    expect(botDialoguesMigration.match(/WITH CHECK/g)).toHaveLength(3);
    expect(TENANT_POLICIES).toHaveLength(39);
    expect(botDialoguesMigration).toContain('DROP TABLE IF EXISTS aeeis_bot_dialogues');
  });
  it.each(['memory', 'file'])('%s: both views keep message/task/run identity and one Run for the same key', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-dialogue-'));
    const f = await dialogueFixture(kind === 'file' ? { file: directory } : {});
    try {
      const [a,b] = await Promise.all([f.ensure(), f.ensure()]); expect(a).toEqual(b);
      const body = { text: '核对公开资料', expectedRevision: a.revision, newTask: { title: '核对公开资料' }, intent: 'execute' };
      const key = randomUUID();
      const first = await f.request(`/rooms/${a.roomId}/dialogue/messages`, body, key);
      expect(first.statusCode, first.body).toBe(202);
      const replay = await f.request(`/conversations/${a.conversationId}/messages`, body, key);
      expect(replay.statusCode, replay.body).toBe(202);
      expect(replay.json().message.id).toBe(first.json().message.id); expect(replay.json().runId).toBe(first.json().runId);
      const home = (await f.request(`/conversations/${a.conversationId}`)).json();
      const studio = (await f.request(`/rooms/${a.roomId}/dialogue`)).json();
      expect(studio.messages).toEqual(home.messages); expect(studio.tasks[0].id).toBe(home.tasks[0].id); expect(studio.tasks[0].runId).toBe(home.tasks[0].runId); expect(studio.tasks[0].column).toBe('ready');
      expect(await f.runs.list(scope)).toHaveLength(1); expect(await f.events.history(a.roomId, scope.owner, scope.tenantId)).toEqual([]);
      await f.engine.advance(first.json().runId);
      const fresh = await f.runs.get(first.json().runId, scope), plan = fresh.plans.at(-1)!;
      const approved = await f.request(`/runs/${fresh.id}/approve`, { planHash: plan.hash, planVersion: plan.version });
      expect(approved.statusCode, approved.body).toBe(200); expect((await f.runs.get(fresh.id, scope)).status).toBe('running');
      expect((await f.request(`/runs/${fresh.id}/approve`, { planHash: plan.hash, planVersion: plan.version }, undefined, 'bob')).statusCode).toBe(404);
      if (kind === 'file') {
        await f.storage.close(); const reopened = new FileBotDialogueStore(join(directory, 'dialogues.json')); await reopened.init();
        expect(await reopened.list(scope)).toMatchObject([{ conversationId: a.conversationId, roomId: a.roomId, phase: 'ready' }]); await reopened.close();
      }
    } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('imports every Room page, aliases oldest first, retains reply/revise/retract and never executes', async () => {
    const f = await dialogueFixture();
    try {
      const first = await f.legacy('第一间', '2026-01-01T00:00:00.000Z'), second = await f.legacy('第二间', '2026-02-01T00:00:00.000Z');
      for (let i=0; i<55; i++) await f.domain.createRoom({ title: `无关频道 ${i}`, description: '群聊' }, undefined, scope.owner, scope.tenantId);
      for (let i=0; i<205; i++) await first.say(`历史 ${i}`);
      const original = await first.say('旧回答', 'canonical_response');
      const revised = await f.events.revise(first.room.id, original.id, { content: '修订回答', idempotencyKey: 'revise' }, scope.owner, scope.tenantId);
      await first.say('追问', 'message', undefined, [original.id]);
      await f.events.retract(first.room.id, revised.id, '撤回', 'retract', scope.owner, scope.tenantId);
      await second.say('第二间历史');
      const canonical = await f.ensure(); expect(canonical.roomId).toBe(first.room.id);
      const a = (await f.request(`/rooms/${first.room.id}/dialogue`)).json(), b = (await f.request(`/rooms/${second.room.id}/dialogue`)).json();
      expect(a.id).toBe(b.id); expect(a.roomId).toBe(b.roomId); expect(a.messages).toEqual(b.messages);
      expect(a.messages.some((m: any) => m.text === '旧回答' || m.text === '修订回答')).toBe(false);
      const retracted = a.messages.find((m: any) => m.text === '（已撤回）'); expect(retracted).toBeDefined();
      expect(a.messages.find((m: any) => m.text === '追问').replyTo).toBe(retracted.id);
      const earlier = (await f.request(`/conversations/${a.id}?before=${a.messages[0].id}`)).json(); expect(earlier.messages.length).toBeGreaterThan(0);
      const count = (await f.aggregates.get(a.id, scope)).messages.length;
      await f.ensure(); expect((await f.aggregates.get(a.id, scope)).messages).toHaveLength(count);
      expect(await f.runs.list()).toEqual([]); expect(f.calls).toEqual([]);
      expect((await f.request(`/rooms/${second.room.id}/session-events`, { goalId: second.goal.id, type: 'message', content: '旧写入', contextManifestId: second.manifest.id, idempotencyKey: 'blocked' })).statusCode).toBe(409);
      await expect(f.events.create(first.room.id, { type: 'message', content: '后台旧写入', contextManifestId: first.manifest.id, idempotencyKey: 'background' }, scope.owner, scope.tenantId)).rejects.toThrow(/统一/);
      expect((await f.request(`/rooms/${first.room.id}/members`, { principalId: 'bob', role: 'editor' })).statusCode).toBe(409);
    } finally { await f.close(); }
  });
  it('imports task/approval receipts as references and keeps the original task and Run', async () => {
    const f = await dialogueFixture();
    try {
      const home = await f.conversations.create({ agentId: f.bot.id, title: f.bot.name }, scope);
      const sent = await f.conversations.post(home.id, { text: '已有任务', expectedRevision: home.revision, newTask: { title: '已有任务' }, intent: 'execute' }, scope, 'existing-run', true);
      const old = await f.legacy();
      await f.events.create(old.room.id, { goalId: old.goal.id, type: 'task_update', content: '既有任务引用', contextManifestId: old.manifest.id, evidenceRefs: [home.id, sent.message.route.taskIds[0]!, sent.runId!], idempotencyKey: 'old-task-reference' }, scope.owner, scope.tenantId);
      const binding = await f.ensure(); expect(binding.conversationId).toBe(home.id);
      const view = (await f.request(`/rooms/${old.room.id}/dialogue`)).json(); expect(view.tasks).toHaveLength(1); expect(view.tasks[0].runId).toBe(sent.runId);
      const reference = view.messages.find((message: any) => message.source?.referenceOnly);
      expect(reference.source.evidenceRefs).toContain(sent.runId); expect(reference.role).toBe('notification'); expect(await f.runs.list(scope)).toHaveLength(1); expect(f.calls).toEqual([]);
    } finally { await f.close(); }
  });
  it('does not import group, human DM or risky historical audiences; isolates tenant/owner/roles', async () => {
    const f = await dialogueFixture();
    try {
      const shared = await f.domain.createRoom({ title: '群聊', description: '群聊' }, undefined, scope.owner, scope.tenantId);
      await f.domain.addRoomMember(shared.id, f.bot.id, 'agent', scope.owner, scope.tenantId);
      const legacy = await f.legacy();
      await f.domain.addRoomMember(legacy.room.id, 'bob', 'viewer', scope.owner, scope.tenantId);
      await f.domain.revokeRoomMember(legacy.room.id, 'bob', scope.owner, scope.tenantId);
      expect((await f.request(`/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(409);
      expect((await f.storage.list(scope))[0]?.phase).toBe('conflict');
      const inventory = (await f.request('/bot-dialogues')).json(); expect(inventory.items[0].conflictRoomIds).toEqual([legacy.room.id]); expect(inventory.items[0].conflict).toBe('audience'); expect((await f.aggregates.list(scope))[0]?.messages).toEqual([]);
      for (const identity of ['bob','elsewhere','viewer']) expect((await f.request(`/bots/${f.bot.id}/dialogue`, {}, undefined, identity)).statusCode).toBe(identity === 'viewer' ? 403 : 404);
      expect(await f.storage.list({ ...scope, owner: 'bob' })).toEqual([]); expect(await f.storage.list({ ...scope, tenantId: 'team-b' })).toEqual([]);
    } finally { await f.close(); }
  });
  it.each(['preparing', 'imported', 'alias', 'ready'])('recovers a crash at %s without duplicate messages or execution', async point => {
    const f = await dialogueFixture();
    try {
      await (await f.legacy('一', '2026-01-01T00:00:00.000Z')).say('历史一');
      const second = await f.legacy('二', '2026-02-01T00:00:00.000Z'); await second.say('历史二');
      let hit = false;
      const put = f.storage.put.bind(f.storage), op = f.storage.operation.bind(f.storage), alias = f.storage.alias.bind(f.storage);
      if (point === 'preparing' || point === 'ready') vi.spyOn(f.storage, 'put').mockImplementation(async value => { await put(value); if (!hit && value.phase === point) { hit = true; throw new Error('crash'); } });
      if (point === 'imported') vi.spyOn(f.storage, 'operation').mockImplementation(async value => { if (!hit && value.kind === 'import' && value.status === 'completed') { hit = true; throw new Error('crash'); } await op(value); });
      if (point === 'alias') vi.spyOn(f.storage, 'alias').mockImplementation(async value => { await alias(value); if (!hit) { hit = true; throw new Error('crash'); } });
      expect((await f.request(`/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(500); expect(hit).toBe(true);
      vi.restoreAllMocks();
      const binding = await f.ensure(); const view = (await f.request(`/rooms/${second.room.id}/dialogue`)).json();
      expect(view.roomId).toBe(binding.roomId); expect(view.messages.map((m: any) => m.text)).toEqual(['历史一','历史二']); expect(await f.runs.list()).toEqual([]);
    } finally { vi.restoreAllMocks(); await f.close(); }
  });
  it('seals imported text and preserves it across FileConversationStore reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-dialogue-seal-')), previous = contentEncryption();
    configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
    const f = await dialogueFixture({ file: directory });
    try {
      const room = await f.legacy(); await room.say('加密历史正文'); const binding = await f.ensure();
      const raw = await readFile(join(directory, 'conversations', `${binding.conversationId}.json`), 'utf8'); expect(raw).not.toContain('加密历史正文');
      expect((await f.aggregates.get(binding.conversationId, scope)).messages[0]?.text).toBe('加密历史正文');
      await f.aggregates.close();
      const reopened = new FileConversationStore(join(directory, 'conversations')); await reopened.init();
      try { expect((await reopened.get(binding.conversationId, scope)).messages[0]?.text).toBe('加密历史正文'); } finally { await reopened.close(); }
    } finally { await f.close(); configureContentEncryption(previous); await rm(directory, { recursive: true, force: true }); }
  });
  it('resumes File migration checkpoints after closing and reopening every application store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-dialogue-restart-'));
    let f = await dialogueFixture({ file: directory });
    try {
      const old = await f.legacy(); await old.say('重启前历史');
      const operation = f.storage.operation.bind(f.storage); let failed = false;
      const fault = vi.spyOn(f.storage, 'operation').mockImplementation(async value => {
        if (!failed && value.kind === 'import' && value.status === 'completed') { failed = true; throw new Error('crash after message'); }
        await operation(value);
      });
      expect((await f.request(`/bots/${f.bot.id}/dialogue`, {})).statusCode).toBe(500); fault.mockRestore();
      const botId = f.bot.id; await f.close();
      f = await dialogueFixture({ file: directory }); expect(f.bot.id).toBe(botId);
      const binding = await f.ensure(), view = (await f.request(`/rooms/${old.room.id}/dialogue`)).json();
      expect(view.id).toBe(binding.conversationId); expect(view.messages.map((m: any) => m.text)).toEqual(['重启前历史']); expect(await f.runs.list(scope)).toEqual([]);
      expect((await f.storage.operations(scope)).every(op => op.status === 'completed')).toBe(true);
      const body = { text: '重启后执行一次', expectedRevision: view.revision, newTask: { title: '重启后任务' }, intent: 'execute' };
      const first = await f.request(`/rooms/${binding.roomId}/dialogue/messages`, body, 'restart-key'); expect(first.statusCode, first.body).toBe(202);
      await f.close(); f = await dialogueFixture({ file: directory });
      const replay = await f.request(`/conversations/${binding.conversationId}/messages`, body, 'restart-key'); expect(replay.json().runId).toBe(first.json().runId); expect(await f.runs.list(scope)).toHaveLength(1);
    } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('discussion replies share the Conversation; execute and replay never open a second Run or auto-reply', async () => {
    const f = await dialogueFixture({ replies: true });
    try {
      const binding = await f.ensure();
      const body = { text: '讨论一下', expectedRevision: 0, unassigned: true, intent: 'discuss' };
      expect((await f.request(`/rooms/${binding.roomId}/dialogue/messages`, body, 'discussion')).statusCode).toBe(200); await f.app.aeeisBots?.drain();
      const view = (await f.request(`/conversations/${binding.conversationId}`)).json();
      expect(view.messages).toHaveLength(2); expect(view.messages[1].speaker).toEqual({ role: 'agent', id: f.bot.id }); expect(view.messages[1].replyTo).toBe(view.messages[0].id);
      const callCount = f.calls.length; await f.request(`/conversations/${binding.conversationId}/messages`, body, 'discussion'); await f.app.aeeisBots?.drain(); expect(f.calls).toHaveLength(callCount);
      const execute = { text: '请执行', expectedRevision: view.revision, newTask: { title: '执行任务' }, intent: 'execute' };
      await f.request(`/rooms/${binding.roomId}/dialogue/messages`, execute, 'execute'); await f.app.aeeisBots?.drain(); expect(f.calls).toHaveLength(callCount); expect(await f.runs.list(scope)).toHaveLength(1);
    } finally { await f.close(); }
  });
  it('deduplicates channel deliveries by source and saves artifact revisions without replacing Run evidence', async () => {
    const f = await dialogueFixture();
    try {
      const group = await f.domain.createRoom({ title: '频道', description: '群聊' }, undefined, scope.owner, scope.tenantId);
      await f.domain.addRoomMember(group.id, f.bot.id, 'agent', scope.owner, scope.tenantId);
      const goal = await f.domain.createGoal({ title: '频道', roomId: group.id }, undefined, scope.owner, scope.tenantId);
      const manifest = await f.domain.createContextManifest(goal.id, { purpose: '投递', audienceMode: 'room' }, undefined, scope.owner, scope.tenantId);
      const event = await f.events.create(group.id, { type: 'message', content: '请研究', goalId: goal.id, contextManifestId: manifest.id, idempotencyKey: 'source' }, scope.owner, scope.tenantId);
      const path = `/rooms/${group.id}/session-events/${event.id}/deliver`;
      const first = await f.request(path, { botId: f.bot.id, kind: 'handoff' }), second = await f.request(path, { botId: f.bot.id, kind: 'handoff' });
      expect(first.statusCode, first.body).toBe(200); expect(second.statusCode, second.body).toBe(200); expect(first.json().message.id).toBe(second.json().message.id); expect(await f.runs.list()).toEqual([]);
      const binding = await f.ensure();
      const draft = await f.request(`/rooms/${binding.roomId}/dialogue/artifacts`, { expectedRevision: first.json().conversation.revision, title: '草稿', content: '正文' }, 'draft'); expect(draft.statusCode, draft.body).toBe(200);
      const updated = await f.request(`/rooms/${binding.roomId}/dialogue/artifacts`, { expectedRevision: draft.json().revision, artifactId: draft.json().items[0].id, title: '草稿二', content: '新正文' }, 'draft-two'); expect(updated.json().items).toHaveLength(1); expect(updated.json().items[0].content).toBe('新正文');
      expect((await f.request(`/rooms/${binding.roomId}/dialogue/artifacts`, undefined, undefined, 'bob')).statusCode).toBe(404);
    } finally { await f.close(); }
  });
});
