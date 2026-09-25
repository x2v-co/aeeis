import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';
import { FileRunRepository } from '../src/runtime/repository.js';
import { InMemoryGrantLedger } from '../src/agent-ledger.js';
import { FileGlobalBudgetLedger } from '../src/global-budget.js';
import { agentFencingContract } from './support/agent-fencing-contract.js';

describe('File Agent execution fencing', () => {
  agentFencingContract(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-agent-fence-'));
    const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
    const budgets = new FileGlobalBudgetLedger(join(directory, 'budgets.json')); await budgets.init();
    const grants = new InMemoryGrantLedger();
    return { runs: [runs, runs], budgets: [budgets, budgets], grants: [grants, grants], async close() {
      await runs.close(); await budgets.close(); await rm(directory, { recursive: true, force: true });
    } };
  });
});
