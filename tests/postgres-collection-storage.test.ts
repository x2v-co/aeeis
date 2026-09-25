import { PostgresProjectionOutbox } from '../src/collaboration-projection.js';
import { PostgresCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { PostgresAgentDirectory } from '../src/adapters/postgres-agent-registry.js';
import { PostgresRoomMembershipRepository } from '../src/room-membership.js';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresEvolutionRepository } from '../src/rsi.js';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { PostgresCollaborationRepository } from '../src/collaboration-service.js';
import { isolatedPostgres } from './support/postgres.js';
import { collectionOwner, runCollectionContract, goalCollectionContract, collaborationCollectionContract, evolutionCollectionContract, roomCollectionContract, registryCollectionContract, triggerCollectionContract, projectionCollectionContract } from './support/collection-contract.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
describe('PostgreSQL bounded collection reads', () => {
  it.skipIf(!databaseUrl)('bounds trigger/projection SQL reads while retaining pending delivery selection', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresCollaborationTriggerStore(db.url);
    const outbox = new PostgresProjectionOutbox(db.url);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await store.init(); await outbox.init();
      await triggerCollectionContract(store);
      await projectionCollectionContract(outbox);
      await inspection.query("UPDATE aeeis_collaboration_trigger_policies SET state='{}' WHERE id='policy.3'");
      await inspection.query("UPDATE aeeis_collaboration_trigger_decisions SET state='{}' WHERE id='decision.1'");
      expect(await store.listPolicies(collectionOwner, 1)).toHaveLength(1);
      expect(await store.listDecisions(collectionOwner, 'policy.0', 1)).toHaveLength(1);
      await expect(store.listPolicies(collectionOwner)).rejects.toThrow();
      await expect(store.listDecisions(collectionOwner)).rejects.toThrow();
      await inspection.query("UPDATE aeeis_projection_events SET state='{}' WHERE status='unknown'");
      expect((await outbox.deliverPending({ deliver: async () => ({}) }, 1, collectionOwner)).events).toEqual([]);
      expect(await outbox.list('delivered', collectionOwner, 1)).toHaveLength(1);
      await expect(outbox.list(undefined, collectionOwner)).rejects.toThrow();
    } finally { await Promise.allSettled([store.close(), outbox.close(), inspection.end()]); await db.close(); }
  });

  it.skipIf(!databaseUrl)('filters Room memberships and bounds registry JSON projection in SQL', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresAeeisStore(db.url);
    const memberships = new PostgresRoomMembershipRepository(db.url);
    const directory = new PostgresAgentDirectory(db.url);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await store.init(); await memberships.init(); await directory.init();
      await roomCollectionContract(store, memberships);
      await registryCollectionContract(directory);
      // Audit history and records outside the selected window are not parsed.
      // Registry entries are normalized; corrupt the third row so a bounded
      // first page remains readable while an unbounded read detects it.
      await inspection.query(`UPDATE aeeis_agent_registry_entries SET card='{}'::jsonb WHERE position=2`);
      expect(await directory.entriesSnapshot(2)).toHaveLength(2);
      await expect(directory.entriesSnapshot()).rejects.toThrow();
    } finally { await Promise.allSettled([store.close(), memberships.close(), directory.close(), inspection.end()]); await db.close(); }
  });

  it.skipIf(!databaseUrl)('bounds RSI reads and migrates legacy change time without losing chronology', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const repository = new PostgresEvolutionRepository(db.url);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await repository.init();
      const { newestId, seed } = await evolutionCollectionContract(repository);
      const legacy = { ...seed, id: 'evo_ffffffff-ffff-4fff-8fff-ffffffffffff', ...collectionOwner, createdAt: '2000-01-01T00:00:00.000Z' };
      delete legacy.updatedAt;
      // A timestamptz fixture must define its instant independently of the
      // server timezone; migration preserves that instant rather than dates.
      await inspection.query("INSERT INTO aeeis_evolution_candidates(id,state,updated_at) VALUES($1,$2,'2021-01-01T00:00:00Z')", [legacy.id, legacy]);
      await repository.init();
      expect((await repository.get(legacy.id)).updatedAt).toBe('2021-01-01T00:00:00.000Z');
      expect((await repository.list(collectionOwner, 2)).map(candidate => candidate.id)).toEqual([newestId, legacy.id]);
      await repository.init();
      expect((await repository.list(collectionOwner, 2)).map(candidate => candidate.id)).toEqual([newestId, legacy.id]);
      // No parsing of rows outside the selected scope/window in application.
      await inspection.query("INSERT INTO aeeis_evolution_candidates(id,state,updated_at) VALUES('bad-other', '{\"owner\":\"bob\",\"tenantId\":\"team-a\"}', '2099-01-01'), ('bad-old', '{\"owner\":\"alice\",\"tenantId\":\"team-a\"}', '1990-01-01')");
      expect(await repository.list(collectionOwner, 2)).toHaveLength(2);
      await expect(repository.list(collectionOwner)).rejects.toThrow();
    } finally { await repository.close(); await inspection.end(); await db.close(); }
  });

  it.skipIf(!databaseUrl)('filters before LIMIT, orders by canonical timestamps and repairs legacy row timestamps', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const repo = new PostgresRunRepository(db.url);
    const domain = new PostgresAeeisStore(db.url);
    const collaboration = new PostgresCollaborationRepository(db.url);
    const inspection = new pg.Pool({ connectionString: db.url });
    try {
      await repo.init(); await domain.init(); await collaboration.init();
      const latest = await runCollectionContract(repo);
      const template = await repo.get(latest, collectionOwner);
      await repo.create({ ...template, id: 'run_00000000-0000-4000-8000-000000000010', owner: 'bob', tenantId: 'team-a', goalId: 'goal_shared', privacy: 'internal', updatedAt: '2020-02-01T00:00:00.000Z' });
      await repo.create({ ...template, id: 'run_00000000-0000-4000-8000-000000000011', owner: 'bob', tenantId: 'team-a', goalId: 'goal_shared', privacy: 'confidential', updatedAt: '2020-01-31T00:00:00.000Z' });
      const sharedPage = await repo.pageVisible({ owner: 'carol', tenantId: 'team-a' }, ['goal_shared'], 10);
      expect(sharedPage.runs.map(run => run.id)).toEqual(['run_00000000-0000-4000-8000-000000000010']);
      await goalCollectionContract(domain);
      await collaborationCollectionContract(collaboration);
      await inspection.query("UPDATE aeeis_runs SET updated_at='2099-01-01' WHERE id=$1", ['run_00000000-0000-4000-8000-000000000003']);
      await repo.init();
      expect((await repo.list(collectionOwner, 1))[0]?.id).toBe(latest);
      // Verify storage-side pruning: malformed older aggregate must not be
      // transferred to the application's schema parser for a bounded read.
      await inspection.query("INSERT INTO aeeis_competitions(id,owner,tenant_id,state,updated_at) VALUES('invalid-old','alice','team-a','{}','2000-01-01')");
      expect(await collaboration.listCompetitions(collectionOwner, 2)).toHaveLength(2);
      await expect(collaboration.listCompetitions(collectionOwner)).rejects.toThrow();
    } finally {
      await Promise.allSettled([repo.close(), domain.close(), collaboration.close(), inspection.end()]);
      await db.close();
    }
  });
});
