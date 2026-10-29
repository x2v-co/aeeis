import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFound, PostgresRunRepository } from '../src/runtime/repository.js';
import { followupParentHash, ThreadConflict } from '../src/runtime/threads.js';
import { event } from '../src/runtime/engine.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';
import { requestSchema } from '../src/runtime/contracts.js';
import { followupHash, type ThreadFollowup } from '../src/runtime/thread-followups.js';

afterEach(() => { vi.restoreAllMocks(); });

function fixture() {
  const thread = threadRecord(), run = threadRun();
  const threadRow = { id: thread.id, owner: thread.owner, tenant_id: thread.tenantId, title: thread.title, created_at: new Date(thread.createdAt) };
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.startsWith('SELECT * FROM aeeis_threads')) return { rows: [threadRow], rowCount: 1 };
    if (sql.startsWith('SELECT state FROM aeeis_runs')) return { rows: [{ state: structuredClone(run) }], rowCount: 1 };
    if (sql.startsWith('SELECT COALESCE(MAX(thread_sequence)')) return { rows: [{ seq: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const release = vi.fn();
  // The pool stamps the row-level-security scope on each checkout; these tests are about the statements after it.
  const scoped = async (sql: string, values?: unknown[]) => sql.startsWith('SELECT set_config(') ? { rows: [], rowCount: 1 } : query(sql, values);
  const client = { query: scoped, release };
  const pool = { query, connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
  vi.spyOn(pg, 'Pool').mockImplementation(() => pool as unknown as pg.Pool);
  const repository = new PostgresRunRepository('postgres://unused');
  return { repository, query, release, thread, run };
}

describe('PostgreSQL thread transaction boundary', () => {
  function followupFixture() {
    const f = fixture(), child = threadRun();
    f.run.threadId = f.thread.id; f.run.threadSequence = 1;
    const reservation: ThreadFollowup = {
      threadId: f.thread.id, keyHash: followupHash('key'), requestHash: followupHash('request'), runId: child.id, state: 'reserved',
      request: { request: requestSchema.parse({ goal: child.goal }), contextBudgetBytes: 32768 },
      parentRunId: f.run.id, parentRevision: f.run.revision, contextSnapshot: { parentHistoryHash: followupParentHash(f.run), run: structuredClone(child) }, createdAt: new Date().toISOString(),
    };
    const row = { thread_id: reservation.threadId, key_hash: reservation.keyHash, request_hash: reservation.requestHash, run_id: reservation.runId, state: reservation.state, request: reservation.request, parent_run_id: reservation.parentRunId, parent_revision: reservation.parentRevision, context_snapshot: reservation.contextSnapshot, created_at: new Date(reservation.createdAt) };
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith('SELECT * FROM aeeis_thread_followups')) return { rows: [structuredClone(row)], rowCount: 1 };
      if (sql.startsWith('SELECT COALESCE(MAX(thread_sequence)')) return { rows: [{ seq: 1 }], rowCount: 1 };
      return query(sql, values);
    });
    return { ...f, child, reservation };
  }
  it('commits follow-up membership and reservation completion before publishing dispatch hints', async () => {
    const { repository, query, thread, run, child, reservation } = followupFixture();
    const result = await repository.createRunInThread(child, thread.id, run.id, threadScope, run.revision, reservation);
    expect(result).toMatchObject({ id: child.id, threadId: thread.id, parentRunId: run.id, threadSequence: 2 });
    const statements = query.mock.calls.map(([sql]) => sql);
    const insert = statements.findIndex(sql => sql.startsWith('INSERT INTO aeeis_runs'));
    const complete = statements.findIndex(sql => sql.startsWith('UPDATE aeeis_thread_followups'));
    expect(statements.slice(0, 3)).toEqual(['BEGIN', expect.stringContaining('aeeis_threads WHERE id=$1 FOR UPDATE'), expect.stringContaining('aeeis_thread_followups WHERE thread_id=$1 AND key_hash=$2 FOR UPDATE')]);
    expect(insert).toBeLessThan(complete); expect(complete).toBeLessThan(statements.indexOf('COMMIT'));
    expect(statements.indexOf('COMMIT')).toBeLessThan(statements.findIndex(sql => sql.includes('pg_notify')));
    await repository.close();
  });
  it('rolls back a follow-up event write failure before completing its reservation', async () => {
    const { repository, query, thread, run, child, reservation } = followupFixture();
    const implementation = query.getMockImplementation()!;
    query.mockImplementation(async (sql, values) => {
      if (sql.startsWith('INSERT INTO aeeis_run_events')) throw new Error('event storage failed');
      return implementation(sql, values);
    });
    await expect(repository.createRunInThread(child, thread.id, run.id, threadScope, run.revision, reservation)).rejects.toThrow('event storage failed');
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('ROLLBACK');
    expect(statements.some(sql => sql === 'COMMIT' || sql.startsWith('UPDATE aeeis_thread_followups') || sql.includes('pg_notify'))).toBe(false);
    await repository.close();
  });
  it.each(['skill.recorded', 'run.cancel.workflow_failed'])('checks the stored parent content hash under lock after %s', async type => {
    const { repository, query, thread, run, child, reservation } = followupFixture();
    if (type === 'skill.recorded') run.skillOutcome = { outcome: 'success', receiptRef: 'receipt.late' };
    event(run, type, { receiptRef: 'receipt.late' }); run.revision++;
    const result = await repository.createRunInThread(child, thread.id, run.id, threadScope, reservation.parentRevision, reservation);
    expect(result.threadSequence).toBe(2);
    expect(query.mock.calls.some(([sql]) => sql.includes('aeeis_runs WHERE id=$1 FOR SHARE'))).toBe(true);
    expect(query.mock.calls.map(([sql]) => sql)).toContain('COMMIT');
    await repository.close();
  });
  it('rejects changed parent content using the stored hash even if the caller supplies a new hash', async () => {
    const { repository, query, thread, run, child, reservation } = followupFixture();
    run.goal = 'changed historical content'; run.revision++;
    await expect(repository.createRunInThread(child, thread.id, run.id, threadScope, followupParentHash(run), reservation)).rejects.toThrow('unchanged since the history snapshot');
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO aeeis_runs') || sql.includes('pg_notify'))).toBe(false);
    await repository.close();
  });
  it('rejects a reservation/run mismatch before publishing any run', async () => {
    const { repository, query, thread, run, child, reservation } = followupFixture();
    child.goal = 'changed after checkpoint';
    await expect(repository.createRunInThread(child, thread.id, run.id, threadScope, run.revision, reservation)).rejects.toThrow('reservation commit');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO aeeis_runs'))).toBe(false);
    await repository.close();
  });
  it('holds a session key lock outside transactions and releases it when preparation throws', async () => {
    const { repository, query, release, thread, reservation } = followupFixture();
    await expect(repository.withThreadFollowupLock(thread.id, reservation.keyHash, threadScope, async () => {
      expect(query.mock.calls.some(([sql]) => sql === 'BEGIN')).toBe(false);
      await repository.getThreadFollowup(thread.id, reservation.keyHash, threadScope);
      throw new Error('provider failed');
    })).rejects.toThrow('provider failed');
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('SELECT pg_advisory_lock(hashtextextended($1,0))');
    expect(statements.at(-1)).toBe('SELECT pg_advisory_unlock(hashtextextended($1,0))');
    expect(release).toHaveBeenCalledWith(true);
    await repository.close();
  });
  it('commits columns and JSON together and publishes the hint after commit', async () => {
    const { repository, query, release, thread, run } = fixture();
    const attached = await repository.attachRunToThread(run.id, thread.id, undefined, threadScope);
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE aeeis_runs'))!;
    expect(update[1]).toEqual([run.id, thread.id, null, 1, run.revision + 1, attached, attached.updatedAt]);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('aeeis_threads WHERE id=$1 FOR UPDATE');
    expect(statements[2]).toContain('aeeis_runs WHERE id=$1 FOR UPDATE');
    expect(statements.indexOf('COMMIT')).toBeLessThan(statements.findIndex(sql => sql.includes('pg_notify')));
    expect(release).toHaveBeenCalledOnce();
    await repository.close();
  });
  it('rolls back write failures without publishing a change', async () => {
    const { repository, query, release, thread, run } = fixture();
    const implementation = query.getMockImplementation()!;
    query.mockImplementation(async (sql, values) => {
      if (sql.startsWith('UPDATE aeeis_runs')) throw new Error('storage failed');
      return implementation(sql, values);
    });
    await expect(repository.attachRunToThread(run.id, thread.id)).rejects.toThrow('storage failed');
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT' || sql.includes('pg_notify'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    await repository.close();
  });
  it('checks thread ownership before reading any run', async () => {
    const { repository, query, release, thread, run } = fixture();
    await expect(repository.attachRunToThread(run.id, thread.id, undefined, { ...threadScope, tenantId: 'other' })).rejects.toThrow(NotFound);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM aeeis_runs'))).toBe(false);
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
    await repository.close();
  });
  it('does not update or notify on an identical root retry', async () => {
    const { repository, query, thread, run } = fixture();
    run.threadId = thread.id; run.threadSequence = 1;
    expect(await repository.attachRunToThread(run.id, thread.id)).toEqual(run);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.includes('pg_notify'))).toBe(false);
    await repository.close();
  });
  it('rolls back generic mutations that change membership', async () => {
    const { repository, query, release, thread, run } = fixture();
    run.threadId = thread.id; run.threadSequence = 1;
    await expect(repository.mutate(run.id, current => { delete current.threadId; })).rejects.toThrow(ThreadConflict);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE') || sql.includes('pg_notify'))).toBe(false);
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
    await repository.close();
  });
  it('filters ownership and orders thread members before applying the SQL limit', async () => {
    const { repository, query, thread } = fixture();
    await repository.listRunsByThread(thread.id, threadScope, 2);
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes('WHERE thread_id=$1'))!;
    expect(sql).toContain("COALESCE(state->>'owner','owner')=$2");
    expect(sql).toContain("COALESCE(state->>'tenantId','local')=$3");
    expect(sql).toContain('ORDER BY thread_sequence ASC LIMIT $4');
    expect(values).toEqual([thread.id, threadScope.owner, threadScope.tenantId, 2]);
    await repository.close();
  });
  it('applies sequence cursors before LIMIT and retrieves only one latest parent', async () => {
    const { repository, query, thread } = fixture();
    await repository.listRunsByThread(thread.id, threadScope, 2, 10);
    let [sql, values] = query.mock.calls.find(([sql]) => sql.includes('WHERE thread_id=$1'))!;
    expect(sql).toContain('AND thread_sequence > $4 ORDER BY thread_sequence ASC LIMIT $5');
    expect(values).toEqual([thread.id, threadScope.owner, threadScope.tenantId, 10, 2]);
    query.mockClear();
    await repository.latestRunByThread(thread.id, threadScope);
    [sql, values] = query.mock.calls.find(([sql]) => sql.includes('WHERE thread_id=$1'))!;
    expect(sql).toContain('ORDER BY thread_sequence DESC LIMIT 1');
    expect(values).toEqual([thread.id, threadScope.owner, threadScope.tenantId]);
    await repository.close();
  });
  it('creates and attaches a root in one transaction, and rolls back a failed root update', async () => {
    const { repository, query, thread, run } = fixture();
    await repository.createThread(thread, run.id);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('INSERT INTO aeeis_threads');
    expect(statements[2]).toContain('aeeis_runs WHERE id=$1 FOR UPDATE');
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE aeeis_runs'))!;
    expect(update[1]?.slice(0, 5)).toEqual([run.id, thread.id, null, 1, run.revision + 1]);
    expect(statements.indexOf('COMMIT')).toBeLessThan(statements.findIndex(sql => sql.includes('pg_notify')));
    const implementation = query.getMockImplementation()!; query.mockClear();
    query.mockImplementation(async (sql, values) => { if (sql.startsWith('UPDATE aeeis_runs')) throw new Error('root update failed'); return implementation(sql, values); });
    await expect(repository.createThread(thread, run.id)).rejects.toThrow('root update failed');
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT' || sql.includes('pg_notify'))).toBe(false);
    await repository.close();
  });
  it('inserts a linked run, its JSON and events before commit; an insert failure leaves no run or hint', async () => {
    const { repository, query, thread } = fixture();
    const child = threadRun();
    const committed = await repository.createRunInThread(child, thread.id, undefined, threadScope);
    const insert = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO aeeis_runs('))!;
    expect(insert[1]).toEqual([child.id, child.revision + 1, committed, committed.updatedAt, thread.id, null, 1]);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.indexOf('COMMIT')).toBeGreaterThan(statements.findIndex(sql => sql.includes('INSERT INTO aeeis_run_events')));
    expect(statements.indexOf('COMMIT')).toBeLessThan(statements.findIndex(sql => sql.includes('pg_notify')));
    const implementation = query.getMockImplementation()!; query.mockClear();
    query.mockImplementation(async (sql, values) => { if (sql.startsWith('INSERT INTO aeeis_runs(')) throw new Error('run insert failed'); return implementation(sql, values); });
    await expect(repository.createRunInThread(threadRun(), thread.id)).rejects.toThrow('run insert failed');
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(query.mock.calls.some(([sql]) => sql === 'COMMIT' || sql.includes('pg_notify'))).toBe(false);
    await repository.close();
  });
  it('locks the parent while verifying its frozen revision and terminal status', async () => {
    const { repository, query, thread, run } = fixture();
    run.threadId = thread.id; run.threadSequence = 1;
    const implementation = query.getMockImplementation()!;
    query.mockImplementation(async (sql, values) => {
      if (sql.startsWith('SELECT COALESCE(MAX(thread_sequence)')) return { rows: [{ seq: 1 }], rowCount: 1 };
      return implementation(sql, values);
    });
    const committed = await repository.createRunInThread(threadRun(), thread.id, run.id, threadScope, run.revision);
    expect(committed.threadSequence).toBe(2);
    expect(query.mock.calls.some(([sql]) => sql.includes('aeeis_runs WHERE id=$1 FOR SHARE'))).toBe(true);
    query.mockClear();
    await expect(repository.createRunInThread(threadRun(), thread.id, run.id, threadScope, run.revision - 1)).rejects.toThrow(ThreadConflict);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT') || sql.includes('pg_notify'))).toBe(false);
    expect(query.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    await repository.close();
  });
});
