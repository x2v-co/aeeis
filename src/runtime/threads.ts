import { z } from 'zod';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import type { AgentRun } from './contracts.js';

export const threadSchema = z.object({
  id: z.string().regex(/^thread_[a-f0-9-]{36}$/),
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200).optional(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type Thread = z.infer<typeof threadSchema>;
export interface ThreadRepository {
  /** Optionally attach an existing unthreaded root in the same transaction. */
  createThread(thread: Thread, initialRunId?: string): Promise<void>;
  getThread(id: string, scope?: Ownership): Promise<Thread>;
  /** Sequence order, ascending; ownership is checked before applying limit. */
  listRunsByThread(id: string, scope?: Ownership, limit?: number, afterSequence?: number): Promise<AgentRun[]>;
  latestRunByThread(id: string, scope?: Ownership): Promise<AgentRun | undefined>;
  /** Persist a fully prepared run and its membership together, before dispatch.
   * The parent revision binds the commit to the frozen history read. */
  createRunInThread(run: AgentRun, threadId: string, parentRunId?: string, scope?: Ownership, parentRevision?: number): Promise<AgentRun>;
  /** First member has no parent; later members require an existing same-thread parent.
   * Sequence is allocated under the adapter lock. Repeating the same attachment is a no-op. */
  attachRunToThread(runId: string, threadId: string, parentRunId?: string, scope?: Ownership): Promise<AgentRun>;
}
export class ThreadConflict extends Error {}
export function validateThreadSequence(afterSequence: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > 2147483647) throw new RangeError('Invalid thread sequence cursor');
}
export function assertFollowupParent(parent: AgentRun | undefined, revision?: number): void {
  if (parent && (!['succeeded', 'failed', 'cancelled'].includes(parent.status) || (revision !== undefined && parent.revision !== revision)))
    throw new ThreadConflict('Parent must be terminal and unchanged since the history snapshot; answer live questions through /answer');
}
type Membership = { threadId?: string | undefined; parentRunId?: string | undefined; threadSequence?: number | undefined };
export function assertMembershipUnchanged(before: Membership, after: Membership): void {
  if (before.threadId !== after.threadId || before.parentRunId !== after.parentRunId || before.threadSequence !== after.threadSequence)
    throw new ThreadConflict('Run thread membership is immutable; use attachRunToThread');
}
export function assertUnthreaded(run: Membership): void { assertMembershipUnchanged({}, run); }
/** Returns false for an identical retry. No caller-provided sequence is accepted. */
export function prepareAttachment(run: AgentRun, thread: Thread, parent: AgentRun | undefined, lastSequence: number): boolean {
  if (!isOwnedBy(run, thread) || (parent && !isOwnedBy(parent, thread))) throw new ThreadConflict('Thread members must have the same owner and tenant');
  if (run.threadId !== undefined) {
    if (run.threadId === thread.id && run.parentRunId === parent?.id) return false;
    throw new ThreadConflict('Run already belongs to a thread');
  }
  assertUnthreaded(run);
  if (parent && (parent.id === run.id || parent.threadId !== thread.id || parent.threadSequence === undefined || parent.threadSequence > lastSequence))
    throw new ThreadConflict('Parent must be an earlier member of the same thread');
  if ((lastSequence === 0) !== (parent === undefined)) throw new ThreadConflict('Only the first thread run may have no parent');
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0 || lastSequence >= 2147483647) throw new ThreadConflict('Thread sequence exhausted');
  run.threadId = thread.id;
  run.threadSequence = lastSequence + 1;
  if (parent) run.parentRunId = parent.id;
  run.revision++;
  run.updatedAt = new Date().toISOString();
  return true;
}

// Applied by PostgresRunRepository.init under withPostgresMigrationLock('runs').
// Keep in sync with src/adapters/migrations/002-threads.sql.
export const threadsMigration = `CREATE TABLE IF NOT EXISTS aeeis_threads (
  id text PRIMARY KEY, owner text NOT NULL, tenant_id text NOT NULL,
  title text, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS aeeis_threads_owner_idx ON aeeis_threads(tenant_id, owner, created_at, id);
ALTER TABLE aeeis_runs
  ADD COLUMN IF NOT EXISTS thread_id text REFERENCES aeeis_threads(id),
  ADD COLUMN IF NOT EXISTS parent_run_id text REFERENCES aeeis_runs(id),
  ADD COLUMN IF NOT EXISTS thread_sequence integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='aeeis_runs_thread_membership_check' AND conrelid='aeeis_runs'::regclass) THEN
    ALTER TABLE aeeis_runs ADD CONSTRAINT aeeis_runs_thread_membership_check CHECK (
      (thread_id IS NULL AND parent_run_id IS NULL AND thread_sequence IS NULL)
      OR (thread_id IS NOT NULL AND thread_sequence IS NOT NULL AND thread_sequence > 0
        AND (parent_run_id IS NULL OR parent_run_id <> id))
    ) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS aeeis_runs_thread_sequence_idx ON aeeis_runs(thread_id, thread_sequence) WHERE thread_id IS NOT NULL;`;
