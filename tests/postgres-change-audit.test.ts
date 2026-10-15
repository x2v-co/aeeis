import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { ChangeAuditLog, ChangeAuditService, verifyChain, type ChangeAuditEntry } from '../src/change-audit.js';
import { changeAuditMigration, persistChangeAuditChain, PostgresChangeAuditStore } from '../src/adapters/postgres-change-audit.js';
import { PostgresAeeisStore } from '../src/adapters/postgres-store.js';
import { PostgresBrainStore } from '../src/adapters/postgres-brain-store.js';
import { PostgresKnowledgeProvider, makeKnowledgeRecord } from '../src/knowledge.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { isolatedPostgres } from './support/postgres.js';

const actor = { kind: 'user' as const, id: 'operator' }, reason = { taskId: 'task.test', trigger: 'approved change' };
const input = { subjectKind: 'memory' as const, subjectId: 'test', op: 'create' as const, before: null, after: { content: 'first' }, actor, reason };
const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('PostgreSQL audit transaction unit tests', () => {
  function fixture() {
    let rows: ChangeAuditEntry[] = [], pending: ChangeAuditEntry[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === 'BEGIN') pending = structuredClone(rows);
      if (sql.startsWith('SELECT entry')) return { rows: structuredClone(sql.includes('WHERE') ? pending : rows).map(entry => ({ entry })) };
      if (sql.startsWith('INSERT INTO aeeis_change_audit')) pending.push(structuredClone(values![2] as ChangeAuditEntry));
      if (sql === 'COMMIT') rows = pending;
      if (sql === 'ROLLBACK') pending = rows;
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: structuredClone(rows).map(entry => ({ entry })) })) };
    return { store: new PostgresChangeAuditStore(pool as unknown as pg.Pool, 'test'), client: client as unknown as pg.PoolClient, query, release: client.release };
  }
  it('keeps the migration file identical to adapter bootstrap SQL', async () => {
    expect((await readFile(new URL('../src/adapters/migrations/005-change-audit.sql', import.meta.url), 'utf8')).trim()).toBe(changeAuditMigration.trim());
    expect(changeAuditMigration).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE');
  });
  it('locks before reading, appends only new entries, and commits before returning', async () => {
    const { store, query, release } = fixture();
    await store.transaction(log => log.append(input));
    await store.transaction(log => log.append({ ...input, op: 'update', before: input.after, after: { content: 'second' } }));
    const entries = await store.list();
    expect(entries).toHaveLength(2); expect(verifyChain(entries)).toBe(true);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO'))).toHaveLength(2);
    const firstRead = query.mock.calls.findIndex(([sql]) => sql.startsWith('SELECT entry'));
    expect(query.mock.calls.slice(0, firstRead).some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT'); expect(release).toHaveBeenCalledTimes(2);
  });
  it('rolls back both failed work and failed inserts, always releasing the client', async () => {
    const { store, query, release } = fixture();
    await expect(store.transaction(log => { log.append(input); throw new Error('subject write failed'); })).rejects.toThrow('subject write failed');
    expect(await store.list()).toEqual([]);
    query.mockImplementationOnce(async () => ({ rows: [] }));
    const implementation = query.getMockImplementation()!;
    query.mockImplementation(async (sql, values) => {
      if (sql.startsWith('INSERT INTO')) throw new Error('insert failed');
      return implementation(sql, values);
    });
    await expect(store.transaction(log => log.append(input))).rejects.toThrow('insert failed');
    expect(await store.list()).toEqual([]);
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK'); expect(release).toHaveBeenCalledTimes(2);
  });
  it('rejects rewriting a checkpoint chain prefix', async () => {
    const { store, client } = fixture();
    await store.transaction(log => log.append(input));
    await expect(persistChangeAuditChain(client, 'test', [])).rejects.toThrow('Cannot replace');
    const replacement = new ChangeAuditLog(); replacement.append(input);
    await expect(persistChangeAuditChain(client, 'test', replacement.list())).rejects.toThrow('Cannot replace');
  });
});

describe.skipIf(!databaseUrl)('PostgreSQL change audit integration', () => {
  it('persists across instances, serializes concurrent writers, and blocks history mutation', async () => {
    const db = await isolatedPostgres(databaseUrl!), first = new pg.Pool({ connectionString: db.url }), second = new pg.Pool({ connectionString: db.url });
    try {
      const left = new PostgresChangeAuditStore(first, 'test'), right = new PostgresChangeAuditStore(second, 'test');
      await Promise.all([left.init(), right.init()]);
      await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? left : right).transaction(log => log.append({ ...input, subjectId: String(index) }))));
      expect(await right.list()).toHaveLength(12); expect(verifyChain(await right.list())).toBe(true);
      await expect(first.query('UPDATE aeeis_change_audit SET id=id')).rejects.toThrow('append-only');
      await expect(first.query('DELETE FROM aeeis_change_audit')).rejects.toThrow('append-only');
      await expect(first.query('TRUNCATE aeeis_change_audit')).rejects.toThrow('append-only');
      await expect(left.transaction(async (log, client) => { await client.query('CREATE TABLE failed_audit_write(id text)'); log.append(input); throw new Error('abort'); })).rejects.toThrow('abort');
      expect((await first.query("SELECT to_regclass('failed_audit_write') AS name")).rows[0].name).toBeNull();
      expect(await left.list()).toHaveLength(12);
    } finally { await first.end(); await second.end(); await db.close(); }
  });
  it('restores domain corrections and creations, Brain deletions, and knowledge records durably', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresAeeisStore(db.url), brainStore = new PostgresBrainStore(db.url), knowledge = new PostgresKnowledgeProvider(db.url), check = new pg.Pool({ connectionString: db.url });
    await store.init(); await brainStore.init(); await knowledge.init();
    try {
      const service = new AeeisService(store), goal = await service.createGoal({ title: 'Audit' });
      const memory = await service.addMemory(goal.id, { kind: 'note', content: 'first' });
      const creation = (await service.changeAudit.list())[0]!;
      await service.correctMemory(goal.id, memory.id, { kind: 'note', content: 'second' });
      await service.changeAudit.rollback((await service.changeAudit.list()).at(-1)!.id, actor, reason);
      expect(await service.listMemories(goal.id)).toEqual([memory]);
      await service.changeAudit.rollback(creation.id, actor, reason);
      expect(await service.listMemories(goal.id)).toEqual([]);

      const brain = await brainStore.load();
      brain.addClaim({ owner: 'owner', scope: 'task', scopeRef: 'task.test', classification: 'internal', kind: 'fact', content: 'Brain', sourceRefs: [], confidence: 1 }, 'owner');
      brain.deleteScope('task.test', 'owner'); await brainStore.save(brain);
      brain.rollbackChange(brain.changeAudit.list().at(-1)!.id, 'owner', reason); await brainStore.save(brain);
      expect((await brainStore.load()).read('task.test', 'owner')).toHaveLength(1);
      expect(await new PostgresChangeAuditStore(check, 'brain').list()).toEqual(brain.changeAudit.list());

      const record = makeKnowledgeRecord({ id: 'knowledge.test', title: 'Snapshot', content: 'first', source: 'fixture', classification: 'internal', tags: [], updatedAt: new Date().toISOString() });
      await knowledge.upsert(record); await knowledge.remove(record.id);
      const deletion = (await knowledge.changeAudit.list()).at(-1)!;
      await knowledge.changeAudit.rollback(deletion.id, actor, reason);
      expect((await knowledge.search({ query: 'first', maxItems: 10, allowedClassifications: ['internal'], audience: 'owner' }))[0]?.record).toEqual(record);
      const fresh = new PostgresKnowledgeProvider(db.url); await fresh.init();
      try { expect(await fresh.changeAudit.verifyChain()).toBe(true); expect(await fresh.changeAudit.list()).toHaveLength(3); }
      finally { await fresh.close(); }
      expect(await service.changeAudit.verifyChain()).toBe(true);
    } finally { await store.close(); await brainStore.close(); await knowledge.close(); await check.end(); await db.close(); }
  });
});
