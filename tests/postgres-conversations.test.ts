import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresConversationStore } from '../src/adapters/conversation-store.js';
import type { Conversation, ConversationMessage } from '../src/conversations.js';
import { requestSchema } from '../src/runtime/contracts.js';
import { Conflict } from '../src/runtime/engine.js';
import { NotFound } from '../src/runtime/repository.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'tenant-a' };
const at = '2026-01-01T00:00:00.000Z';
const hash = () => createHash('sha256').update(randomUUID()).digest('hex');
function message(): ConversationMessage {
  return { id: `message_${randomUUID()}`, keyHash: hash(), requestHash: hash(), role: 'user', text: 'Discuss', createdAt: at,
    route: { status: 'general', reason: 'unassigned', taskIds: [], candidateTaskIds: [], focusEffect: 'keep' } };
}
function conversation(pending = false): Conversation {
  const value: Conversation = { schemaVersion: 'conversation/1', id: `conv_${randomUUID()}`, ...scope, title: '0', revision: 0,
    createdAt: at, updatedAt: at, recentTaskIds: [], tasks: [], messages: [] };
  if (pending) {
    const item = message(), taskId = `task_${randomUUID()}`;
    item.route = { status: 'routed', reason: 'explicit', taskIds: [taskId], candidateTaskIds: [], focusEffect: 'keep' };
    item.execution = { taskId, runId: `run_${randomUUID()}`, request: requestSchema.parse({ goal: 'Execute' }), state: 'pending' };
    value.messages.push(item);
    value.tasks.push({ id: taskId, threadId: `thread_${randomUUID()}`, title: 'Task', createdAt: at, pendingMessageId: item.id });
  }
  return value;
}

describe.skipIf(!databaseUrl)('PostgreSQL conversation store', () => {
  async function using(test: (first: PostgresConversationStore, second: PostgresConversationStore, pool: pg.Pool) => Promise<void>) {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresConversationStore(db.url), second = new PostgresConversationStore(db.url);
    const pool = new pg.Pool({ connectionString: db.url });
    try { await Promise.all([first.init(), second.init()]); await test(first, second, pool); }
    finally { await Promise.allSettled([first.close(), second.close(), pool.end()]); await db.close(); }
  }
  it('serializes independent pools with row locks, exact revisions, and durable rereads', () => using(async (first, second, pool) => {
    const value = conversation(true); await first.create(value);
    const changes = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).mutate(value.id, scope, draft => { draft.title = String(Number(draft.title) + 1); })));
    expect(new Set(changes.map(item => item.revision)).size).toBe(40);
    const saved = await second.get(value.id, scope);
    expect(saved.title).toBe('40'); expect(saved.revision).toBe(40); expect(saved.tasks[0]!.createdAt).toBe(at);
    await expect(first.mutate(value.id, scope, () => {})).resolves.toEqual(saved);
    const row = (await pool.query('SELECT revision,state,owner,tenant_id FROM aeeis_conversations WHERE id=$1', [value.id])).rows[0];
    expect(Number(row.revision)).toBe(40); expect(row.state).toEqual(saved); expect(row.owner).toBe(scope.owner); expect(row.tenant_id).toBe(scope.tenantId);
  }));
  it('rejects racing duplicate creates, same-key appends and duplicate message IDs', () => using(async (first, second) => {
    const value = conversation();
    const creates = await Promise.allSettled([first.create(value), second.create(value)]);
    expect(creates.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect((creates.find(item => item.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(Conflict);
    const a = message(), b = { ...message(), keyHash: a.keyHash };
    const appends = await Promise.allSettled([first.mutate(value.id, scope, draft => { draft.messages.push(a); }), second.mutate(value.id, scope, draft => { draft.messages.push(b); })]);
    expect(appends.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const saved = await first.get(value.id, scope);
    expect(saved.messages).toHaveLength(1); expect(saved.revision).toBe(1);
    await expect(second.mutate(value.id, scope, draft => { draft.messages.push({ ...message(), id: saved.messages[0]!.id }); })).rejects.toBeInstanceOf(Conflict);
    await expect(second.get(value.id, scope)).resolves.toEqual(saved);
  }));
  it('applies scope predicates before mutation and returns independent copies', () => using(async (first, second) => {
    const value = conversation(true); await first.create(value);
    for (const other of [{ ...scope, owner: 'bob' }, { ...scope, tenantId: 'tenant-b' }]) {
      let called = false;
      await expect(second.get(value.id, other)).rejects.toBeInstanceOf(NotFound);
      await expect(second.mutate(value.id, other, () => { called = true; })).rejects.toBeInstanceOf(NotFound);
      expect(called).toBe(false); expect(await second.list(other)).toEqual([]);
    }
    const saved = await first.get(value.id, scope); saved.messages[0]!.route.taskIds.length = 0;
    const listed = await second.list(scope); listed[0]!.tasks.length = 0;
    await expect(second.get(value.id, scope)).resolves.toEqual(value);
  }));
  it('rolls back callback, immutable-route and SQL failures and releases transactions', () => using(async (first, second, pool) => {
    const value = conversation(true); await first.create(value);
    await expect(first.mutate(value.id, scope, draft => { draft.title = 'partial'; throw new Error('callback abort'); })).rejects.toThrow('callback abort');
    await expect(first.mutate(value.id, scope, draft => { draft.messages[0]!.route.reason = 'focus'; })).rejects.toBeInstanceOf(Conflict);
    await expect(first.mutate(value.id, scope, async draft => { draft.title = 'async'; })).rejects.toThrow('synchronous');
    await pool.query(`CREATE FUNCTION reject_conversation_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced update failure'; END $$;
      CREATE TRIGGER reject_conversation_update BEFORE UPDATE ON aeeis_conversations FOR EACH ROW EXECUTE FUNCTION reject_conversation_update()`);
    await expect(first.mutate(value.id, scope, draft => { draft.title = 'not saved'; })).rejects.toThrow('forced update failure');
    await expect(second.get(value.id, scope)).resolves.toEqual(value);
    await pool.query('DROP TRIGGER reject_conversation_update ON aeeis_conversations');
    expect((await second.mutate(value.id, scope, draft => { draft.title = 'healthy'; })).revision).toBe(1);
  }));
  it('keyset-pages scoped lists and pending scans past 100 without duplicates', () => using(async (first, second) => {
    const values = Array.from({ length: 205 }, () => conversation(true));
    const other = { ...conversation(), owner: 'bob' };
    await Promise.all([...values, conversation(), other].map(value => first.create(value)));
    const listed = await second.list(scope);
    expect(listed).toHaveLength(206); expect(new Set(listed.map(value => value.id)).size).toBe(206);
    expect(listed.map(value => value.id)).not.toContain(other.id);
    const pending: Conversation[] = [];
    for await (const value of second.pending()) {
      pending.push(value);
      // Complete each returned row during the scan: offset pagination would
      // skip later rows when the matching result set shrinks.
      await first.mutate(value.id, scope, draft => { draft.messages[0]!.execution!.state = 'completed'; delete draft.tasks[0]!.pendingMessageId; });
    }
    expect(pending).toHaveLength(205); expect(new Set(pending.map(value => value.id)).size).toBe(205);
    const remaining = []; for await (const value of first.pending()) remaining.push(value);
    expect(remaining).toEqual([]);
    await expect(first.mutate(values[0]!.id, scope, draft => { draft.messages[0]!.execution!.state = 'pending'; })).rejects.toBeInstanceOf(Conflict);
  }));
  it('rejects bounds and immutable execution changes without persisting partial state', () => using(async (first, second) => {
    const value = conversation(true); await first.create(value);
    await expect(first.mutate(value.id, scope, draft => { draft.messages.push(...Array.from({ length: 1000 }, message)); })).rejects.toBeInstanceOf(Conflict);
    await expect(first.mutate(value.id, scope, draft => { draft.messages[0]!.execution!.request.goal = 'changed'; })).rejects.toBeInstanceOf(Conflict);
    await expect(first.mutate(value.id, scope, draft => { draft.tasks[0]!.threadId = `thread_${randomUUID()}`; })).rejects.toBeInstanceOf(Conflict);
    await expect(second.get(value.id, scope)).resolves.toEqual(value);
  }));
});
