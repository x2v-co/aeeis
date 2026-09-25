import { describe, expect, it } from 'vitest';
import { PostgresKnowledgeProvider, makeKnowledgeRecord } from '../src/knowledge.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres Knowledge Provider', () => {
  it.skipIf(!databaseUrl)('persists records, filters ACLs and searches after restart', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresKnowledgeProvider(db.url);
    await first.init();
    const team = makeKnowledgeRecord({ id: 'knowledge.pg.team', title: 'Temporal operations', content: 'Use durable checkpoints for long tasks', source: 'pg-fixture', classification: 'internal', tags: ['temporal', 'workflow'], audiences: ['team-a'], tenantId: 'tenant-a', updatedAt: '2026-09-19T00:00:00.000Z' });
    const publicRecord = makeKnowledgeRecord({ id: 'knowledge.pg.public', title: 'Public workflow', content: 'Workflow evidence is versioned', source: 'pg-fixture', classification: 'public', tags: ['workflow'], updatedAt: '2026-09-19T00:00:01.000Z' });
    try {
      await first.upsertMany([team, publicRecord]);
      await expect(first.upsert({ ...team, contentHash: 'a'.repeat(64) })).rejects.toThrow('content hash');
      expect((await first.search({ query: 'durable checkpoints', maxItems: 5, allowedClassifications: ['internal'], audience: 'team-a', tenantId: 'tenant-a' })).map(hit => hit.record.id)).toEqual(['knowledge.pg.team']);
      expect(await first.search({ query: 'durable checkpoints', maxItems: 5, allowedClassifications: ['internal'], audience: 'team-a', tenantId: 'tenant-b' })).toEqual([]);
    } finally { await first.close(); }

    const second = new PostgresKnowledgeProvider(db.url);
    await second.init();
    try {
      expect((await second.search({ query: 'versioned', maxItems: 5, allowedClassifications: ['public'], audience: 'any-agent' })).map(hit => hit.record.id)).toEqual(['knowledge.pg.public']);
      await second.remove(team.id);
      expect(await second.search({ query: 'checkpoints', maxItems: 5, allowedClassifications: ['internal'], audience: 'team-a', tenantId: 'tenant-a' })).toEqual([]);
    } finally { await second.close(); await db.close(); }
  });
});
