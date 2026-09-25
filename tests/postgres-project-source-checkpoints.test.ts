import { describe, expect, it } from 'vitest';
import { PostgresProjectSourceCheckpointStore } from '../src/adapters/postgres-project-source-checkpoints.js';
import { ProjectSourceCheckpointConflict } from '../src/project-sources.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
const key = { provider: 'fixture', tenantId: 'team-a', query: 'release', maxItems: 8, allowedClassifications: ['public', 'internal'] as ('public' | 'internal')[] };
const receipt = { schemaVersion: 'project-source-sync-receipt/1' as const, provider: 'fixture', requestHash: 'a'.repeat(64), responseHash: 'b'.repeat(64), nextCursor: 'cursor-1', recordCount: 0, changed: true, completedAt: '2026-09-19T00:00:00.000Z' };

describe('Postgres project source checkpoints', () => {
  it.skipIf(!databaseUrl)('persists cursors and enforces compare-and-set across instances', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresProjectSourceCheckpointStore(db.url);
    const second = new PostgresProjectSourceCheckpointStore(db.url);
    await first.init(); await second.init();
    try {
      const saved = await first.save(key, undefined, 'cursor-1', receipt);
      expect(saved.revision).toBe(1);
      await expect(second.save(key, undefined, 'cursor-2', receipt)).rejects.toBeInstanceOf(ProjectSourceCheckpointConflict);
      expect(await second.get(key)).toMatchObject({ revision: 1, cursor: 'cursor-1' });
      const next = await second.save(key, 1, 'cursor-2', { ...receipt, nextCursor: 'cursor-2', changed: true });
      expect(next.revision).toBe(2);
    } finally { await first.close(); await second.close(); await db.close(); }
  });
});
