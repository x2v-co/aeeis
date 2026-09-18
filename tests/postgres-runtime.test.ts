import { describe, expect, it } from 'vitest';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelOutcomeUnknown, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres Run recovery', () => {
  it.skipIf(!databaseUrl)('executes a pinned model and recovers an unknown call after reconnecting', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url);
    let calls: ModelRequest[] = [];
    let loseResponse = true;
    const model: ModelAdapter = {
      pin: { model: 'postgres-fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1', provider: 'catalog-provider' },
      complete: async request => {
        calls.push(request);
        if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Verify persistence', nodes: [{ id: 'draft', title: 'Draft', instruction: 'Write the result', dependsOn: [] }] } };
        if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Reviewed', issues: [] } };
        if (loseResponse) { loseResponse = false; throw new ModelOutcomeUnknown('Provider response lost'); }
        return { value: { type: 'finish', title: 'Result', content: 'Durable result', evidenceRefs: [] } };
      },
    };
    try {
      await first.init();
      const engine = new AgentEngine(first, model);
      const run = await engine.create({ goal: 'Recover a real PostgreSQL Run', maxModelCalls: 3 });
      expect(await engine.advance(run.id), JSON.stringify(await first.get(run.id))).toBe('needs_approval');
      await engine.command(run.id, 'approve', { planHash: (await first.get(run.id)).plans[0]!.hash });
      expect(await engine.advance(run.id)).toBe('unknown');
      const unknown = (await first.get(run.id)).calls.at(-1)!;
      await first.close();
      await second.init();
      const recovered = new AgentEngine(second, model);
      await recovered.recover();
      expect(await recovered.advance(run.id)).toBe('unknown');
      expect(calls).toHaveLength(2);
      await recovered.command(run.id, 'reconcile', { reason: 'Provider confirms retry under the original key' });
      expect(await recovered.advance(run.id)).toBe('running');
      expect(calls[1]?.idempotencyKey).toBe(calls[2]?.idempotencyKey);
      expect((await second.get(run.id)).calls.at(-1)?.id).toBe(unknown.id);
      expect(await recovered.advance(run.id)).toBe('reviewing');
      expect(await recovered.advance(run.id)).toBe('succeeded');
      expect((await second.get(run.id)).calls).toHaveLength(3);
      expect((await second.get(run.id)).artifacts).toHaveLength(1);
    } finally { await Promise.allSettled([first.close(), second.close()]); await db.close(); }
  });
});
