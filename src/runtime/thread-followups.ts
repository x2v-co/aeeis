import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type { Ownership } from '../security/principal.js';
import { requestSchema, type AgentRun } from './contracts.js';
import type { ThreadHistory } from './thread-history.js';
import { ThreadConflict } from './threads.js';

const canonicalize = createRequire(import.meta.url)('canonicalize') as (value: unknown) => string | undefined;

export const idempotencyKeySchema = z.string().min(1).max(256).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'Invalid Idempotency-Key');
export type FollowupRequest = { request: z.infer<typeof requestSchema>; parentRunId?: string; contextBudgetBytes: number };
/** Only hashes of caller keys are durable. An unfinished reservation is never a
 * Run and cannot be discovered by dispatch/reconcile scanners. */
export interface ThreadFollowup {
  threadId: string;
  keyHash: string;
  requestHash: string;
  runId: string;
  state: 'reserved' | 'completed';
  request: FollowupRequest;
  parentRunId?: string;
  parentRevision?: number;
  contextSnapshot: {
    history?: ThreadHistory;
    run?: AgentRun;
    preparation?: Record<string, { state: 'started' | 'completed'; value?: unknown }>;
  };
  createdAt: string;
}
export interface ThreadFollowupRepository {
  /** Serialize initialization across API processes without holding a DB transaction
   * across context retrieval or provider calls. Callbacks may use the repository. */
  withThreadFollowupLock<T>(threadId: string, keyHash: string, scope: Ownership, operation: () => Promise<T>): Promise<T>;
  getThreadFollowup(threadId: string, keyHash: string, scope: Ownership): Promise<ThreadFollowup | undefined>;
  saveThreadFollowup(record: ThreadFollowup, scope: Ownership): Promise<void>;
  pendingThreadFollowups(): AsyncIterable<ThreadFollowup>;
}
export function followupHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)!).digest('hex');
}
export function followupRunId(threadId: string, keyHash: string, scope: Ownership): string {
  const hex = followupHash({ ...scope, threadId, keyHash }).slice(0, 32);
  return `run_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function assertSameFollowup(record: ThreadFollowup, requestHash: string): void {
  if (record.requestHash !== requestHash) throw new ThreadConflict('Idempotency-Key was already used with different input');
}
export function assertFollowupCheckpoint(before: ThreadFollowup | undefined, after: ThreadFollowup): void {
  if (after.state !== 'reserved') throw new ThreadConflict('Only reserved follow-ups may be checkpointed');
  if (!before) return;
  assertSameFollowup(before, after.requestHash);
  if (before.state === 'completed') throw new ThreadConflict('Follow-up is already completed');
  const identity = ({ contextSnapshot: _snapshot, ...record }: ThreadFollowup) => record;
  if (followupHash(identity(before)) !== followupHash(identity(after))) throw new ThreadConflict('Follow-up reservation identity is immutable');
  // JSONB reorders object keys; compare canonical contents rather than the
  // serialization order used by in-place Run mutation checks.
  if (before.contextSnapshot.history && (!after.contextSnapshot.history || followupHash(before.contextSnapshot.history) !== followupHash(after.contextSnapshot.history))) throw new ThreadConflict('Thread history snapshot is immutable');
  if (before.contextSnapshot.run && (!after.contextSnapshot.run || followupHash(before.contextSnapshot.run) !== followupHash(after.contextSnapshot.run))) throw new ThreadConflict('Prepared follow-up is immutable');
  for (const [stage, result] of Object.entries(before.contextSnapshot.preparation ?? {})) {
    const next = after.contextSnapshot.preparation?.[stage];
    if (result.state === 'completed' && (!next || followupHash(result) !== followupHash(next))) throw new ThreadConflict('Completed preparation checkpoint is immutable');
  }
}
export function assertFollowupCommit(record: ThreadFollowup, run: AgentRun, threadId: string, parentRunId?: string): void {
  if (record.state !== 'reserved' || record.threadId !== threadId || record.runId !== run.id || record.parentRunId !== parentRunId
    || !record.contextSnapshot.run || followupHash(record.contextSnapshot.run) !== followupHash(run)) throw new ThreadConflict('Invalid follow-up reservation commit');
}
/** File/memory locks are separate from the writer queue: preparation reads and
 * checkpoint writes re-enter the repository while the same-key lock is held. */
export class FollowupLocks {
  private jobs = new Map<string, Promise<unknown>>();
  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const work = (this.jobs.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.jobs.set(key, work);
    try { return await work; }
    finally { if (this.jobs.get(key) === work) this.jobs.delete(key); }
  }
}

// Keep in sync with src/adapters/migrations/003-thread-followups.sql.
export const threadFollowupsMigration = `CREATE TABLE IF NOT EXISTS aeeis_thread_followups (
  thread_id text NOT NULL REFERENCES aeeis_threads(id),
  key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  run_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('reserved', 'completed')),
  request jsonb NOT NULL,
  parent_run_id text REFERENCES aeeis_runs(id),
  parent_revision integer,
  context_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (thread_id, key_hash)
);
CREATE INDEX IF NOT EXISTS aeeis_thread_followups_pending_idx ON aeeis_thread_followups(thread_id, key_hash) WHERE state='reserved';`;
