import type pg from 'pg';
import { openBrainState, sealBrainState } from './adapters/postgres-brain-store.js';
import { sealConversation } from './adapters/conversation-store.js';
import { sealMemory } from './adapters/postgres-store.js';
import { contentEncryption, isSealed, sealAggregate, SEALED } from './content-encryption.js';
import { sealRun } from './runtime/repository.js';
import { sealEvent } from './session-events.js';
import { brainStateSchema } from './brain.js';

/**
 * Encrypts rows written before a key was configured. Reads already accept both
 * forms, so this can run in the background while the service is up. Each row is
 * replaced only if it is still exactly the plaintext that was read; a row the
 * application rewrote in the meantime is already sealed. Change-audit history is
 * append-only and is not rewritten; see the runbook.
 */
interface Target {
  table: string;
  column: string;
  /** Extra columns the sealer needs. */
  select?: string;
  from?: string;
  seal(value: any, row: Record<string, any>): Promise<unknown>;
}

const TARGETS: Target[] = [
  { table: 'aeeis_runs', column: 'state', seal: value => sealRun(value) },
  { table: 'aeeis_conversations', column: 'state', seal: value => sealConversation(value) },
  { table: 'aeeis_session_events', column: 'state', seal: value => sealEvent(value) },
  { table: 'aeeis_memories', column: 'state', seal: value => sealMemory(value) },
  { table: 'aeeis_run_events', column: 'data', select: 'tenant_id, event_id', seal: (value, row) => sealAggregate('run-event', row.tenant_id, row.event_id, value) },
  { table: 'aeeis_thread_followups', column: 'request', select: 'f.thread_id, f.key_hash, t.tenant_id', from: 'aeeis_thread_followups f JOIN aeeis_threads t ON t.id = f.thread_id', seal: (value, row) => sealAggregate('followup-request', row.tenant_id, `${row.thread_id}:${row.key_hash}`, value) },
  { table: 'aeeis_thread_followups', column: 'context_snapshot', select: 'f.thread_id, f.key_hash, t.tenant_id', from: 'aeeis_thread_followups f JOIN aeeis_threads t ON t.id = f.thread_id', seal: (value, row) => sealAggregate('followup-context', row.tenant_id, `${row.thread_id}:${row.key_hash}`, value) },
];

export interface BackfillCounts { [table: string]: { sealed: number; remaining: number } }

async function exists(pool: pg.Pool, table: string): Promise<boolean> {
  return Boolean((await pool.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [table])).rows[0]?.name);
}

/** Rows still in plaintext, per table and column. */
export async function plaintextCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const target of TARGETS) {
    if (!await exists(pool, target.table)) continue;
    const alias = target.from ? 'f.' : '';
    const result = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${target.from ?? target.table} WHERE jsonb_typeof(${alias}${target.column}) = 'object' AND NOT (${alias}${target.column} ? '${SEALED}')`);
    counts[`${target.table}.${target.column}`] = Number(result.rows[0]!.n);
  }
  if (await exists(pool, 'aeeis_brain_state')) {
    const result = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM aeeis_brain_state, jsonb_array_elements(state->'claims') claim WHERE NOT starts_with(claim->>'content', 'aeeis-enc/1:')`);
    counts['aeeis_brain_state.claims'] = Number(result.rows[0]!.n);
  }
  return counts;
}

/** One batch per target. Returns how many rows were sealed; call again until it returns 0. */
export async function backfillBatch(pool: pg.Pool, limit = 100): Promise<number> {
  if (!contentEncryption()) return 0;
  let sealed = 0;
  for (const target of TARGETS) {
    if (!await exists(pool, target.table)) continue;
    const alias = target.from ? 'f.' : '';
    const rows = await pool.query<Record<string, any>>(`SELECT ${alias}ctid::text AS row_ctid, ${alias}${target.column} AS value${target.select ? `, ${target.select}` : ''}
      FROM ${target.from ?? target.table} WHERE jsonb_typeof(${alias}${target.column}) = 'object' AND NOT (${alias}${target.column} ? '${SEALED}') LIMIT $1`, [limit]);
    for (const row of rows.rows) {
      const next = await target.seal(row.value, row);
      if (!isSealed(next)) continue;
      const result = await pool.query(`UPDATE ${target.table} SET ${target.column}=$1 WHERE ctid=$2::tid AND ${target.column}=$3::jsonb`, [next, row.row_ctid, row.value]);
      sealed += result.rowCount ?? 0;
    }
  }
  if (await exists(pool, 'aeeis_brain_state')) {
    const row = (await pool.query<{ revision: string; state: any }>('SELECT revision, state FROM aeeis_brain_state WHERE id=1')).rows[0];
    const plain = row?.state?.claims?.some((claim: { content?: string }) => !String(claim.content ?? '').startsWith('aeeis-enc/1:'));
    if (row && plain) {
      const next = await sealBrainState(brainStateSchema.parse(await openBrainState(row.state)));
      const result = await pool.query('UPDATE aeeis_brain_state SET state=$1 WHERE id=1 AND revision=$2', [next, row.revision]);
      sealed += result.rowCount ?? 0;
    }
  }
  return sealed;
}

/** Runs batches until nothing is left or `stop()` says so. */
export async function backfillContent(pool: pg.Pool, options: { batch?: number; pauseMs?: number; stop?: () => boolean; onProgress?: (sealed: number) => void } = {}): Promise<number> {
  let total = 0;
  while (!options.stop?.()) {
    const sealed = await backfillBatch(pool, options.batch ?? 100);
    if (!sealed) break;
    total += sealed;
    options.onProgress?.(total);
    if (options.pauseMs) await new Promise(resolve => setTimeout(resolve, options.pauseMs));
  }
  return total;
}
