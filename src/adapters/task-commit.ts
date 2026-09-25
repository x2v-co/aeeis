import { isDeepStrictEqual } from 'node:util';
import type { MemoryEntry, Plan, Room, RunReceipt } from '../contracts.js';

export class PlanWriteConflict extends Error {}
export class RoomWriteConflict extends Error {}
export class MemoryWriteConflict extends Error {}

export function assertMemoryCommit(current: MemoryEntry | undefined, expected: MemoryEntry, next: MemoryEntry): void {
  if (!current || !isDeepStrictEqual(current, expected)) throw new MemoryWriteConflict('Memory changed during update');
  if (next.id !== expected.id || next.goalId !== expected.goalId || (next.owner ?? 'owner') !== (expected.owner ?? 'owner') || (next.tenantId ?? 'local') !== (expected.tenantId ?? 'local')) {
    throw new Error('Memory update must preserve identity');
  }
}

export function assertRoomCommit(current: Room | undefined, expected: Room, next: Room): void {
  if (!current || !isDeepStrictEqual(current, expected)) throw new RoomWriteConflict('Room changed during update');
  if (next.id !== expected.id || next.owner !== expected.owner || next.tenantId !== expected.tenantId || next.createdAt !== expected.createdAt) {
    throw new Error('Room update must preserve identity');
  }
}

/** Compare the complete snapshot, including node attempts, inside the store's
 * write boundary. Plan.version identifies the immutable DAG, not state writes. */
export function assertTaskCommit(current: Plan | undefined, expected: Plan, next: Plan, receipt: RunReceipt): void {
  if (!current || !isDeepStrictEqual(current, expected)) throw new PlanWriteConflict('Plan changed during task transition');
  if (next.id !== expected.id || next.goalId !== expected.goalId || next.version !== expected.version || receipt.planId !== expected.id) {
    throw new Error('Task commit must preserve plan identity');
  }
}
