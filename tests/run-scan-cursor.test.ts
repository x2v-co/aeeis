import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileRunScanCursorStore, RunEventScanner } from '../src/run-scan-cursor.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiProposalPump } from '../src/rsi-proposal-pump.js';
import { runWithSignals } from './support/rsi-proposal.js';
import { runScanContract } from './support/run-scan-contract.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-run-scan-'));
  const f = {
    directory, runs: new FileRunRepository(join(directory, 'runs')), cursors: new FileRunScanCursorStore(join(directory, 'scan.json')),
    async restart() {
      await f.runs.close(); await f.cursors.close();
      f.runs = new FileRunRepository(join(directory, 'runs')); f.cursors = new FileRunScanCursorStore(join(directory, 'scan.json'));
      await f.runs.init(); await f.cursors.init();
    },
    async close() { await f.runs.close(); await f.cursors.close(); await rm(directory, { recursive: true, force: true }); },
  };
  await f.runs.init(); await f.cursors.init(); return f;
}

describe('File durable Run event scanner', () => {
  runScanContract(fixture);

  it('loads full Run state only for records with projected events', async () => {
    const f = await fixture();
    try {
      await f.runs.create(runWithSignals());
      const empty = runWithSignals(); empty.id = 'run_00000000-0000-4000-8000-000000000099'; empty.events = [];
      await f.runs.create(empty);
      // Warm the disposable metadata index so this assertion measures the
      // steady-state scan rather than its one-time rebuild.
      await f.runs.scanEventsPage!({ limit: 10 });
      const get = vi.spyOn(f.runs, 'get');
      const scanPage = vi.spyOn(f.runs, 'scanPage').mockRejectedValue(new Error('Full aggregate scan forbidden'));
      const scanner = new RunEventScanner(f.runs, f.cursors, 'projection', 10, { useEventProjection: true });
      const batch = await scanner.batch(10);
      expect(batch.entries.length).toBe(2);
      expect(get).toHaveBeenCalledTimes(1);
      expect(scanPage).not.toHaveBeenCalled();
      await batch.commit();
    } finally { await f.close(); }
  });

  it('continues RSI discovery past a failed signal and deduplicates after checkpoint write failure', async () => {
    const f = await fixture();
    const candidates = new FileEvolutionRepository(join(f.directory, 'evolution')); await candidates.init();
    const rsi = new RsiService(candidates);
    const propose = vi.spyOn(rsi, 'propose').mockRejectedValueOnce(new Error('temporary store failure'));
    const list = vi.spyOn(f.runs, 'list').mockRejectedValue(new Error('Full scan forbidden'));
    try {
      for (let n = 1; n <= 3; n++) {
        const run = runWithSignals(); run.id = `run_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        run.events = [run.events[1]!]; await f.runs.create(run);
      }
      const pump = new RsiProposalPump(f.runs, rsi, { scanCursorStore: f.cursors, scanPageSize: 1, maxSignalsPerPass: 1 });
      const aggregateScan = vi.spyOn(f.runs, 'scanPage').mockRejectedValue(new Error('Full aggregate scan forbidden'));
      expect((await pump.pump()).failed).toBe(1);
      const write = vi.spyOn(f.cursors, 'advance').mockRejectedValueOnce(new Error('checkpoint storage unavailable'));
      await expect(pump.pump()).rejects.toThrow('checkpoint storage unavailable');
      expect(await candidates.list()).toHaveLength(1);
      write.mockRestore();
      await pump.pump();
      expect(await candidates.list()).toHaveLength(1);
      for (let i = 0; i < 20 && (await candidates.list()).length < 3; i++) await pump.pump();
      expect(await candidates.list()).toHaveLength(3);
      expect(propose.mock.calls.length).toBe(4); expect(list).not.toHaveBeenCalled(); expect(aggregateScan).not.toHaveBeenCalled();
    } finally { await candidates.close(); await f.close(); }
  });
});
