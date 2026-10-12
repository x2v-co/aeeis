import { describe, expect, it } from 'vitest';
import { decideRunAdvance, maxStalledAdvances } from '../src/temporal/run-advance.js';

describe('run advance scheduling', () => {
  it.each(['succeeded', 'failed', 'cancelled'])('ends terminal %s runs', status => {
    expect(decideRunAdvance({ status }, undefined, 0).kind).toBe('terminal');
  });
  it.each(['unknown', 'needs_approval', 'needs_input', 'waiting_external', 'paused', 'unrecognized'])('parks %s until wake', status => {
    expect(decideRunAdvance({ status }, undefined, 0).kind).toBe('wait');
  });
  it.each(['queued', 'planning', 'running', 'reviewing'])('backs off unchanged %s and bounds automatic attempts', status => {
    let stalled = 0;
    const delays: number[] = [];
    for (let index = 0; index < maxStalledAdvances; index++) {
      const decision = decideRunAdvance({ status, progress: 'same' }, 'same', stalled);
      stalled = decision.stalled;
      if (index < maxStalledAdvances - 1) {
        expect(decision.kind).toBe('advance'); delays.push(decision.delayMs);
      } else expect(decision.kind).toBe('wait');
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(decideRunAdvance({ status, progress: 'new' }, 'same', stalled)).toEqual({ kind: 'advance', stalled: 0, delayMs: 0 });
  });
  it.each(['queued', 'planning', 'running', 'reviewing'])('keeps advancing legacy %s responses without progress tokens', status => {
    let stalled = maxStalledAdvances;
    for (let index = 0; index < maxStalledAdvances * 2; index++) {
      const decision = decideRunAdvance({ status }, 'previous-token', stalled);
      stalled = decision.stalled;
      expect(decision).toEqual({ kind: 'advance', stalled: 0, delayMs: 0 });
    }
  });
});
