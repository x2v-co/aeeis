import { z } from 'zod';
import { isOwnedBy, type Ownership } from '../security/principal.js';
import type { AgentRun } from './contracts.js';
import type { ThreadFollowup, ThreadFollowupRepository } from './thread-followups.js';
import { digestProtocol } from '../protocol.js';
import { redactRunData } from './run-debug.js';

export const threadSchema = z.object({
  id: z.string().regex(/^thread_[a-f0-9-]{36}$/),
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200).optional(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type Thread = z.infer<typeof threadSchema>;
export interface ThreadRepository extends ThreadFollowupRepository {
  /** Optionally attach an existing unthreaded root in the same transaction. */
  createThread(thread: Thread, initialRunId?: string): Promise<void>;
  getThread(id: string, scope?: Ownership): Promise<Thread>;
  /** Sequence order, ascending; ownership is checked before applying limit. */
  listRunsByThread(id: string, scope?: Ownership, limit?: number, afterSequence?: number): Promise<AgentRun[]>;
  latestRunByThread(id: string, scope?: Ownership): Promise<AgentRun | undefined>;
  /** Persist a fully prepared run and its membership together, before dispatch.
   * The parent content hash binds the commit to the frozen history read.
   * Numeric revisions are accepted for legacy reservations. */
  createRunInThread(run: AgentRun, threadId: string, parentRunId?: string, scope?: Ownership, parentSnapshot?: string | number, followup?: ThreadFollowup): Promise<AgentRun>;
  /** First member has no parent; later members require an existing same-thread parent.
   * Sequence is allocated under the adapter lock. Repeating the same attachment is a no-op. */
  attachRunToThread(runId: string, threadId: string, parentRunId?: string, scope?: Ownership): Promise<AgentRun>;
}
export class ThreadConflict extends Error {}
export function validateThreadSequence(afterSequence: number): void {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > 2147483647) throw new RangeError('Invalid thread sequence cursor');
}
/** Bind history content, access, classification and isolation inputs while
 * allowing terminal bookkeeping (events, timestamps and Skill receipts).
 * Redact with the entire Run, as the history builder does: credentials in
 * otherwise excluded fields can still affect the copied prose. */
export function followupParentHash(run: AgentRun): string {
  const history = {
    id: run.id, owner: run.owner, tenantId: run.tenantId, goalId: run.goalId,
    threadId: run.threadId, parentRunId: run.parentRunId, threadSequence: run.threadSequence,
    goal: run.goal, privacy: run.privacy, context: run.context,
    plans: run.plans, review: run.review, answers: run.answers, artifacts: run.artifacts,
    toolReceipts: run.toolReceipts, delegationOutcomes: run.delegationOutcomes,
  };
  return digestProtocol({ history, redacted: redactRunData({ history, sourceValue: run }, { capFields: false }).history });
}
export function assertFollowupParent(parent: AgentRun | undefined, snapshot?: string | number): void {
  const unchanged = !parent || snapshot === undefined || (typeof snapshot === 'string' ? followupParentHash(parent) === snapshot : parent.revision === snapshot);
  if (parent && (!['succeeded', 'failed', 'cancelled'].includes(parent.status) || !unchanged))
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
