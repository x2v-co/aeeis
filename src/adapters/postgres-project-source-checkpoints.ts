import pg from 'pg';
import { withPostgresMigrationLock } from './postgres-migration.js';
import {
  projectSourceCheckpointKeySchema,
  projectSourceCheckpointSchema,
  projectSourceProtocolHash,
  nextProjectSourceCheckpoint,
  normalizeProjectSourceSyncResult,
  type ProjectSourceCheckpoint,
  type ProjectSourceCheckpointKey,
  type ProjectSourceCheckpointStore,
  type ProjectSourceSyncResult,
} from '../project-sources.js';
import { ProjectSourceCheckpointConflict } from '../project-sources.js';

/** PostgreSQL durable cursor store. A row lock plus compare-and-set keeps two
 * long-running sync jobs from silently advancing the same source cursor. */
export class PostgresProjectSourceCheckpointStore implements ProjectSourceCheckpointStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }

  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'project-source-checkpoints', async client => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS aeeis_project_source_checkpoints (
          checkpoint_key text PRIMARY KEY,
          provider text NOT NULL,
          tenant_id text NOT NULL,
          query text NOT NULL,
          revision bigint NOT NULL,
          state jsonb NOT NULL,
          updated_at timestamptz NOT NULL
        );
        CREATE INDEX IF NOT EXISTS aeeis_project_source_checkpoints_scope_idx
          ON aeeis_project_source_checkpoints(tenant_id, provider);
      `);
    });
  }

  async get(key: ProjectSourceCheckpointKey): Promise<ProjectSourceCheckpoint | undefined> {
    const parsed = projectSourceCheckpointKeySchema.parse(key);
    const result = await this.pool.query('SELECT state FROM aeeis_project_source_checkpoints WHERE checkpoint_key=$1', [keyHash(parsed)]);
    return result.rows[0] ? projectSourceCheckpointSchema.parse(result.rows[0].state) : undefined;
  }

  async save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, result: ProjectSourceSyncResult): Promise<ProjectSourceCheckpoint>;
  async save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, cursor: string, receipt: import('../project-sources.js').ProjectSourceSyncReceipt): Promise<ProjectSourceCheckpoint>;
  async save(key: ProjectSourceCheckpointKey, expectedRevision: number | undefined, resultOrCursor: ProjectSourceSyncResult | string, legacyReceipt?: import('../project-sources.js').ProjectSourceSyncReceipt): Promise<ProjectSourceCheckpoint> {
    const parsedKey = projectSourceCheckpointKeySchema.parse(key);
    const checkpointKey = keyHash(parsedKey);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ revision: string; state: unknown }>('SELECT revision, state FROM aeeis_project_source_checkpoints WHERE checkpoint_key=$1 FOR UPDATE', [checkpointKey]);
      const currentRevision = existing.rows[0] ? Number(existing.rows[0].revision) : undefined;
      if (currentRevision !== expectedRevision) {
        throw new ProjectSourceCheckpointConflict(existing.rows[0]
          ? 'Project source checkpoint changed concurrently; retry from the latest cursor'
          : 'Project source checkpoint was deleted concurrently; retry from the beginning');
      }
      const current = existing.rows[0] ? projectSourceCheckpointSchema.parse(existing.rows[0].state) : undefined;
      const next = nextProjectSourceCheckpoint(parsedKey, current, normalizeProjectSourceSyncResult(parsedKey, current, resultOrCursor, legacyReceipt));
      if (existing.rows[0]) {
        await client.query('UPDATE aeeis_project_source_checkpoints SET provider=$2, tenant_id=$3, query=$4, revision=$5, state=$6, updated_at=$7 WHERE checkpoint_key=$1', [checkpointKey, parsedKey.provider, parsedKey.tenantId, parsedKey.query, next.revision, next, next.updatedAt]);
      } else {
        await client.query('INSERT INTO aeeis_project_source_checkpoints(checkpoint_key,provider,tenant_id,query,revision,state,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [checkpointKey, parsedKey.provider, parsedKey.tenantId, parsedKey.query, next.revision, next, next.updatedAt]);
      }
      await client.query('COMMIT');
      return structuredClone(next);
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) throw new ProjectSourceCheckpointConflict('Project source checkpoint changed concurrently; retry from the latest cursor');
      throw error;
    } finally { client.release(); }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

function keyHash(key: ProjectSourceCheckpointKey): string { return projectSourceProtocolHash(key); }
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505'); }
