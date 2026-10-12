import { describe, expect, it } from 'vitest';
import { isBootRecoverableRun } from '../src/runtime/dispatcher.js';

describe('boot recovery run filter', () => {
  it('wakes only runs a worker can advance', () => {
    for (const s of ['queued', 'planning', 'running', 'reviewing']) expect(isBootRecoverableRun(s)).toBe(true);
  });
  it('never restarts terminal or waiting runs (closed workflow IDs are reusable in Temporal)', () => {
    for (const s of ['failed', 'succeeded', 'cancelled', 'unknown', 'waiting_external', 'needs_input', 'needs_approval', 'paused']) expect(isBootRecoverableRun(s)).toBe(false);
  });
});
