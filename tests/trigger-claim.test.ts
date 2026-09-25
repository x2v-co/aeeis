import { describe } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
import { triggerClaimContract } from './support/trigger-claim-contract.js';

describe('File atomic trigger claims', () => {
  triggerClaimContract(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-claim-'));
    const store = new FileCollaborationTriggerStore(directory); await store.init();
    return { stores: [store], async close() { await store.close(); await rm(directory, { recursive: true, force: true }); } };
  });
});
