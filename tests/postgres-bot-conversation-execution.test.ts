import { describe, expect, it } from 'vitest';
import { PostgresConversationStore } from '../src/adapters/conversation-store.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ConversationService } from '../src/application/conversation-service.js';
import { ThreadService } from '../src/application/thread-service.js';
import { PostgresOwnedBotStore } from '../src/owned-bots.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const scope = { owner: 'alice', tenantId: 'team-a' };

describe.skipIf(!databaseUrl)('PostgreSQL Bot conversation execution', () => {
  it('resolves scoped profiles and replays the persisted request after profile retirement', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresConversationStore(db.url), bots = new PostgresOwnedBotStore(db.url);
    const reread = new PostgresConversationStore(db.url);
    const runs = new InMemoryRunRepository();
    const engine = new AgentEngine(runs, {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' },
      complete: async () => { throw new Error('Execution preparation must not call the model'); },
    });
    const threads = new ThreadService(runs, engine);
    const service = new ConversationService(store, runs, threads, undefined, undefined, undefined, bots);
    try {
      await Promise.all([store.init(), bots.init(), reread.init()]);
      const bot = await bots.create({ name: '发布', role: '核对发布', background: '服务端背景', autonomy: 'quiet', mark: 'letter', color: '#171717' }, scope);
      const entry = await service.create({ agentId: bot.id }, scope);
      const payload = { text: '核对发布', newTask: { title: '发布任务' }, expectedRevision: 0, intent: 'execute', runOptions: { executionReview: 'required' } };
      // The conversation is owned by this caller; its target Bot belongs to somebody else.
      for (const other of [{ ...scope, owner: 'bob' }, { ...scope, tenantId: 'team-b' }]) {
        const foreign = await service.create({ agentId: bot.id }, other);
        await expect(service.post(foreign.id, payload, other, 'denied', true)).rejects.toThrow('不支持本地执行');
        expect((await reread.get(foreign.id, other)).messages).toEqual([]);
      }
      const started = await service.post(entry.id, payload, scope, 'postgres-bot-run', true);
      const saved = await reread.get(entry.id, scope);
      expect(saved.messages[0]!.execution?.request.materials).toEqual([
        expect.objectContaining({ source: `owned-bot:${bot.id}/profile`, content: JSON.stringify({ name: bot.name, role: bot.role, background: bot.background }) }),
      ]);
      expect((await runs.get(started.runId!)).context.sources[0]).toMatchObject({ untrusted: true });
      await bots.remove(bot.id, scope);
      const restarted = new ConversationService(reread, runs, threads, undefined, undefined, undefined, bots);
      const replay = await restarted.post(entry.id, payload, scope, 'postgres-bot-run', true);
      expect(replay.runId).toBe(started.runId);
      expect(await runs.list()).toHaveLength(1);
      await expect(restarted.post(entry.id, { ...payload, expectedRevision: saved.revision }, scope, 'new-run', true)).rejects.toThrow('不支持本地执行');
      expect((await reread.get(entry.id, scope)).messages).toHaveLength(1);
    } finally {
      await Promise.allSettled([store.close(), bots.close(), reread.close()]);
      await db.close();
    }
  });
});
