import { describe, expect, it } from 'vitest';
import { PostgresConversationThreadIndex } from '../src/adapters/conversation-thread-index.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'team-a' };

describe('Postgres conversation thread index', () => {
  it.skipIf(!databaseUrl)('links once, keeps the last notice per owner, and remembers the one-time fill', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresConversationThreadIndex(db.url), second = new PostgresConversationThreadIndex(db.url);
    try {
      await Promise.all([first.init(), second.init()]); await first.init();
      const entry = { threadId: 'thread_1', conversationId: 'conversation_1', taskId: 'task_1', ...scope };
      const linked = await Promise.all([first.link(entry), second.link({ ...entry, conversationId: 'conversation_2' })]);
      expect(linked.filter(Boolean)).toHaveLength(1);
      const link = await second.get('thread_1', scope);
      expect(link?.notified).toBeUndefined();
      expect(await first.get('thread_1', { owner: 'bob', tenantId: 'team-a' })).toBeUndefined();
      expect(await first.get('thread_1', { owner: 'alice', tenantId: 'team-b' })).toBeUndefined();
      await first.markNotified('thread_1', { owner: 'bob', tenantId: 'team-a' }, { runId: 'run_x', key: 'k0' });
      expect((await second.get('thread_1', scope))?.notified).toBeUndefined();
      await first.markNotified('thread_1', scope, { runId: 'run_1', key: 'k1' });
      expect((await second.get('thread_1', scope))?.notified).toEqual({ runId: 'run_1', key: 'k1' });
      expect(await second.link({ threadId: 'thread_2', conversationId: 'conversation_1', taskId: 'task_2', ...scope }, { runId: 'run_2', key: 'k2' })).toBe(true);
      expect((await first.get('thread_2', scope))?.notified).toEqual({ runId: 'run_2', key: 'k2' });
      expect(await first.seeded()).toBe(false);
      await Promise.all([first.markSeeded(), second.markSeeded()]);
      expect(await second.seeded()).toBe(true);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
