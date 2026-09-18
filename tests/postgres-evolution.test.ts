import { describe, expect, it } from 'vitest';
import { PostgresEvolutionRepository, RsiService } from '../src/rsi.js';
import { PostgresEvolutionActivationStore } from '../src/evolution-activation.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres RSI persistence', () => {
  it.skipIf(!databaseUrl)('serializes candidate lifecycle and activation pointers across repository instances', async () => {
    const first = new PostgresEvolutionRepository(databaseUrl!);
    const second = new PostgresEvolutionRepository(databaseUrl!);
    const activation = new PostgresEvolutionActivationStore(databaseUrl!);
    await first.init(); await second.init(); await activation.init();
    try {
      const service = new RsiService(first, activation);
      const candidate = await service.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/postgres-1', change: 'Cite evidence', sourceReceiptRefs: ['receipt.pg.1'], reason: 'Postgres persistence', risk: 'low' });
      await Promise.all((['replay', 'holdout', 'safety'] as const).map(kind => new RsiService(second).evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: [`eval.${kind}`] })));
      await service.approve(candidate.id, 'approval.pg.1'); await service.promote(candidate.id); await service.activate(candidate.id, 'activation.pg.1');
      const restored = new RsiService(second, activation);
      expect((await restored.get(candidate.id)).status).toBe('promoted');
      expect((await restored.listActive())[0]).toMatchObject({ candidateId: candidate.id, version: 'prompt/postgres-1' });
    } finally { await activation.close(); await first.close(); await second.close(); }
  });
});
