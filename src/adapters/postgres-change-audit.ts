import type pg from 'pg';
import { ChangeAuditConflict, ChangeAuditLog, canonicalJson, type ChangeAuditEntry, type ChangeAuditStore, type MaybePromise } from '../change-audit.js';
import { postgresAdvisoryXactLock } from './postgres-lock.js';
import { withPostgresMigrationLock } from './postgres-migration.js';

// Keep in sync with migrations/005-change-audit.sql, like the other adapter migrations.
export const changeAuditMigration = `
CREATE TABLE IF NOT EXISTS aeeis_change_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream text NOT NULL,
  id text NOT NULL,
  entry jsonb NOT NULL,
  UNIQUE(stream, id),
  CHECK (entry->>'id' = id),
  CHECK (entry->>'subjectKind' IN ('memory', 'skill')),
  CHECK (entry->>'op' IN ('create', 'update', 'delete', 'rollback'))
);
CREATE INDEX IF NOT EXISTS aeeis_change_audit_stream_idx ON aeeis_change_audit(stream, sequence);
CREATE OR REPLACE FUNCTION aeeis_change_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Change audit entries are append-only';
END;
$$;
DROP TRIGGER IF EXISTS aeeis_change_audit_immutable ON aeeis_change_audit;
CREATE TRIGGER aeeis_change_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON aeeis_change_audit
FOR EACH STATEMENT EXECUTE FUNCTION aeeis_change_audit_append_only();
`;

/** One ordered chain per persistence boundary; the lock also covers an empty chain. */
export class PostgresChangeAuditStore implements ChangeAuditStore<pg.PoolClient> {
  constructor(private readonly pool: pg.Pool, readonly stream: string) {}
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'change-audit', async client => { await client.query(changeAuditMigration); });
  }
  async list(): Promise<ChangeAuditEntry[]> {
    return (await this.pool.query<{ entry: ChangeAuditEntry }>('SELECT entry FROM aeeis_change_audit WHERE stream=$1 ORDER BY sequence', [this.stream])).rows.map(row => row.entry);
  }
  async transaction<T>(work: (log: ChangeAuditLog, tx: pg.PoolClient) => MaybePromise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await postgresAdvisoryXactLock(client, 'aeeis:change-audit', this.stream);
      const entries = (await client.query<{ entry: ChangeAuditEntry }>('SELECT entry FROM aeeis_change_audit WHERE stream=$1 ORDER BY sequence', [this.stream])).rows.map(row => row.entry);
      const log = new ChangeAuditLog(entries);
      const result = await work(log, client);
      for (const entry of log.list().slice(entries.length)) await insertEntry(client, this.stream, entry);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

/** Checkpoint-backed synchronous Brain chains are mirrored in the same state-save transaction. */
export async function persistChangeAuditChain(client: pg.PoolClient, stream: string, entries: ChangeAuditEntry[]): Promise<void> {
  await postgresAdvisoryXactLock(client, 'aeeis:change-audit', stream);
  new ChangeAuditLog(entries);
  const existing = (await client.query<{ entry: ChangeAuditEntry }>('SELECT entry FROM aeeis_change_audit WHERE stream=$1 ORDER BY sequence', [stream])).rows.map(row => row.entry);
  if (existing.length > entries.length || existing.some((entry, index) => canonicalJson(entry) !== canonicalJson(entries[index]))) throw new ChangeAuditConflict('Cannot replace change audit history');
  for (const entry of entries.slice(existing.length)) await insertEntry(client, stream, entry);
}
async function insertEntry(client: pg.PoolClient, stream: string, entry: ChangeAuditEntry): Promise<void> {
  await client.query('INSERT INTO aeeis_change_audit(stream,id,entry) VALUES($1,$2,$3)', [stream, entry.id, entry]);
}
