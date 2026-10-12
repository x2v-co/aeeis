import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFound, PostgresRunRepository } from '../src/runtime/repository.js';
import { ThreadConflict } from '../src/runtime/threads.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';

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
  const client = { query, release };
  const pool = { query, connect: vi.fn(async () => client), end: vi.fn(async () => undefined) };
  vi.spyOn(pg, 'Pool').mockImplementation(() => pool as unknown as pg.Pool);
  const repository = new PostgresRunRepository('postgres://unused');
  return { repository, query, release, thread, run };
}

describe('PostgreSQL thread transaction boundary', () => {
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
});
