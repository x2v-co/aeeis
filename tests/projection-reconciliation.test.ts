import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileProjectionOutbox } from '../src/collaboration-projection.js';
import { reconcileProjectionSnapshots } from '../src/projection-reconciliation.js';

describe('projection snapshot reconciliation', () => {
  it('is idempotent, hashes state versions, and keeps destinations isolated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-projection-reconcile-'));
    const outbox = new FileProjectionOutbox(directory);
    await outbox.init();
    try {
      const targets = [
        { channel: 'hermes', destination: 'room.one' },
        { channel: 'hermes', destination: 'room.two', aggregateTypes: ['evolution' as const] },
      ];
      const snapshots = [
        { aggregateType: 'room' as const, aggregateId: 'room.1', owner: 'alice', tenantId: 'team-a', payload: { status: 'active', members: [{ principalId: 'bob', role: 'editor' }] } },
        { aggregateType: 'run' as const, aggregateId: 'run.1', owner: 'alice', tenantId: 'team-a', payload: { status: 'running', revision: 1 } },
        { aggregateType: 'evolution' as const, aggregateId: 'evo.1', owner: 'alice', tenantId: 'team-a', payload: { status: 'proposed', revision: 1 } },
      ];
      await expect(reconcileProjectionSnapshots(targets, outbox, snapshots)).resolves.toEqual({ attempted: 4, failed: 0 });
      await expect(reconcileProjectionSnapshots(targets, outbox, snapshots)).resolves.toEqual({ attempted: 4, failed: 0 });
      expect(await outbox.list()).toHaveLength(4);
      expect(new Set((await outbox.list()).map(event => event.destination))).toEqual(new Set(['room.one', 'room.two']));

      await reconcileProjectionSnapshots(targets, outbox, [{ ...snapshots[1]!, payload: { status: 'approved', revision: 2 } }]);
      expect(await outbox.list()).toHaveLength(5);
    } finally {
      await outbox.close();
    }
  });
});
