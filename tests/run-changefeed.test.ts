import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunRepository } from '../src/runtime/repository.js';
import { runWithSignals } from './support/rsi-proposal.js';

describe('Run changefeed hints', () => {
  it('publishes only after a durable File commit and unsubscribes cleanly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-run-changefeed-'));
    const repository = new FileRunRepository(directory);
    await repository.init();
    try {
      const changes: unknown[] = [];
      const failing = vi.fn(() => { throw new Error('subscriber failure'); });
      const unsubscribe = await repository.subscribeChanges!(change => { changes.push(change); });
      await repository.subscribeChanges!(failing);
      const run = runWithSignals();
      await repository.create(run);
      await new Promise(resolve => setImmediate(resolve));
      expect(changes).toEqual([expect.objectContaining({ runId: run.id, owner: run.owner, tenantId: run.tenantId, lastEventSeq: run.events.at(-1)?.seq })]);
      expect(failing).toHaveBeenCalledTimes(1);
      await unsubscribe();
      await repository.mutate(run.id, current => { current.status = 'paused'; });
      await new Promise(resolve => setImmediate(resolve));
      expect(changes).toHaveLength(1);
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
