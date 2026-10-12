import type { AdvanceRunActivityResult } from './activity.js';

export const maxStalledAdvances = 8;
export type RunAdvanceDecision = { kind: 'terminal' | 'wait' | 'advance'; stalled: number; delayMs: number };

/** Missing progress tokens (older APIs) cannot prove progress. Business waits,
 * including unknown provider outcomes, require explicit reconciliation/wake. */
export function decideRunAdvance(result: AdvanceRunActivityResult, previousProgress: string | undefined, stalled: number): RunAdvanceDecision {
  if (['succeeded', 'failed', 'cancelled'].includes(result.status)) return { kind: 'terminal', stalled: 0, delayMs: 0 };
  if (!['queued', 'planning', 'running', 'reviewing'].includes(result.status)) return { kind: 'wait', stalled: 0, delayMs: 0 };
  const nextStalled = result.progress !== undefined && result.progress !== previousProgress ? 0 : stalled + 1;
  if (nextStalled >= maxStalledAdvances) return { kind: 'wait', stalled: nextStalled, delayMs: 0 };
  return { kind: 'advance', stalled: nextStalled, delayMs: nextStalled === 0 ? 0 : Math.min(30_000, 1000 * 2 ** (nextStalled - 1)) };
}
