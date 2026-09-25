import { describe, expect, it } from 'vitest';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { isolatedPostgres } from './support/postgres.js';
import { runWithSignals } from './support/rsi-proposal.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('PostgreSQL Run change hints', () => {
  it('delivers committed changes across repositories and isolates rollback/unsubscribe', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const writer = new PostgresRunRepository(db.url);
    const reader = new PostgresRunRepository(db.url);
    await writer.init(); await reader.init();
    const run = runWithSignals();
    try {
      const changes: unknown[] = [];
      let resolveChange!: () => void;
      const changed = new Promise<void>(resolve => { resolveChange = resolve; });
      const unsubscribe = await reader.subscribeChanges(change => { changes.push(change); resolveChange(); });
      await writer.create(run);
      await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('notification timeout')), 2000))]);
      expect(changes).toEqual([expect.objectContaining({ runId: run.id, owner: run.owner, tenantId: run.tenantId, lastEventSeq: run.events.at(-1)?.seq })]);

      await expect(writer.mutate(run.id, () => { throw new Error('rollback'); })).rejects.toThrow('rollback');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(changes).toHaveLength(1);

      await unsubscribe();
      await writer.mutate(run.id, current => { current.status = 'paused'; });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(changes).toHaveLength(1);
    } finally {
      await reader.close(); await writer.close(); await db.close();
    }
  });
});
