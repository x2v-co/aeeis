import { describe } from 'vitest';
import { PostgresRunRepository } from '../src/runtime/repository.js';
import { PostgresGrantLedger } from '../src/adapters/postgres-agent-ledger.js';
import { PostgresGlobalBudgetLedger } from '../src/global-budget.js';
import { isolatedPostgres } from './support/postgres.js';
import { agentFencingContract } from './support/agent-fencing-contract.js';

const databaseUrl = process.env.AEEIS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('PostgreSQL Agent execution fencing', () => {
  agentFencingContract(async () => {
    const db = await isolatedPostgres(databaseUrl!);
    const runs = [new PostgresRunRepository(db.url), new PostgresRunRepository(db.url)] as const;
    const budgets = [new PostgresGlobalBudgetLedger(db.url), new PostgresGlobalBudgetLedger(db.url)] as const;
    const grants = [new PostgresGrantLedger(db.url), new PostgresGrantLedger(db.url)] as const;
    try { for (const store of [...runs, ...budgets, ...grants]) await store.init(); }
    catch (error) { await Promise.allSettled([...runs, ...budgets, ...grants].map(store => store.close())); await db.close(); throw error; }
    return { runs: [...runs], budgets: [...budgets], grants: [...grants], async close() {
      await Promise.all([...runs, ...budgets, ...grants].map(store => store.close())); await db.close();
    } };
  });
});
