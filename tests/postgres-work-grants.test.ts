import { describe } from 'vitest';
import { PostgresWorkGrantStore } from '../src/work-grant-store.js';
import { isolatedPostgres } from './support/postgres.js';
import { runWorkGrantStoreContract } from './support/work-grant-contract.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;

describe('Postgres work grant store', () => {
  runWorkGrantStoreContract('PostgreSQL', async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const store = new PostgresWorkGrantStore(db.url); await store.init();
    return {
      store,
      reopen: async current => { await current.close?.(); const next = new PostgresWorkGrantStore(db.url); await next.init(); return next; },
      dispose: () => db.close(),
    };
  }, !databaseUrl);
});
