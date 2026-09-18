import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresEvolutionRepository, RsiService } from '../src/rsi.js';
import { PostgresEvolutionActivationStore } from '../src/evolution-activation.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

async function promote(service: RsiService, version: string, baseVersion = 'prompt/1') {
  const candidate = await service.propose({ target: 'prompt', baseVersion, proposedVersion: version, change: `Policy ${version}`, sourceReceiptRefs: ['receipt.pg.1'], reason: 'Postgres persistence', risk: 'low' });
  await Promise.all((['replay', 'holdout', 'safety'] as const).map(kind => service.evaluate(candidate.id, { kind, passed: true, score: 1, evidenceRefs: [`eval.${kind}`] })));
  await service.approve(candidate.id, 'approval.pg.1');
  return service.promote(candidate.id);
}

describe('Postgres RSI persistence', () => {
  it.skipIf(!databaseUrl)('serializes competing activations across connections, restores parents, and persists after reconnect', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresEvolutionRepository(db.url), second = new PostgresEvolutionRepository(db.url);
    const activation = new PostgresEvolutionActivationStore(db.url), otherActivation = new PostgresEvolutionActivationStore(db.url);
    try {
      await first.init(); await second.init(); await activation.init(); await otherActivation.init();
      const service = new RsiService(first, activation), other = new RsiService(second, otherActivation);
      const base = await promote(service, 'prompt/2');
      expect((await other.get(base.id)).evaluations).toHaveLength(3);
      const firstRelease = await service.activate(base.id, 'activation.base');
      expect(await other.activate(base.id, 'activation.duplicate')).toEqual(firstRelease);
      expect(await otherActivation.history()).toHaveLength(1);
      const left = await promote(service, 'prompt/3-left', 'prompt/2');
      const right = await promote(other, 'prompt/3-right', 'prompt/2');
      const results = await Promise.allSettled([service.activate(left.id, 'left'), other.activate(right.id, 'right')]);
      expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(item => item.status === 'rejected')).toHaveLength(1);
      const winner = (await service.listActive())[0]!;
      expect(winner.parentCandidateId).toBe(base.id);
      const before = await otherActivation.history();
      // A failed base-version transaction must not leave a release or receipt.
      const loser = winner.candidateId === left.id ? right : left;
      await expect(other.activate(loser.id, 'stale-base')).rejects.toThrow('base version conflict');
      expect(await otherActivation.history()).toEqual(before);
      await other.rollback(winner.candidateId, 'Regression observed');
      expect(await service.listActive()).toEqual([firstRelease]);
      await service.rollback(winner.candidateId, 'Repeat after response loss');
      expect(await otherActivation.history()).toHaveLength(3);
      await expect(other.activate(winner.candidateId, 'no-resurrection')).rejects.toThrow('promoted');
      // Revoke a predecessor while a child is active: later rollback must skip it.
      const child = await promote(service, 'prompt/4', 'prompt/2');
      await service.activate(child.id, 'child');
      await service.rollback(base.id, 'Baseline supplement revoked');
      expect((await other.listActive())[0]?.candidateId).toBe(child.id);
      await other.rollback(child.id, 'Return to shipped baseline');
      expect(await service.listActive()).toEqual([]);
      const history = await activation.history();
      await first.close(); await activation.close();
      const restoredRepo = new PostgresEvolutionRepository(db.url), restoredActivation = new PostgresEvolutionActivationStore(db.url);
      try {
        await restoredRepo.init(); await restoredActivation.init();
        expect((await restoredRepo.get(base.id)).status).toBe('rolled_back');
        expect(await restoredActivation.history()).toEqual(history);
        expect(await restoredActivation.list()).toEqual([]);
      } finally { await restoredRepo.close(); await restoredActivation.close(); }
    } finally {
      // first/activation may already have closed for the reconnect assertion.
      await Promise.allSettled([first.close(), second.close(), activation.close(), otherActivation.close()]);
      await db.close();
    }
  });

  it.skipIf(!databaseUrl)('rolls back failed activation writes and invalid candidate transitions without partial state', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const repo = new PostgresEvolutionRepository(db.url), activation = new PostgresEvolutionActivationStore(db.url);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await repo.init(); await activation.init();
      const service = new RsiService(repo, activation);
      const candidate = await promote(service, 'prompt/2');
      await inspection.query(`ALTER TABLE aeeis_evolution_activation ADD CONSTRAINT test_fail_activation CHECK (jsonb_array_length(state->'releases') = 0)`);
      await expect(service.activate(candidate.id, 'injected-db-failure')).rejects.toThrow();
      expect(await activation.list()).toEqual([]);
      expect(await activation.history()).toEqual([]);
      await inspection.query('ALTER TABLE aeeis_evolution_activation DROP CONSTRAINT test_fail_activation');
      await service.activate(candidate.id, 'retry-after-db-recovery');
      const before = await repo.get(candidate.id);
      await expect(repo.mutate(candidate.id, current => { current.evaluations.push({ ...current.evaluations[0]!, score: 2 }); return current; })).rejects.toThrow();
      expect(await repo.get(candidate.id)).toEqual(before);
      expect(await activation.history()).toHaveLength(1);
      // Fail the second half of rollback; revocation remains safe and retryable.
      await inspection.query(`ALTER TABLE aeeis_evolution_candidates ADD CONSTRAINT test_fail_rollback CHECK (state->>'status' <> 'rolled_back')`);
      await expect(service.rollback(candidate.id, 'Injected candidate failure')).rejects.toThrow();
      expect(await activation.list()).toEqual([]);
      await expect(service.activate(candidate.id, 'cannot-revive')).rejects.toThrow('Revoked');
      await inspection.query('ALTER TABLE aeeis_evolution_candidates DROP CONSTRAINT test_fail_rollback');
      expect((await service.rollback(candidate.id, 'Retry rollback')).status).toBe('rolled_back');
      expect(await activation.history()).toHaveLength(2);
    } finally { await inspection.end(); await repo.close(); await activation.close(); await db.close(); }
  });
});
