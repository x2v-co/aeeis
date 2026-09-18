import { isDeepStrictEqual } from 'node:util';
import type { Plan, RunReceipt } from '../contracts.js';

export class PlanWriteConflict extends Error {}

/** Compare the complete snapshot, including node attempts, inside the store's
 * write boundary. Plan.version identifies the immutable DAG, not state writes. */
export function assertTaskCommit(current: Plan | undefined, expected: Plan, next: Plan, receipt: RunReceipt): void {
  if (!current || !isDeepStrictEqual(current, expected)) throw new PlanWriteConflict('Plan changed during task transition');
  if (next.id !== expected.id || next.goalId !== expected.goalId || next.version !== expected.version || receipt.planId !== expected.id) {
    throw new Error('Task commit must preserve plan identity');
  }
}
