import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ThreadService } from '../src/application/thread-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { followupHash } from '../src/runtime/thread-followups.js';
import { isolatedPostgres } from './support/postgres.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';
import { followupModel, threadFollowupContract } from './support/thread-followup-contract.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
threadFollowupContract('PostgreSQL follow-up reservations', async () => {
  const db = await isolatedPostgres(databaseUrl!);
  const repository = new PostgresRunRepository(db.url); await repository.init();
  return { repository, async close() { await repository.close(); await db.close(); } };
}, !databaseUrl);

describe.skipIf(!databaseUrl)('cross-process follow-up reservations', () => {
  it('serializes two API adapters without holding transactions across connector calls', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url), pool = new pg.Pool({ connectionString: db.url });
    try {
      await Promise.all([first.init(), second.init()]);
      const thread = threadRecord(), parent = threadRun(); await first.create(parent); await first.createThread(thread, parent.id);
      const search = vi.fn(async () => {
        const locks = await pool.query(`SELECT a.state,a.xact_start FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
          WHERE l.locktype='advisory' AND l.granted AND a.datname=current_database()`);
        expect(locks.rows.length).toBeGreaterThan(0);
        // A holder may briefly run another statement (state 'active'); the invariant is that no
        // transaction stays open across the connector call.
        for (const row of locks.rows) expect(row.state).not.toMatch(/^idle in transaction/);
        return [];
      });
      const services = [first, second].map(repository => new ThreadService(repository, new AgentEngine(repository, { model: followupModel(), knowledge: { search } })));
      const input = { request: { goal: 'next', knowledgeQuery: 'evidence' }, idempotencyKey: 'parallel-api' };
      const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => services[index % 2]!.followUp(thread.id, input, threadScope)));
      expect(new Set(replies.map(run => run.id)).size).toBe(1); expect(search).toHaveBeenCalledOnce();
      const row = (await pool.query('SELECT f.state AS reservation,r.thread_id,r.parent_run_id,r.thread_sequence,r.state FROM aeeis_thread_followups f JOIN aeeis_runs r ON r.id=f.run_id WHERE f.thread_id=$1', [thread.id])).rows[0];
      expect(row.reservation).toBe('completed'); expect(row.thread_sequence).toBe(2);
      expect(row.state.threadId).toBe(row.thread_id); expect(row.state.parentRunId).toBe(row.parent_run_id);
      await expect(services[1]!.followUp(thread.id, { ...input, request: { goal: 'different' } }, threadScope)).rejects.toThrow('different input');
      expect(await second.listRunsByThread(thread.id)).toHaveLength(2);
    } finally { await Promise.allSettled([first.close(), second.close(), pool.end()]); await db.close(); }
  });
  it('rolls back membership and reservation completion together and recovers through a fresh adapter', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const first = new PostgresRunRepository(db.url), second = new PostgresRunRepository(db.url);
    try {
      await first.init();
      const thread = threadRecord(), parent = threadRun(); await first.create(parent); await first.createThread(thread, parent.id);
      const service = new ThreadService(first, new AgentEngine(first, followupModel()));
      const input = { request: { goal: 'next' }, idempotencyKey: 'transaction-recovery' };
      const writer = first as unknown as { insertEvents(...args: any[]): Promise<void> };
      const fail = vi.spyOn(writer, 'insertEvents').mockRejectedValueOnce(new Error('abort after run INSERT'));
      await expect(service.followUp(thread.id, input, threadScope)).rejects.toThrow('abort after run INSERT');
      fail.mockRestore();
      const reservation = (await first.getThreadFollowup(thread.id, followupHash(input.idempotencyKey), threadScope))!;
      expect(reservation.state).toBe('reserved'); expect(await first.listRunsByThread(thread.id)).toHaveLength(1);
      await first.close(); await second.init();
      const engine = new AgentEngine(second, followupModel()), create = vi.spyOn(engine, 'create'), recovered = new ThreadService(second, engine);
      await recovered.recover();
      const run = await recovered.followUp(thread.id, input, threadScope);
      expect(run.id).toBe(reservation.runId); expect(run.threadSequence).toBe(2); expect(create).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await Promise.allSettled([first.close(), second.close()]); await db.close(); }
  });
});
