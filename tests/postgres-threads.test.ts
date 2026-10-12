import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { newRunShare, runSharesMigration } from '../src/runtime/run-shares.js';
import { threadsMigration } from '../src/runtime/threads.js';
import { isolatedPostgres } from './support/postgres.js';
import { threadContract, threadRecord, threadRun, threadScope } from './support/thread-contract.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
threadContract('PostgreSQL threads', async () => {
  const db = await isolatedPostgres(databaseUrl!);
  const repository = new PostgresRunRepository(db.url); await repository.init();
  return { repository, async close() { await repository.close(); await db.close(); } };
}, !databaseUrl);

describe.skipIf(!databaseUrl)('PostgreSQL thread migration and cross-process attachment', () => {
  it('migrates old rows/shares without rewriting them and permits repeated concurrent bootstrap', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const pool = new pg.Pool({ connectionString: db.url });
    const first = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url);
    try {
      await pool.query('CREATE TABLE aeeis_runs(id text PRIMARY KEY, revision integer NOT NULL, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
      const legacy = threadRun(); delete legacy.tenantId;
      await pool.query('INSERT INTO aeeis_runs(id,revision,state,updated_at) VALUES($1,$2,$3,$4)', [legacy.id, legacy.revision, legacy, legacy.updatedAt]);
      await pool.query(runSharesMigration);
      const { share } = newRunShare(legacy.id, 60);
      await pool.query('INSERT INTO aeeis_run_shares(id,token_hash,run_id,expires_at,revoked_at,created_at) VALUES($1,$2,$3,$4,$5,$6)', [share.id, share.tokenHash, share.runId, share.expiresAt, share.revokedAt, share.createdAt]);
      await Promise.all([first.init(), second.init()]); await first.init();
      await pool.query(threadsMigration); await pool.query(threadsMigration);
      expect(await first.get(legacy.id)).toEqual(legacy);
      expect(await second.shares.find(share.tokenHash)).toEqual(share);
      const row = (await pool.query('SELECT thread_id,parent_run_id,thread_sequence,revision FROM aeeis_runs WHERE id=$1', [legacy.id])).rows[0];
      expect(row).toEqual({ thread_id: null, parent_run_id: null, thread_sequence: null, revision: legacy.revision });
      expect((await pool.query('SELECT count(*)::int AS count FROM aeeis_threads')).rows[0].count).toBe(0);
    } finally { await Promise.allSettled([first.close(), second.close(), pool.end()]); await db.close(); }
  });
  it('serializes multiple adapters and commits relational membership together with JSON', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url);
    const pool = new pg.Pool({ connectionString: db.url });
    try {
      await Promise.all([first.init(), second.init()]);
      const thread = threadRecord(), root = threadRun(); await first.createThread(thread); await first.create(root);
      await first.attachRunToThread(root.id, thread.id);
      const children = Array.from({ length: 8 }, () => threadRun());
      await Promise.all(children.map(run => first.create(run)));
      const attached = await Promise.all(children.map((run, index) => (index % 2 ? first : second).attachRunToThread(run.id, thread.id, root.id, threadScope)));
      expect(new Set(attached.map(run => run.threadSequence)).size).toBe(8);
      const repeated = await Promise.all([first.attachRunToThread(children[0]!.id, thread.id, root.id), second.attachRunToThread(children[0]!.id, thread.id, root.id)]);
      expect(repeated[0]).toEqual(repeated[1]);
      expect((await second.listRunsByThread(thread.id)).map(run => run.threadSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      await first.mutate(children[0]!.id, run => { run.status = 'paused'; });
      const rows = (await pool.query('SELECT thread_id,parent_run_id,thread_sequence,state FROM aeeis_runs WHERE thread_id=$1 ORDER BY thread_sequence', [thread.id])).rows;
      for (const row of rows) {
        expect(row.state.threadId).toBe(row.thread_id);
        expect(row.state.parentRunId ?? null).toBe(row.parent_run_id);
        expect(row.state.threadSequence).toBe(row.thread_sequence);
      }
      await expect(pool.query('UPDATE aeeis_runs SET thread_sequence=1 WHERE id=$1', [children[0]!.id])).rejects.toMatchObject({ code: '23505' });
      await expect(pool.query('UPDATE aeeis_runs SET thread_sequence=0 WHERE id=$1', [children[0]!.id])).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query('UPDATE aeeis_runs SET parent_run_id=id WHERE id=$1', [children[0]!.id])).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query('DELETE FROM aeeis_threads WHERE id=$1', [thread.id])).rejects.toMatchObject({ code: '23503' });
    } finally { await Promise.allSettled([first.close(), second.close(), pool.end()]); await db.close(); }
  });
});
