import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileRunScanCursorStore, RunEventScanner, RunScanIdleGate } from '../src/run-scan-cursor.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiProposalPump } from '../src/rsi-proposal-pump.js';
import { runWithSignals } from './support/rsi-proposal.js';
import { scanRun } from './support/run-scan-contract.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-run-scan-idle-'));
  const runs = new FileRunRepository(join(directory, 'runs'));
  const cursors = new FileRunScanCursorStore(join(directory, 'scan.json'));
  await runs.init(); await cursors.init();
  let now = 1_000_000;
  const gate = new RunScanIdleGate(() => now);
  return {
    directory, runs, cursors, gate,
    advance(ms: number) { now += ms; },
    async close() { await runs.close(); await cursors.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

/** Runs batches until the persisted cursor resets, i.e. one sweep ends. A
 * resting scanner returns an empty batch without moving the cursor. */
async function sweep(scanner: RunEventScanner, cursors: FileRunScanCursorStore, settled = true): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const before = await cursors.get('idle');
    const batch = await scanner.batch(10);
    seen.push(...batch.entries.map(entry => entry.event.id));
    await batch.commit({ settled });
    const after = await cursors.get('idle');
    if (after.revision === before.revision) return seen; // resting
    if (!Object.keys(after.cursor).length) return seen;
  }
  throw new Error('sweep did not finish');
}

describe('Run scan idle gate', () => {
  it('rests after a quiet sweep without touching the cursor or Run stores', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 2)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_1_1', 'evt_2_0']);
      const get = vi.spyOn(f.cursors, 'get'); const scan = vi.spyOn(f.runs, 'scanEventsPage'); const advance = vi.spyOn(f.cursors, 'advance');
      for (let i = 0; i < 5; i++) {
        const batch = await scanner.batch(10);
        expect(batch.entries).toEqual([]);
        expect(await batch.commit()).toBe(true);
      }
      expect(get).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
      // The fallback sweep still runs once the rest expires.
      f.advance(60_000);
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_1_1', 'evt_2_0']);
      expect(scan).toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('wakes on a Run change and delivers the new event', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      await sweep(scanner, f.cursors);
      await f.runs.create(scanRun(2, 1));
      expect((await scanner.batch(10)).entries).toEqual([]);
      f.gate.wake();
      expect(await sweep(scanner, f.cursors)).toContain('evt_2_0');
    } finally { await f.close(); }
  });

  it('does not rest when a change arrives during the sweep', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      const first = await scanner.batch(10); await first.commit();
      f.gate.wake();
      await sweep(scanner, f.cursors);
      // A change landed mid-sweep, so the next tick sweeps again; that quiet
      // sweep is the one that rests.
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_2_0']);
      expect((await scanner.batch(10)).entries).toEqual([]);
      const scan = vi.spyOn(f.runs, 'scanEventsPage');
      await scanner.batch(10);
      expect(scan).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('keeps sweeping after an unsettled batch so failures retry promptly', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      await sweep(scanner, f.cursors, false);
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0']);
    } finally { await f.close(); }
  });

  it('does not rest when an earlier batch failed and the last one settled', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      const failed = await scanner.batch(10);
      expect(failed.entries.map(entry => entry.event.id)).toEqual(['evt_1_0']);
      await failed.commit({ settled: false });
      // The rest of the sweep settles, including its final batch.
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_2_0']);
      // The failed event is retried on the next tick, not after the rest.
      const retry = await scanner.batch(10);
      expect(retry.entries.map(entry => entry.event.id)).toEqual(['evt_1_0']);
      await retry.commit();
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_2_0']);
      // Only a sweep in which every batch settled rests.
      const scan = vi.spyOn(f.runs, 'scanEventsPage');
      expect((await scanner.batch(10)).entries).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('does not rest when one Run was split across batches and its first part failed', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 3));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        const batch = await scanner.batch(1);
        seen.push(...batch.entries.map(entry => entry.event.id));
        await batch.commit({ settled: i !== 0 });
      }
      expect(seen).toEqual(['evt_1_0', 'evt_1_1', 'evt_1_2']);
      expect((await f.cursors.get('idle')).cursor).toEqual({});
      const retry = await scanner.batch(1);
      expect(retry.entries.map(entry => entry.event.id)).toEqual(['evt_1_0']);
    } finally { await f.close(); }
  });

  it('sweeps continuously while the gate is disabled', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1));
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      await sweep(scanner, f.cursors);
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0']);
      f.gate.enable(60_000); await sweep(scanner, f.cursors);
      f.gate.disable();
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0']);
    } finally { await f.close(); }
  });

  it('does not rest after a sweep it resumed from a persisted mid-sweep cursor', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000);
      const before = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      await (await before.batch(10)).commit();
      // A restarted process cannot know whether changes were missed before it
      // subscribed, so its first finished sweep is followed by a full one.
      const after = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      expect(await sweep(after, f.cursors)).toEqual(['evt_2_0']);
      expect(await sweep(after, f.cursors)).toEqual(['evt_1_0', 'evt_2_0']);
      expect((await after.batch(10)).entries).toEqual([]);
    } finally { await f.close(); }
  });

  it('rejects rest periods outside the supported range', () => {
    const gate = new RunScanIdleGate();
    expect(() => gate.enable(999)).toThrow(/between 1000/);
    expect(() => gate.enable(3_600_001)).toThrow(/between 1000/);
    expect(() => gate.enable(1.5e3 + 0.5)).toThrow(/between 1000/);
  });

  it('retries a failed RSI signal on the next pump instead of resting', async () => {
    const f = await fixture();
    const candidates = new FileEvolutionRepository(join(f.directory, 'evolution')); await candidates.init();
    const rsi = new RsiService(candidates);
    const propose = vi.spyOn(rsi, 'propose').mockRejectedValueOnce(new Error('temporary store failure'));
    try {
      const run = runWithSignals(); run.events = [run.events[1]!]; await f.runs.create(run);
      f.gate.enable(60_000);
      const pump = new RsiProposalPump(f.runs, rsi, { scanCursorStore: f.cursors, scanIdle: f.gate });
      expect((await pump.pump()).failed).toBe(1);
      expect((await pump.pump()).proposed).toBe(1);
      expect(propose).toHaveBeenCalledTimes(2);
      // That retry settled the sweep. No change feed is wired here, so the
      // pump's own writes do not wake the gate and the next pass rests.
      expect((await pump.pump()).inspected).toBe(0);
    } finally { await f.close(); }
  });
});
