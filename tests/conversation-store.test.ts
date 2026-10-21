import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileConversationStore, InMemoryConversationStore } from '../src/adapters/conversation-store.js';
import type { Conversation, ConversationMessage, ConversationStore, ConversationTask } from '../src/conversations.js';
import { requestSchema } from '../src/runtime/contracts.js';
import { Conflict } from '../src/runtime/engine.js';
import { NotFound } from '../src/runtime/repository.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const at = '2026-01-01T00:00:00.000Z';
const hash = (text = randomUUID()) => createHash('sha256').update(text).digest('hex');
const task = (): ConversationTask => ({ id: `task_${randomUUID()}`, threadId: `thread_${randomUUID()}`, title: 'Task', createdAt: at });
const message = (): ConversationMessage => ({
  id: `message_${randomUUID()}`, keyHash: hash(), requestHash: hash(), role: 'user', text: 'Discuss this', createdAt: at,
  route: { status: 'general', reason: 'unassigned', taskIds: [], candidateTaskIds: [], focusEffect: 'keep' },
});
function conversation(withPending = false): Conversation {
  const value: Conversation = { schemaVersion: 'conversation/1', id: `conv_${randomUUID()}`, ...scope, title: '0', revision: 0,
    createdAt: at, updatedAt: at, recentTaskIds: [], tasks: [], messages: [] };
  if (withPending) {
    value.tasks = [task(), task()];
    const first = message(), second = message();
    first.route = { status: 'routed', reason: 'explicit', taskIds: [value.tasks[0]!.id], candidateTaskIds: [], focusEffect: 'keep' };
    first.execution = { taskId: value.tasks[0]!.id, runId: `run_${randomUUID()}`, request: requestSchema.parse({ goal: 'Work' }), state: 'pending' };
    value.tasks[0]!.pendingMessageId = first.id;
    second.replyTo = first.id;
    value.messages = [first, second];
  }
  return value;
}
async function collect(store: ConversationStore): Promise<Conversation[]> {
  const result: Conversation[] = [];
  for await (const value of store.pending()) result.push(value);
  return result;
}
const factories = {
  memory: async () => ({ store: new InMemoryConversationStore() as ConversationStore, cleanup: async () => {} }),
  file: async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversation-'));
    return { store: new FileConversationStore(directory) as ConversationStore, cleanup: () => rm(directory, { recursive: true, force: true }) };
  },
};
for (const [name, factory] of Object.entries(factories)) describe(`${name} conversation store`, () => {
  async function using(test: (store: ConversationStore) => Promise<void>) {
    const { store, cleanup } = await factory();
    try { await store.init(); await test(store); }
    finally { await store.close(); await cleanup(); }
  }
  it('serializes concurrent changes, increments once and preserves no-op revision', () => using(async store => {
    const value = conversation(); await store.create(value);
    await expect(store.mutate(value.id, scope, () => {})).resolves.toEqual(value);
    const updates = await Promise.all(Array.from({ length: 30 }, () => store.mutate(value.id, scope, draft => { draft.title = String(Number(draft.title) + 1); })));
    expect(new Set(updates.map(item => item.revision)).size).toBe(30);
    const current = await store.get(value.id, scope);
    expect(current.title).toBe('30'); expect(current.revision).toBe(30); expect(current.updatedAt).not.toBe(at);
    expect(current.createdAt).toBe(at);
    await expect(store.mutate(value.id, scope, () => {})).resolves.toEqual(current);
  }));
  it('rejects duplicate IDs and same-key concurrent appends atomically', () => using(async store => {
    const value = conversation();
    const creates = await Promise.allSettled([store.create(value), store.create(value)]);
    expect(creates.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((creates.find(item => item.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
    const first = message(), second = { ...message(), keyHash: first.keyHash };
    const appends = await Promise.allSettled([first, second].map(item => store.mutate(value.id, scope, draft => { draft.messages.push(item); })));
    expect(appends.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const current = await store.get(value.id, scope);
    expect(current.messages).toHaveLength(1); expect(current.revision).toBe(1);
    await expect(store.mutate(value.id, scope, draft => { draft.messages.push({ ...message(), id: current.messages[0]!.id }); })).rejects.toBeInstanceOf(Conflict);
    await expect(store.get(value.id, scope)).resolves.toEqual(current);
  }));
  it('isolates both tenant and owner before reading or running callbacks', () => using(async store => {
    const value = conversation(); await store.create(value);
    for (const other of [{ ...scope, owner: 'bob' }, { ...scope, tenantId: 'team-b' }]) {
      let called = false;
      await expect(store.get(value.id, other)).rejects.toBeInstanceOf(NotFound);
      await expect(store.mutate(value.id, other, () => { called = true; })).rejects.toBeInstanceOf(NotFound);
      expect(called).toBe(false); expect(await store.list(other)).toEqual([]);
      await store.create({ ...conversation(), ...other });
    }
    expect(await store.list(scope)).toEqual([value]);
    await expect(store.get('../../secret', scope)).rejects.toBeInstanceOf(NotFound);
    await expect(store.mutate(`conv_${'-'.repeat(36)}`, scope, () => {})).rejects.toBeInstanceOf(NotFound);
  }));
  it('detaches creates, gets, lists, pending values, returned values and captured drafts', () => using(async store => {
    const original = conversation(true), expected = structuredClone(original);
    const create = store.create(original); original.title = 'caller change'; original.messages[0]!.execution!.request.goal = 'tampered'; await create;
    const first = await store.get(original.id, scope); first.title = 'get edit'; first.messages[0]!.route.taskIds.length = 0;
    const listed = await store.list(scope); listed[0]!.tasks[0]!.title = 'list edit';
    const pending = await collect(store); pending[0]!.messages[0]!.execution!.request.goal = 'pending edit';
    await expect(store.get(original.id, scope)).resolves.toEqual(expected);
    let captured!: Conversation;
    const changed = await store.mutate(original.id, scope, draft => { captured = draft; draft.title = 'saved'; });
    captured.title = 'after commit'; captured.messages[0]!.execution!.request.goal = 'after commit'; changed.messages.length = 0;
    const saved = await store.get(original.id, scope);
    expect(saved.title).toBe('saved'); expect(saved.messages).toHaveLength(2); expect(saved.messages[0]!.execution!.request.goal).toBe('Work');
  }));
  it('rolls back callback failures and rejects accidentally async callbacks', () => using(async store => {
    const value = conversation(); await store.create(value);
    await expect(store.mutate(value.id, scope, draft => { draft.title = 'partial'; throw new Error('aborted'); })).rejects.toThrow('aborted');
    await expect(store.get(value.id, scope)).resolves.toEqual(value);
    await expect(store.mutate(value.id, scope, async draft => { draft.title = 'async partial'; await Promise.resolve(); throw new Error('late failure'); })).rejects.toThrow('synchronous');
    await expect(store.get(value.id, scope)).resolves.toEqual(value);
    expect((await store.mutate(value.id, scope, draft => { draft.title = 'healthy'; })).revision).toBe(1);
  }));
  it('finds only pending executions and allows completion once without reversion', () => using(async store => {
    const value = conversation(true); await store.create(value); await store.create(conversation());
    expect((await collect(store)).map(item => item.id)).toEqual([value.id]);
    const complete = await store.mutate(value.id, scope, draft => {
      draft.messages[0]!.execution!.state = 'completed';
      draft.tasks[0]!.latestRunId = draft.messages[0]!.execution!.runId;
      delete draft.tasks[0]!.pendingMessageId;
    });
    expect(await collect(store)).toEqual([]);
    await expect(store.mutate(value.id, scope, draft => { draft.messages[0]!.execution!.state = 'pending'; })).rejects.toBeInstanceOf(Conflict);
    await expect(store.get(value.id, scope)).resolves.toEqual(complete);
  }));
  it('cancels a pending execution once and then keeps that state terminal', () => using(async store => {
    const value = conversation(true); await store.create(value);
    const cancelled = await store.mutate(value.id, scope, draft => {
      draft.messages[0]!.execution!.state = 'cancelled';
      delete draft.tasks[0]!.pendingMessageId;
    });
    expect(cancelled.messages[0]!.execution!.state).toBe('cancelled');
    expect(await collect(store)).toEqual([]);
    await expect(store.mutate(value.id, scope, draft => { draft.messages[0]!.execution!.state = 'pending'; })).rejects.toBeInstanceOf(Conflict);
    await expect(store.mutate(value.id, scope, draft => { draft.messages[0]!.execution!.state = 'completed'; })).rejects.toBeInstanceOf(Conflict);
    await expect(store.get(value.id, scope)).resolves.toEqual(cancelled);
  }));
  const immutable: [string, (draft: Conversation) => void][] = [
    ['id', v => { v.id = conversation().id; }], ['owner', v => { v.owner = 'bob'; }], ['tenant', v => { v.tenantId = 'other'; }],
    ['createdAt', v => { v.createdAt = '2026-02-01T00:00:00.000Z'; }], ['schema', v => { (v as any).schemaVersion = 'conversation/2'; }],
    ['revision', v => { v.revision++; }], ['updatedAt', v => { v.updatedAt = '2026-02-01T00:00:00.000Z'; }],
    ['task ID', v => { v.tasks[1]!.id = 'changed'; }], ['thread ID', v => { v.tasks[1]!.threadId = task().threadId; }],
    ['task createdAt', v => { v.tasks[1]!.createdAt = '2026-02-01T00:00:00.000Z'; }], ['task title', v => { v.tasks[1]!.title = 'renamed'; }],
    ['task deletion', v => { v.tasks.pop(); }], ['task reorder', v => { v.tasks.reverse(); }],
    ['message deletion', v => { v.messages.pop(); }], ['message reorder', v => { v.messages.reverse(); }],
    ['message ID', v => { v.messages[1]!.id = 'new-id'; }], ['key hash', v => { v.messages[1]!.keyHash = hash(); }],
    ['request hash', v => { v.messages[1]!.requestHash = hash(); }], ['role', v => { v.messages[1]!.role = 'notification'; }],
    ['text', v => { v.messages[1]!.text = 'changed'; }], ['message createdAt', v => { v.messages[1]!.createdAt = '2026-02-01T00:00:00.000Z'; }],
    ['reply', v => { delete v.messages[1]!.replyTo; }], ['route reason', v => { v.messages[0]!.route.reason = 'focus'; }],
    ['route task', v => { v.messages[1]!.route.taskIds = [v.tasks[1]!.id]; }], ['route candidates', v => { v.messages[1]!.route.candidateTaskIds = [v.tasks[1]!.id]; }],
    ['route focus', v => { v.messages[0]!.route.focusEffect = 'switch'; }], ['notification run', v => { v.messages[1]!.notificationRunId = `run_${randomUUID()}`; }],
    ['execution run', v => { v.messages[0]!.execution!.runId = `run_${randomUUID()}`; }],
    ['execution parent', v => { v.messages[0]!.execution!.parentRunId = `run_${randomUUID()}`; }],
    ['execution request', v => { v.messages[0]!.execution!.request.goal = 'changed'; }],
    ['execution task', v => { v.messages[0]!.execution!.taskId = v.tasks[1]!.id; }],
    ['execution deletion', v => { delete v.messages[0]!.execution; delete v.tasks[0]!.pendingMessageId; }],
    ['execution insertion', v => { v.messages[1]!.execution = structuredClone(v.messages[0]!.execution!); v.messages[1]!.route.taskIds = [v.tasks[0]!.id]; }],
  ];
  it.each(immutable)('rejects immutable %s changes atomically', (_name, edit) => using(async store => {
    const value = conversation(true); await store.create(value);
    await expect(store.mutate(value.id, scope, edit)).rejects.toBeInstanceOf(Conflict);
    await expect(store.get(value.id, scope)).resolves.toEqual(value);
  }));
  it('rejects duplicate tasks/threads, dangling references and malformed states on create and mutate', () => using(async store => {
    const edits: ((draft: Conversation) => void)[] = [
      v => { v.tasks.push({ ...task(), id: v.tasks[0]!.id }); },
      v => { v.tasks.push({ ...task(), threadId: v.tasks[0]!.threadId }); },
      v => { v.messages.push({ ...message(), id: v.messages[0]!.id }); },
      v => { v.messages.push({ ...message(), keyHash: v.messages[0]!.keyHash }); },
      v => { v.focusTaskId = 'missing'; }, v => { v.recentTaskIds = ['missing']; },
      v => { v.recentTaskIds = [v.tasks[0]!.id, v.tasks[0]!.id]; },
      v => { const item = message(); item.route.taskIds = ['missing']; v.messages.push(item); },
      v => { const item = message(); item.route.candidateTaskIds = ['missing']; v.messages.push(item); },
      v => { const item = message(); item.replyTo = item.id; v.messages.push(item); },
      v => { v.tasks[1]!.pendingMessageId = v.messages[0]!.id; },
      v => { v.tasks[0]!.pendingMessageId = 'missing'; },
      v => { (v.messages[0]!.execution as any).state = 'cancelled'; },
    ];
    for (const edit of edits) {
      const value = conversation(true), invalid = structuredClone(value); edit(invalid);
      await expect(store.create(invalid)).rejects.toBeInstanceOf(Conflict);
      await store.create(value);
      await expect(store.mutate(value.id, scope, edit)).rejects.toBeInstanceOf(Conflict);
      await expect(store.get(value.id, scope)).resolves.toEqual(value);
    }
  }));
  it('enforces hard bounds at exactly 100 tasks and 1000 messages', () => using(async store => {
    const value = conversation(); value.tasks = Array.from({ length: 100 }, task); value.messages = Array.from({ length: 1000 }, message);
    await store.create(value);
    for (const edit of [(v: Conversation) => { v.tasks.push(task()); }, (v: Conversation) => { v.messages.push(message()); }]) {
      await expect(store.mutate(value.id, scope, edit)).rejects.toBeInstanceOf(Conflict);
      const invalid = { ...structuredClone(value), id: conversation().id }; edit(invalid);
      await expect(store.create(invalid)).rejects.toBeInstanceOf(Conflict);
      await expect(store.get(value.id, scope)).resolves.toEqual(value);
    }
  }));
  it('appends auditable corrections repeatedly without editing their original or prior corrections', () => using(async store => {
    const value = conversation(true); await store.create(value);
    const original = structuredClone(value.messages[1]!);
    const first = { ...message(), correctsMessageId: original.id,
      route: { status: 'routed' as const, reason: 'explicit' as const, taskIds: [value.tasks[0]!.id], candidateTaskIds: [], focusEffect: 'keep' as const } };
    const second = { ...message(), correctsMessageId: original.id, route: { ...first.route, taskIds: [value.tasks[1]!.id] } };
    await store.mutate(value.id, scope, draft => { draft.messages.push(first); });
    const saved = await store.mutate(value.id, scope, draft => { draft.messages.push(second); });
    expect(saved.revision).toBe(2); expect(saved.messages[1]).toEqual(original);
    expect(saved.messages.slice(-2)).toEqual([first, second]);
    await expect(store.mutate(value.id, scope, draft => { delete draft.messages[2]!.correctsMessageId; })).rejects.toBeInstanceOf(Conflict);
    await expect(store.mutate(value.id, scope, draft => { draft.messages[2]!.route.taskIds = [value.tasks[1]!.id]; })).rejects.toBeInstanceOf(Conflict);
    await expect(store.get(value.id, scope)).resolves.toEqual(saved);
  }));
  it('validates correction targets and forbids execution, notification, replies and chains atomically', () => using(async store => {
    const cases: [string, (value: Conversation, correction: ConversationMessage) => void][] = [
      ['missing target', (_v, correction) => { correction.correctsMessageId = 'missing'; }],
      ['self target', (_v, correction) => { correction.correctsMessageId = correction.id; }],
      ['future target', (v, correction) => { const later = message(); v.messages.push(later); correction.correctsMessageId = later.id; }],
      ['executed target', (v, correction) => { correction.correctsMessageId = v.messages[0]!.id; }],
      ['notification target', (v, _correction) => { v.messages[1]!.role = 'notification'; }],
      ['correction chain', (v, correction) => { v.messages.push({ ...correction, id: `message_${randomUUID()}`, keyHash: hash(), correctsMessageId: correction.id }); }],
      ['notification role', (_v, correction) => { correction.role = 'notification'; }],
      ['execution', (v, correction) => { correction.execution = structuredClone(v.messages[0]!.execution!); }],
      ['notification run', (_v, correction) => { correction.notificationRunId = `run_${randomUUID()}`; }],
      ['reply', (v, correction) => { correction.replyTo = v.messages[1]!.id; }],
      ['general route', (_v, correction) => { correction.route.status = 'general'; }],
      ['clarifying route', (_v, correction) => { correction.route.status = 'clarify'; }],
      ['empty task selection', (_v, correction) => { correction.route.taskIds = []; }],
    ];
    for (const [label, invalidate] of cases) {
      const value = conversation(true);
      const appendInvalid = (draft: Conversation) => {
        const correction = { ...message(), correctsMessageId: draft.messages[1]!.id,
          route: { status: 'routed' as const, reason: 'explicit' as const, taskIds: [draft.tasks[0]!.id], candidateTaskIds: [], focusEffect: 'keep' as const } };
        draft.messages.push(correction); invalidate(draft, correction);
      };
      const invalid = structuredClone(value); appendInvalid(invalid);
      await expect(store.create(invalid), label).rejects.toBeInstanceOf(Conflict);
      await store.create(value);
      await expect(store.mutate(value.id, scope, appendInvalid), label).rejects.toBeInstanceOf(Conflict);
      await expect(store.get(value.id, scope), label).resolves.toEqual(value);
    }
  }));
  it('rejects aggregates exceeding 8 MiB without truncation or partial commit', () => using(async store => {
    const value = conversation(); await store.create(value);
    const oversized = message(); oversized.text = '汉'.repeat(3 * 1024 * 1024);
    await expect(store.mutate(value.id, scope, draft => { draft.messages.push(oversized); })).rejects.toThrow('8 MiB');
    await expect(store.get(value.id, scope)).resolves.toEqual(value);
    await expect(store.create({ ...conversation(), messages: [oversized] })).rejects.toThrow('8 MiB');
    expect(await store.list(scope)).toEqual([value]);
  }));
  it('lists all scoped conversations in recent order with deterministic ties', () => using(async store => {
    const values = [conversation(), conversation(), conversation()];
    await Promise.all(values.map(value => store.create(value)));
    const updated = await store.mutate(values[1]!.id, scope, draft => { draft.title = 'recent'; });
    const ordered = await store.list(scope);
    expect(ordered[0]).toEqual(updated);
    expect(ordered.slice(1).map(item => item.id)).toEqual([values[0]!.id, values[2]!.id].sort());
  }));
});

describe('file conversation lifecycle', () => {
  it('preserves data and revision across close/restart and leaves no temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversation-restart-'));
    const first = new FileConversationStore(directory), second = new FileConversationStore(directory);
    try {
      await first.init(); const value = conversation(true); await first.create(value);
      const saved = await first.mutate(value.id, scope, draft => { draft.title = 'persisted'; });
      await first.close(); await first.close(); await second.init();
      await expect(second.get(value.id, scope)).resolves.toEqual(saved);
      expect(await collect(second)).toEqual([saved]);
      expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
      const persisted = JSON.parse(await readFile(join(directory, `${value.id}.json`), 'utf8'));
      expect(persisted).toEqual(saved);
    } finally { await Promise.all([first.close(), second.close()]); await rm(directory, { recursive: true, force: true }); }
  });
  it('admits one concurrent independent writer and a failed contender cannot release its lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversation-lock-'));
    const stores = [new FileConversationStore(directory), new FileConversationStore(directory)];
    const contender = new FileConversationStore(directory), replacement = new FileConversationStore(directory);
    try {
      const results = await Promise.allSettled(stores.map(store => store.init()));
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      const winner = stores[results.findIndex(item => item.status === 'fulfilled')]!;
      const loser = stores[results.findIndex(item => item.status === 'rejected')]!;
      await loser.close(); await expect(contender.init()).rejects.toThrow('writer lock'); await contender.close();
      await winner.create(conversation()); await winner.close();
      await replacement.init(); expect(await replacement.list(scope)).toHaveLength(1);
    } finally { await Promise.all([...stores, contender, replacement].map(store => store.close())); await rm(directory, { recursive: true, force: true }); }
  });
  it('releases its own writer lock on init failure, without replacing corrupt data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversation-corrupt-'));
    const first = new FileConversationStore(directory), second = new FileConversationStore(directory);
    const value = conversation(), path = join(directory, `${value.id}.json`);
    try {
      await writeFile(path, '{broken'); await expect(first.init()).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('{broken'); expect(await readdir(directory)).not.toContain('.conversations.writer.lock');
      await unlink(path); await second.init(); await first.close();
      const contender = new FileConversationStore(directory);
      await expect(contender.init()).rejects.toThrow('writer lock'); await contender.close();
      await second.create(value);
    } finally { await Promise.all([first.close(), second.close()]); await rm(directory, { recursive: true, force: true }); }
  });
  it('reclaims a writer lock only when its recorded process is gone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversation-deadlock-'));
    const lock = join(directory, '.conversations.writer.lock');
    const stores: FileConversationStore[] = [];
    try {
      await writeFile(lock, `2147483647:${randomUUID()}`);
      const reclaimed = new FileConversationStore(directory); stores.push(reclaimed);
      await reclaimed.init();
      await reclaimed.create(conversation());
      await reclaimed.close();
      await writeFile(lock, `${process.pid}:other`);
      const live = new FileConversationStore(directory); stores.push(live);
      await expect(live.init()).rejects.toThrow('writer lock');
      await live.close();
      expect(await readFile(lock, 'utf8')).toBe(`${process.pid}:other`);
      await writeFile(lock, 'not-a-pid');
      const invalid = new FileConversationStore(directory); stores.push(invalid);
      await expect(invalid.init()).rejects.toThrow('Invalid conversation writer lock');
      await invalid.close();
      expect(await readFile(lock, 'utf8')).toBe('not-a-pid');
    } finally { await Promise.all(stores.map(store => store.close())); await rm(directory, { recursive: true, force: true }); }
  });
  it('requires initialization and drains queued writes before close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-conversation-close-'));
    const first = new FileConversationStore(directory), second = new FileConversationStore(directory);
    try {
      await expect(first.create(conversation())).rejects.toThrow('not initialized'); await first.init();
      const value = conversation(), write = first.create(value), close = first.close();
      await Promise.all([write, close]); await expect(first.create(conversation())).rejects.toThrow('closed');
      await second.init(); await expect(second.get(value.id, scope)).resolves.toEqual(value);
    } finally { await Promise.all([first.close(), second.close()]); await rm(directory, { recursive: true, force: true }); }
  });
});
