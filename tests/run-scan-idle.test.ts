import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileRunScanCursorStore, RunEventScanner, RunScanIdleGate, RunScanIdlePass } from '../src/run-scan-cursor.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { RsiProposalPump } from '../src/rsi-proposal-pump.js';
import { runWithSignals } from './support/rsi-proposal.js';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';
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
      // The fallback sweep still runs once the rest expires. Both Runs settled
      // unchanged, so it reads the scan pages but delivers nothing.
      f.advance(60_000);
      expect(await sweep(scanner, f.cursors)).toEqual([]);
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
      const scan = vi.spyOn(f.runs, 'scanEventsPage');
      expect(await sweep(scanner, f.cursors)).toEqual([]);
      expect(scan).toHaveBeenCalled();
      scan.mockClear();
      expect((await scanner.batch(10)).entries).toEqual([]);
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
      // Run 2 settled in the earlier sweep and has not changed.
      expect(await sweep(scanner, f.cursors)).toEqual([]);
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
      // subscribed, so its first finished sweep is followed by another one
      // instead of a rest. Run 1 was handled by the old process, so this one
      // reads it again; Run 2 settled here and is skipped.
      const after = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      expect(await sweep(after, f.cursors)).toEqual(['evt_2_0']);
      expect(await sweep(after, f.cursors)).toEqual(['evt_1_0']);
      const scan = vi.spyOn(f.runs, 'scanEventsPage');
      expect((await after.batch(10)).entries).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
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

describe('Skipping unchanged Runs', () => {
  const ids = (batchEntries: Array<{ event: { id: string } }>) => batchEntries.map(entry => entry.event.id);

  it('re-reads a changed Run from its first event and skips the rest', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 2)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_1_1', 'evt_2_0']);
      await f.runs.mutate(scanRun(1).id, run => { run.events.push({ ...run.events[0]!, id: 'evt_1_2', seq: 3 }); });
      f.gate.wake();
      // The whole changed Run comes back, as before; the unchanged one does not.
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_1_1', 'evt_1_2']);
    } finally { await f.close(); }
  });

  it('finishes a quiet sweep in one batch', async () => {
    const f = await fixture();
    try {
      for (let n = 1; n <= 5; n++) await f.runs.create(scanRun(n, 1));
      f.gate.enable(60_000);
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 1, { useEventProjection: true, idle: f.gate });
      await sweep(scanner, f.cursors);
      f.gate.wake();
      const quiet = await scanner.batch(10);
      expect(quiet.entries).toEqual([]);
      await quiet.commit();
      expect((await f.cursors.get('idle')).cursor).toEqual({});
    } finally { await f.close(); }
  });

  it('re-reads every Run after a replay and after the replay interval', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000, { replayMs: 1_800_000 });
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      await sweep(scanner, f.cursors);
      f.gate.replay();
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_2_0']);
      f.advance(60_000);
      expect(await sweep(scanner, f.cursors)).toEqual([]);
      f.advance(1_800_000);
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0', 'evt_2_0']);
    } finally { await f.close(); }
  });

  it('does not remember a Run split across a restart, nor one from an unsettled batch', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 3)); await f.runs.create(scanRun(2, 1));
      f.gate.enable(60_000);
      const before = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      const part = await before.batch(1);
      expect(ids(part.entries)).toEqual(['evt_1_0']);
      await part.commit();
      // A new process finishes Run 1, so it cannot know how the first part went.
      const after = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      const rest = await after.batch(10);
      expect(ids(rest.entries)).toEqual(['evt_1_1', 'evt_1_2', 'evt_2_0']);
      await rest.commit();
      // Run 2 settled whole in this process; Run 1 did not, so it is read again.
      expect(await sweep(after, f.cursors)).toEqual(['evt_1_0', 'evt_1_1', 'evt_1_2']);
      expect(await sweep(after, f.cursors)).toEqual([]);
      // An unsettled batch is not remembered either.
      await f.runs.mutate(scanRun(2).id, run => { run.events.push({ ...run.events[0]!, id: 'evt_2_1', seq: 2 }); });
      f.gate.wake();
      const failed = await after.batch(10);
      expect(ids(failed.entries)).toEqual(['evt_2_0', 'evt_2_1']);
      await failed.commit({ settled: false });
      expect(await sweep(after, f.cursors)).toEqual(['evt_2_0', 'evt_2_1']);
    } finally { await f.close(); }
  });

  it('never skips while the gate is disabled', async () => {
    const f = await fixture();
    try {
      await f.runs.create(scanRun(1, 1));
      const scanner = new RunEventScanner(f.runs, f.cursors, 'idle', 5, { useEventProjection: true, idle: f.gate });
      await sweep(scanner, f.cursors);
      expect(await sweep(scanner, f.cursors)).toEqual(['evt_1_0']);
    } finally { await f.close(); }
  });

  it('keeps a Run whose RSI signal another worker holds', async () => {
    const f = await fixture();
    const candidates = new FileEvolutionRepository(join(f.directory, 'evolution')); await candidates.init();
    const rsi = new RsiService(candidates);
    let held = true;
    const claimStore = {
      claim: vi.fn(async () => held ? { claimed: false as const } : { claimed: true as const, token: 't' }),
      release: vi.fn(async () => undefined),
    };
    try {
      const run = runWithSignals(); run.events = [run.events[1]!]; await f.runs.create(run);
      f.gate.enable(60_000);
      const pump = new RsiProposalPump(f.runs, rsi, { scanCursorStore: f.cursors, scanIdle: f.gate, claimStore });
      expect((await pump.pump()).skipped).toBe(1);
      held = false;
      // Neither rested nor skipped: the held signal comes straight back.
      expect((await pump.pump()).proposed).toBe(1);
    } finally { await f.close(); }
  });

  it('asks for a replay when a trigger policy is created or changed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-policy-replay-'));
    try {
      const repository = new FileCollaborationRepository(join(directory, 'collaboration')); await repository.init();
      const store = new FileCollaborationTriggerStore(join(directory, 'triggers')); await store.init();
      const onPoliciesChanged = vi.fn();
      const triggers = new CollaborationTriggerService(store, new CollaborationService(repository), undefined, { onPoliciesChanged });
      const scope = { owner: 'owner', tenantId: 'local' };
      await triggers.createPolicy({ id: 'policy.replay', name: 'Replay', enabled: false, eventTypes: ['review.completed'], action: { type: 'debate', participantAgentIds: ['agent.one', 'agent.two'] } }, scope);
      expect(onPoliciesChanged).toHaveBeenCalledTimes(1);
      await triggers.updatePolicy('policy.replay', { enabled: true }, scope);
      expect(onPoliciesChanged).toHaveBeenCalledTimes(2);
      const gate = new RunScanIdleGate();
      const before = gate.replayGeneration; const wakes = gate.generation;
      gate.replay();
      expect(gate.replayGeneration).toBe(before + 1);
      expect(gate.generation).toBe(wakes + 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects replay intervals outside the supported range', () => {
    const gate = new RunScanIdleGate();
    expect(() => gate.enable(60_000, { replayMs: 59_999 })).toThrow(/replay interval/);
    expect(() => gate.enable(60_000, { replayMs: 86_400_001 })).toThrow(/replay interval/);
    gate.enable(60_000, { replayMs: 0 });
    expect(gate.replayMs).toBe(0);
  });
});

describe('Idle passes outside the Run scanners', () => {
  function pass() {
    let now = 1_000_000;
    const gate = new RunScanIdleGate(() => now);
    return { gate, idle: new RunScanIdlePass(gate), advance(ms: number) { now += ms; } };
  }

  it('rests after a quiet whole pass and resumes after the rest or on a change', async () => {
    const p = pass(); p.gate.enable(60_000);
    const step = vi.fn(async () => true);
    expect(await p.idle.run(step)).toBe(true);
    expect(await p.idle.run(step)).toBe(false);
    p.advance(59_999); expect(await p.idle.run(step)).toBe(false);
    p.advance(1); expect(await p.idle.run(step)).toBe(true);
    expect(await p.idle.run(step)).toBe(false);
    p.gate.wake(); expect(await p.idle.run(step)).toBe(true);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('rests only once a multi-step pass finishes', async () => {
    const p = pass(); p.gate.enable(60_000);
    const steps = [false, false, true];
    const step = vi.fn(async () => steps.shift() ?? true);
    for (let i = 0; i < 3; i++) expect(await p.idle.run(step)).toBe(true);
    expect(await p.idle.run(step)).toBe(false);
  });

  it('does not rest after a pass during which a Run changed', async () => {
    const p = pass(); p.gate.enable(60_000);
    expect(await p.idle.run(async () => false)).toBe(true);
    p.gate.wake();
    expect(await p.idle.run(async () => true)).toBe(true);
    // That pass saw a change, so the next one runs; it is quiet and rests.
    expect(await p.idle.run(async () => true)).toBe(true);
    expect(await p.idle.run(async () => true)).toBe(false);
  });

  it('does not rest after a pass with a failed step, and rethrows the failure', async () => {
    const p = pass(); p.gate.enable(60_000);
    await expect(p.idle.run(async () => { throw new Error('board unavailable'); })).rejects.toThrow('board unavailable');
    expect(await p.idle.run(async () => true)).toBe(true);
    expect(await p.idle.run(async () => true)).toBe(true);
    expect(await p.idle.run(async () => true)).toBe(false);
  });

  it('never rests while the gate is disabled', async () => {
    const p = pass();
    for (let i = 0; i < 3; i++) expect(await p.idle.run(async () => true)).toBe(true);
    p.gate.enable(60_000); await p.idle.run(async () => true);
    p.gate.disable();
    expect(await p.idle.run(async () => true)).toBe(true);
  });
});
