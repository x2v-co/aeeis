# Cross-run conversation threads

Threads group independent runtime `AgentRun`s. A follow-up creates a new run;
`needs_input` and `/api/runs/:id/answer` continue to answer a question in the
existing run. Threads are separate from domain Goals, Room session contexts,
and Project Pulse's `followUpPlanId`.

## PR 1 — storage (this change)

`aeeis_threads`: `id text PRIMARY KEY` (`thread_<uuid>`), `owner text NOT NULL`,
`tenant_id text NOT NULL`, optional `title text`, `created_at timestamptz NOT NULL`.
There is an owner/tenant index. A thread may initially be empty; its immutable
metadata does not require an independently committed run counter or timestamp.

Add nullable `thread_id text REFERENCES aeeis_threads(id)`,
`parent_run_id text REFERENCES aeeis_runs(id)`, and `thread_sequence integer`
to `aeeis_runs`. Mirror these as optional `threadId`, `parentRunId`, and
`threadSequence` in `AgentRun` JSON (schemaVersion remains 1). A partial unique
index on `(thread_id, thread_sequence)` orders members and prevents duplicates.
A CHECK requires either all membership fields NULL or a thread and positive
sequence; self-parenting is forbidden. Foreign keys prevent deleting referenced
threads or parents. There is no new delete operation.

`RunRepository` extends `ThreadRepository` with `createThread`, `getThread`,
`listRunsByThread` (ascending sequence, optional limit), and
`attachRunToThread(runId, threadId, parentRunId?, scope?)`. Scope means both owner
and tenant; inaccessible IDs raise `NotFound`, including for an empty thread.
Every member must have the thread's ownership. The first member is sequence 1
with no parent; later members require an earlier same-thread parent. Branches
are allowed but sequence is the immutable append order. Membership cannot be
changed through ordinary `create`/`mutate`, moved, or detached. An identical
attachment retry returns the original run without changing revision or sequence.

PostgreSQL locks the thread row, then the attaching run row, validates the
parent, and assigns `MAX(thread_sequence)+1`. Columns, JSON, revision and
updatedAt commit together; ordinary run mutations preserve membership. File
mode uses its existing writer lock, serial queue and atomic replacements:
`thread_<uuid>.json` stores metadata, canonical run JSON stores membership, and
the disposable run index (version 3) accelerates thread lookup. Sequence is
derived from committed runs, so no two-file counter commit is needed. An
in-memory run adapter implements the same contract with copied records.

Migration `002-threads.sql` and the matching exported SQL constant are applied
after 001 in `PostgresRunRepository.init`, inside the existing
`withPostgresMigrationLock(pool, 'runs', ...)` transaction. DDL is repeatable;
constraints are checked by name and relation. Nullable columns have no defaults:
no run backfill, JSON rewrite, new automatic thread, or schema-version bump.
The membership CHECK is installed `NOT VALID` to avoid scanning historical runs;
it still enforces new writes. Index builds require ordinary PostgreSQL DDL locks;
schedule bootstrap during deployment with the existing migration runbook and
check lock duration on a production-sized copy. Roll back application code
without dropping columns/tables. Once threads are enabled, old writers must not
mutate threaded runs: they do not enforce the new membership invariant.

Tests share ownership, attachment, retry, ordering, branching, concurrent append,
and immutable membership cases across memory/file/PostgreSQL. File restart and
index rebuild preserve membership. PostgreSQL tests exercise two adapters,
column/JSON agreement, repeated/concurrent bootstrap and old rows/shares.

## PR 2 — authenticated API and frozen history

Add an application thread service over the runtime repository; leave the domain
`AeeisService` Goal/context policy intact. `POST /api/threads` accepts
`{title?, initialRunId?}`, returning 201 with thread metadata. If supplied,
attach an owner-scoped, unthreaded existing run as root. Validate before creating
the thread; use a repository transaction for creation plus root attachment so
failures cannot leave unexpected partial state. Empty threads are valid.

`POST /api/threads/:id/runs` accepts `{request: <existing run request>,
parentRunId?, contextBudgetBytes?}` and returns 202 with
`{id, threadId, parentRunId?, threadSequence, context}`. Default parent is the
latest member; an empty thread creates a root with no historical context.
For a nonempty thread require a terminal (`succeeded`, `failed`, `cancelled`)
parent; a live parent's question is still answered through `/answer`. Authorize
as resource owner in the HTTP auth hook. Follow-ups retain normal planning,
approval, tool/model budgets and capabilities; do not inherit approvals or
tool/agent permissions. Reject requests whose privacy would disclose parent
context beyond its classification. Add atomic create-and-attach support before
exposing this route so recovery never dispatches a partially linked run.

`GET /api/threads/:id?limit=50&afterSequence=<n>` returns thread metadata and
compact runs ordered ascending with a sequence cursor (default 50, max 100).
Add storage-side cursor selection, not whole-thread loading. Include normal run
links for full owner reads. Wrong owner/tenant or malformed ID returns 404;
invalid input returns 400 and conflicting attachment/parent state returns 409.
Existing `/api/runs` creation and run views remain usable without threads.

History is a frozen, versioned snapshot on the new run, not a dynamic query at
every model call. Traverse the selected parent's ancestry, excluding sibling
branches and later sequences. Include bounded prior goals, latest plan/review
summaries, answers and final artifact excerpts with run/ref IDs and hashes;
exclude raw model calls, credentials, environments and complete tool payloads.
Default history budget is **32 KiB UTF-8**, configurable downward per request
and capped at **64 KiB** by server configuration. This is an explicit byte
budget, not an inaccurate token guarantee, and remains separate from modelUsage
and modelBudget. Visit at most 20 ancestors, at most 8 final artifacts per run;
each excerpt is at most 8 KiB. Prefer the immediate parent then newest ancestors;
serialize included entries chronologically. Count envelope/IDs/markers in the
budget, truncate at UTF-8 boundaries, and record omitted/truncated counts. Stop
retrieval when limits are reached. Persist policy version, source IDs/revisions,
hash, actual byte count, budget and exclusions for reproducibility.
Also cap the rendered history input at 65,536 characters, including tag escaping,
outer JSON string escaping and source metadata, to leave room under the runtime's
120,000-character request limit. Select/truncate excerpts against both limits
before freezing the snapshot.

## PR 3 — planner/worker context and redaction

Build the snapshot from authorized runs, then reuse `redactRunData` and
`capDebugField` from `runtime/run-debug.ts` before budgeting and persistence.
Pass a credential-source envelope through redaction so secrets found in omitted
credential/environment fields are also removed from copied prose. Select
allowed fields explicitly; the debug exporter itself is not a history schema.
Redaction removes secrets; it does not grant access or lower classification.
Honor existing source classifications, exclude isolated tool/delegation evidence,
and never widen Goal/Room audience access. A thread alone grants no Room rights.
Persist transitive Goal and memory-manifest access provenance in the immutable
snapshot independently of excerpt selection, and authorize every requirement
against live domain ACLs before copying derived prose. Carry all requirements
forward even when the original ancestor is omitted. Recover missing provenance
from legacy follow-up ancestry independently of history budgets and excerpt limits.

Inject the same frozen `threadHistory` into planner, executor and reviewer inputs
in `AgentEngine`; label excerpts as untrusted historical evidence with provenance.
Expose history excerpts through the existing source/evidence mechanism so workers
can cite only presented IDs. The latest goal is authoritative; history cannot
grant capabilities or substitute old plan approval. Pin/hash the snapshot before
the first model call so retry/reconciliation has identical input. Threadless runs
keep their current prompt/input shape. Add secret/prose/URL tests, classification
tests, budget tests (including multibyte text), and planner/worker retry coverage.

## PR 4 — idempotent follow-ups and Temporal linkage

Require `Idempotency-Key` for follow-up POST. Add a durable reservation table
`aeeis_thread_followups(thread_id, key_hash, request_hash, run_id, state,
context_snapshot, created_at)` with primary key `(thread_id, key_hash)` and
unique `run_id`; hash keys rather than storing secrets. The normalized request
hash includes requested parent/default-parent intent and budget. Atomically
reserve a deterministic run ID, resolve/freeze the parent/history once, then
create and attach the run with the reservation completed in the same commit.
Retries return that run and snapshot even after the thread advances; different
input for the same key returns 409. No second sequence or preparation is permitted
after a Run commits. Completed preparation checkpoints are reused, including
Brain reads and semantic searches with their persisted audit. A preparation
operation that throws is checkpointed as failed and may be retried with the same
key before any Run commits; other completed results and the frozen history remain
unchanged. An interruption between a provider result and checkpoint publication
leaves an ambiguous started stage, which is not automatically resent. Global
connector budget reservations retain their existing reconciliation rules.
New reservations store an immutable parent history content hash in the context
snapshot. Check it at initialization and under the commit lock; terminal event
bookkeeping and Skill outcome receipts do not invalidate it. Content, access,
classification, isolation and credential redaction inputs remain bound. Legacy
reservations without this hash retain their revision check.
Serialize same-key initialization and provide durable recovery for reserved
requests; no external connector call inside a database transaction.
File mode needs a recoverable reservation journal under its writer lock.

Commit before dispatch. Use the existing `Dispatcher.notify(newRunId)` and
`notifyTemporalRunWorkflow` race handling: one independent `agentRunWorkflow`
per run, workflowId = run ID. Thread/parent links are durable run data and optional
search metadata, not Temporal child workflows or continued parent executions.
Completed parents remain completed. Activities still call
`/internal/runs/:id/advance`; approval and `/answer` wake the new run's workflow.
Use existing boot/reconcile recovery for a crash between commit and notify;
reservation recovery must finish membership before making the run dispatchable.
Keep existing workflow arguments/history unchanged; version any later workflow
command changes with `patched` and replay tests. Test concurrent POST, lost
response, changed body, failed notify/restart, and local/Temporal parity.

## PR 5 — thread UI and shares

Serve the existing SPA at `/threads/<id>` and add authenticated sequence timeline,
run status/output excerpts, parent links, pagination and a follow-up form. Link
threaded runs back to their thread. Surface `needs_input` with the existing answer
control; the follow-up form selects a terminal parent. Poll/SSE current runs using
existing run routes. Keep URL routing, login return paths, rendering sanitization,
and bearer-token storage consistent with `src/ui/app.ts` and `runtime/http.ts`.

Add `aeeis_thread_shares` with id, unique token_hash, thread_id FK, expires_at,
revoked_at, created_at and **through_sequence**. Use existing 32-byte opaque token,
hashing, TTL and revocation patterns from `run-shares.ts`; separate tables/lookup
prevent confusion with run share tokens. `POST /api/threads/:id/share` captures
the current maximum sequence, GET `/api/threads/:id/shares` lists owner shares,
and DELETE `/api/threads/:id/share/:shareId` revokes. `/share/<token>` resolves
either token kind; `/api/share/:token` returns a discriminated read-only view.
A thread token reveals redacted views only through its captured sequence,
including subsequent status changes to those runs. Later follow-ups require a
new share, so sharing never silently exposes future runs. Exclude private and
confidential runs and history from thread shares; a share conveys no write,
follow-up, artifact URL or underlying owner-route authority. Redact the combined
view again; expire/revoke to 404, `no-store`, preserve existing CSP/referrer policy.
Existing individual run shares retain their semantics.

## PR 6 — docs, exports and end-to-end verification

Document the difference between answers and follow-ups, budget/omission policy,
owner/privacy boundaries, snapshot share cutoff and migration/recovery procedure.
Extend `scripts/fetch-run.mjs` for bare thread IDs and `/threads/<id>` using
`/api/threads/:id/debug-bundle`; thread share debug export keeps
`/api/share/:token/debug-bundle` with a new discriminated bundle schema. Preserve
HTTPS/loopback restrictions, configured-origin token protection, no redirects,
32 MiB export cap, 0600 files and existing run bundle format. Page/bound thread
exports and include provenance/cutoff metadata.

E2E: root run → finish → follow-up uses redacted evidence → independent approval
and execution → file/API/worker restart → same-key replay → thread timeline and
snapshot share → later run excluded → revocation. Cover branch selection,
wrong owner/tenant, private context, needs_input answers, both dispatchers and
pre-thread data. Each PR runs Node 22 typecheck, focused tests and `npm test`;
PostgreSQL uses isolated test schemas and Temporal uses replay/version tests.
