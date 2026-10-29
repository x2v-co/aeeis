import pg from 'pg';
import { postgresAdvisoryXactLock } from './postgres-lock.js';
import { ScopedPool, grantAppRole, migrationPoolFor } from './postgres-pool.js';

/** Serialize adapter DDL and in-place migrations across API/Worker processes. Runs as the owner role when the app has its own. */
export async function withPostgresMigrationLock(
  pool: pg.Pool,
  lockName: string,
  migrate: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const owner = migrationPoolFor(pool);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await postgresAdvisoryXactLock(client, 'aeeis:migration', lockName);
    await migrate(client);
    // Tables created as the owner are usable by the app role at once; row-level security follows at startup.
    const appRole = (pool as unknown) instanceof ScopedPool ? (pool as unknown as ScopedPool).appRole : undefined;
    if (owner !== pool && appRole) await grantAppRole(client, appRole);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
