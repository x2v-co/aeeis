import { createHash } from 'node:crypto';

/**
 * Derive PostgreSQL's two-int advisory-lock key from a namespaced value.
 *
 * A single `hashtext()` key is only 32 bits and can make unrelated tenants,
 * accounts or projection events block one another after a collision. The
 * two-key form gives us the first 64 bits of SHA-256 while keeping parameters
 * native signed int32 values accepted by node-postgres.
 */
export function postgresAdvisoryLockKeys(namespace: string, value: string): [number, number] {
  const digest = createHash('sha256').update(`${namespace}\0${value}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function postgresAdvisoryXactLock(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, namespace: string, value: string): Promise<void> {
  const [key1, key2] = postgresAdvisoryLockKeys(namespace, value);
  await client.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [key1, key2]);
}
