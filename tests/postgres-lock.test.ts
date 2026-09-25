import { describe, expect, it } from 'vitest';
import { postgresAdvisoryLockKeys } from '../src/adapters/postgres-lock.js';

describe('PostgreSQL advisory lock keys', () => {
  it('derives deterministic signed int32 pairs from a namespace and value', () => {
    const first = postgresAdvisoryLockKeys('aeeis-task-reconcile', 'owner\0tenant');
    expect(first).toEqual(postgresAdvisoryLockKeys('aeeis-task-reconcile', 'owner\0tenant'));
    expect(first).toHaveLength(2);
    for (const key of first) {
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });

  it('keeps namespaces independent', () => {
    expect(postgresAdvisoryLockKeys('aeeis-task-reconcile', 'owner\0tenant'))
      .not.toEqual(postgresAdvisoryLockKeys('aeeis-projection', 'owner\0tenant'));
  });
});
