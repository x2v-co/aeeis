import { createHash } from 'node:crypto';

/** JSONB and other stores may reorder object keys. Hash the canonical form so
 * pins, plans, receipts and idempotency checks survive a persistence roundtrip. */
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonicalize(nested)]));
  return value;
}
