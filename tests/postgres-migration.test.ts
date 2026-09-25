import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { withPostgresMigrationLock } from '../src/adapters/postgres-migration.js';
import { isolatedPostgres } from './support/postgres.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('PostgreSQL migration lock', () => {
  it.skipIf(!databaseUrl)('serializes concurrent bootstrap transactions', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const firstPool = new pg.Pool({ connectionString: db.url });
    const secondPool = new pg.Pool({ connectionString: db.url });
    let enteredFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    let enteredSecond = false;
    const first = withPostgresMigrationLock(firstPool, 'bootstrap-order', async client => {
      await client.query('CREATE TABLE migration_lock_order (step integer NOT NULL)');
      enteredFirst();
      await firstRelease;
      await client.query('INSERT INTO migration_lock_order(step) VALUES (1)');
    });
    await firstEntered;
    const second = withPostgresMigrationLock(secondPool, 'bootstrap-order', async client => {
      enteredSecond = true;
      await client.query('INSERT INTO migration_lock_order(step) VALUES (2)');
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(enteredSecond).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(enteredSecond).toBe(true);
    const result = await firstPool.query<{ step: number }>('SELECT step FROM migration_lock_order ORDER BY step');
    expect(result.rows.map(row => Number(row.step))).toEqual([1, 2]);
    await firstPool.end();
    await secondPool.end();
    await db.close();
  });

  it.skipIf(!databaseUrl)('rolls back failed migrations and releases the lock', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const pool = new pg.Pool({ connectionString: db.url });
    try {
      await expect(withPostgresMigrationLock(pool, 'bootstrap-rollback', async client => {
        await client.query('CREATE TABLE migration_lock_rollback (value integer NOT NULL)');
        throw new Error('migration failed');
      })).rejects.toThrow('migration failed');
      await withPostgresMigrationLock(pool, 'bootstrap-rollback', async client => {
        await client.query('CREATE TABLE migration_lock_rollback (value integer NOT NULL)');
        await client.query('INSERT INTO migration_lock_rollback(value) VALUES (7)');
      });
      const result = await pool.query<{ value: number }>('SELECT value FROM migration_lock_rollback');
      expect(result.rows.map(row => Number(row.value))).toEqual([7]);
    } finally {
      await pool.end();
      await db.close();
    }
  });
});
