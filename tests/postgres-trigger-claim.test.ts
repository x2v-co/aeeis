import { describe } from 'vitest';
import { PostgresCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { isolatedPostgres } from './support/postgres.js';
import { triggerClaimContract } from './support/trigger-claim-contract.js';

describe.skipIf(!process.env.AEEIS_TEST_DATABASE_URL)('PostgreSQL atomic trigger claims across connections', () => {
  triggerClaimContract(async () => {
    const db = await isolatedPostgres(process.env.AEEIS_TEST_DATABASE_URL!);
    const stores = [new PostgresCollaborationTriggerStore(db.url), new PostgresCollaborationTriggerStore(db.url)];
    await Promise.all(stores.map(store => store.init()));
    return { stores, async close() { await Promise.all(stores.map(store => store.close())); await db.close(); } };
  });
});
