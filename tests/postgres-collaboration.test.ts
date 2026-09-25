import { describe, expect, it } from 'vitest';
import { PostgresCollaborationRepository, CollaborationNotFound, CollaborationService } from '../src/collaboration-service.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const alice = { owner: 'alice', tenantId: 'tenant-a' };
const bob = { owner: 'bob', tenantId: 'tenant-b' };
const brief = {
  schemaVersion: 'competition-brief/1' as const, taskId: 'task.pg.scope', contextVersion: 'ctx.pg.scope', goal: 'Choose',
  participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true,
};

describe('Postgres collaboration persistence', () => {
  it.skipIf(!databaseUrl)('persists scoped competitions and debates across repository instances', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresCollaborationRepository(db.url);
    const second = new PostgresCollaborationRepository(db.url);
    try {
      await first.init(); await second.init();
      const service = new CollaborationService(first);
      const competition = await service.createCompetition(brief, alice);
      expect((await second.listCompetitions(alice)).map(item => item.id)).toEqual([competition.id]);
      expect(await second.listCompetitions(bob)).toEqual([]);
      await expect(second.getCompetition(competition.id, bob)).rejects.toBeInstanceOf(CollaborationNotFound);
      await service.createDebate({ taskId: 'task.pg.scope', contextVersion: 'ctx.pg.scope', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 }, alice);
      expect(await second.listDebates(alice)).toHaveLength(1);
      expect(await second.listDebates(bob)).toEqual([]);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
