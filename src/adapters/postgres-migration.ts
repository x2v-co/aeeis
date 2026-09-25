import pg from 'pg';
import { postgresAdvisoryXactLock } from './postgres-lock.js';

/** Serialize adapter DDL and in-place migrations across API/Worker processes. */
export async function withPostgresMigrationLock(
  pool: pg.Pool,
  lockName: string,
  migrate: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await postgresAdvisoryXactLock(client, 'aeeis:migration', lockName);
    await migrate(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
