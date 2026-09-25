import { expect, it, vi } from 'vitest';
import type { RunRepository } from '../../src/runtime/repository.js';
import type { RunScanCursorStore } from '../../src/run-scan-cursor.js';
import { RunEventScanner } from '../../src/run-scan-cursor.js';
import { runWithSignals } from './rsi-proposal.js';

export interface ScanFixture {
  runs: RunRepository;
  cursors: RunScanCursorStore;
  restart(): Promise<void>;
  close(): Promise<void>;
}
const id = (n: number) => `run_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function scanRun(n: number, events = 2) {
  const run = runWithSignals(); run.id = id(n);
  run.events = Array.from({ length: events }, (_, i) => ({ ...run.events[0]!, id: `evt_${n}_${i}`, seq: i + 1 }));
  return run;
}

export function runScanContract(make: () => Promise<ScanFixture>) {
  it('persists partial event progress across closed connections and replays an uncommitted batch', async () => {
    const f = await make();
    try {
      await f.runs.create(scanRun(1, 3)); await f.runs.create(scanRun(2, 2));
      let scanner = new RunEventScanner(f.runs, f.cursors, 'rsi', 1);
      const first = await scanner.batch(1);
      expect(first.entries.map(x => x.event.id)).toEqual(['evt_1_0']);
      expect(await first.commit()).toBe(true);
      const abandoned = await scanner.batch(1);
      expect(abandoned.entries[0]!.event.id).toBe('evt_1_1');
      await f.restart();
      scanner = new RunEventScanner(f.runs, f.cursors, 'rsi', 1);
      const replay = await scanner.batch(1);
      expect(replay.entries[0]!.event.id).toBe('evt_1_1'); await replay.commit();
      const observed: string[] = [];
      for (let i = 0; i < 6 && observed.length < 3; i++) {
        const batch = await scanner.batch(1); observed.push(...batch.entries.map(x => x.event.id)); await batch.commit();
      }
      expect(observed).toEqual(['evt_1_2', 'evt_2_0', 'evt_2_1']);
      for (let i = 0; i < 2; i++) {
        const next = await scanner.batch(1); await next.commit();
        if (next.entries.length) { expect(next.entries[0]!.event.id).toBe('evt_1_0'); break; }
      }
    } finally { await f.close(); }
  });

  it('bounds each read and finishes a sweep despite new Runs, appended events and changed timestamps', async () => {
    const f = await make();
    try {
      await f.runs.create(scanRun(2, 3)); await f.runs.create(scanRun(4, 1));
      const list = vi.spyOn(f.runs, 'list').mockRejectedValue(new Error('Full scan forbidden'));
      const pages = vi.spyOn(f.runs, 'scanPage');
      const scanner = new RunEventScanner(f.runs, f.cursors, 'rsi', 1);
      const first = await scanner.batch(1); await first.commit();
      await f.runs.create(scanRun(1, 1)); // inserted behind the sweep
      await f.runs.create(scanRun(9, 1)); // beyond the frozen upper bound
      await f.runs.mutate(id(2), run => { run.events.push({ ...run.events[0]!, id: 'evt_later', seq: 4 }); });
      // An inserted ID before the partially processed Run is visited safely.
      const seen = new Set(first.entries.map(x => x.event.id));
      let finished = false;
      for (let i = 0; i < 12; i++) {
        const calls = pages.mock.calls.length;
        const batch = await scanner.batch(1);
        expect(pages.mock.calls.length - calls).toBe(1);
        expect(batch.entries.length).toBeLessThanOrEqual(1);
        batch.entries.forEach(x => seen.add(x.event.id)); await batch.commit();
        if (!(await f.cursors.get('rsi')).cursor.throughId) { finished = true; break; }
      }
      expect(finished).toBe(true); expect(seen.has('evt_4_0')).toBe(true);
      expect(seen.has('evt_9_0')).toBe(false); expect(seen.has('evt_later')).toBe(false);
      for (let i = 0; i < 12; i++) {
        const batch = await scanner.batch(2); batch.entries.forEach(x => seen.add(x.event.id)); await batch.commit();
        if (seen.has('evt_9_0') && seen.has('evt_later')) break;
      }
      expect(seen.has('evt_9_0')).toBe(true); expect(seen.has('evt_later')).toBe(true);
      expect(list).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('rejects stale checkpoint commits and bounds pages containing no events', async () => {
    const f = await make();
    try {
      for (let n = 1; n <= 4; n++) await f.runs.create(scanRun(n, 0));
      const scanner = new RunEventScanner(f.runs, f.cursors, 'rsi', 2);
      const a = await scanner.batch(2), b = await scanner.batch(2);
      expect(a.entries).toEqual([]); expect(await a.commit()).toBe(true);
      expect((await f.cursors.get('rsi')).cursor.afterId).toBe(id(2));
      expect(await b.commit()).toBe(false);
      const c = await scanner.batch(2); await c.commit();
      const checkpoint = await f.cursors.get('rsi');
      expect(checkpoint.cursor.afterId === id(4) || !checkpoint.cursor.afterId).toBe(true);
      const unrelated = await f.cursors.get('collaboration');
      expect(unrelated).toEqual({ revision: 0, cursor: {} });
    } finally { await f.close(); }
  });
}
