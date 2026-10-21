# Task working memory and single-entry conversation routing

## Implementation target — 2026-10-21

The user approved this direction after discussing Grok Bot's single-entry experience. The local Grok Bot export establishes ordered bot histories, message reply pointers and automation metadata, not a verified task/session routing algorithm. This implementation must not claim to reproduce proprietary internals.

### Separate identities

- An entry conversation owns discussion focus and message-to-task associations.
- A task conversation preserves the discussion and memory of one subject across executions.
- A Run owns a pinned execution, approval, budget and recovery state. Switching discussion does not approve, pause, resume or cancel a Run.
- Run-local nodes/branches are not entry conversations. Concurrent independent Runs are required; existing per-Run execution fencing must not be mistaken for concurrent node execution.

### Working memory

Use hierarchical task/event indexes, provenance-linked summaries and original material. Search is an access method over authorized indexes, summaries and originals, not a storage tier. Keep authoritative goal/approval/budget/pending-operation state and recent critical observations outside lossy summaries.

Originals remain available through bounded, scoped reads. Summary text is derived and untrusted; it cannot authorize operations, create evidence, promote facts to long-term memory, or make another Bot's private history visible. Summary generation uses the Run's pinned model, has its own durable call phase, and consumes real call/token/time budgets. Existing Runs opt out by default; existing frozen requests replay unchanged.

Each summary covers an immutable source range. Concurrent appends survive activation; stale results cannot replace a changed generation or revive a cancelled Run. Independent tasks must not share a mutable summary, global current-task variable or Bot-level serialization lock.

### Entry routing and focus

Resolution priority: explicit task selection / message reply, unambiguous task reference, current discussion continuation, otherwise clarification. Never guess execution targets from vague messages. Read-only side questions may target another task without changing main focus. Notifications carry task identity but do not steal focus. One message can discuss several tasks; general conversation need not create a task.

Persist routing decisions and corrections separately from immutable execution history. Filter unauthorized tasks before matching or returning candidate names. The entry state is scoped to its owner and conversation, not a process-global or Bot-global value. Concurrent submissions use repository transactions/version checks; delayed confirmations cannot silently overwrite a newer focus.

Routing by itself never executes a command. Explicit task-bound execution remains behind existing Run approval and command gates. Files, browser sessions and databases still require execution-layer resource coordination: memory isolation does not isolate external side effects.

## Acceptance cases

- Two tasks with conflicting facts under the same entry do not contaminate each other's prompts or search results.
- Explicit targets and reply pointers resolve correctly; conflicting selectors fail closed.
- A side question leaves the prior focus intact; an explicit switch changes it.
- Ambiguous `continue` with no reliable focus requests clarification and executes nothing.
- Notifications never change focus; replying to one resolves its task.
- Concurrent requests preserve both messages and version-safe focus changes; replays do not duplicate mutations.
- Another owner/tenant cannot discover task names, summaries or raw history.
- Summary generation preserves newly appended events, source provenance and recent results.
- Competing Engines do not duplicate dispatch/activation; restart uses frozen requests.
- Cancellation and unknown provider outcomes do not silently retry or activate late summaries.
- Summary/search/read budgets are bounded; original reads cannot escape the task's permitted source set.
- Existing pi adapter/accounting and legacy Run behavior remain covered by full regression tests.

## Verification status — 2026-10-21

Implemented as an opt-in v1 for new Runs (`workingMemory: { enabled: true }`). Old Runs remain unchanged and outstanding model requests retain their original format.

### Delivered components

- Durable conversation aggregate with File and Postgres adapters: owner/tenant scope, tasks, messages, focus, append-only routing corrections and idempotent execution reservations.
- Conversation service and HTTP API for creation, focus, discussion messages, task-bound Run creation, task notifications and crash recovery.
- Each task is backed by one AEEIS Thread; each explicit execution creates an independent Run. Task discussion notes are frozen into that Run as explicitly untrusted material and isolated by task.
- Run-scoped task working memory with immutable originals, compaction manifests/summaries, bounded `context.search`/`context.read`, live authorization fingerprints and owner-only diagnostics.
- Ordinary owner/share/debug Run projections omit raw working memory, compaction payloads and context-read results while retaining normal planner/executor/reviewer request diagnostics. The public Run response exposes only `workingMemoryEnabled`.
- Browser workbench support: task/focus display, discussion-only default, explicit Run creation, ambiguity choices, reply/correction actions, recovery of uncertain submissions and working-memory inspection.

### Automated verification

- Strict custom TypeScript check and production `tsc --noEmit`: passed.
- Production build (`tsc` + esbuild UI bundle): passed.
- Targeted regression: 155 passed and 6 skipped — 94 conversation-store, 15 conversation service/API, 12 UI, 31 durable working-memory runtime, 3 working-memory HTTP/security/projection tests; the 6 skipped tests require a real Postgres database.
- Full serial regression: **2441 passed, 133 skipped, 0 failed** across 197 test files (170 files ran, 27 skipped without external services).
- Default parallel-worker regression: the same **2441 passed, 133 skipped, 0 failed** result completed in 99.22 seconds.

### Offline browser verification

A local-only demo command is available:

```bash
npm run demo:working-memory
```

It generates an isolated temporary data directory, starts the deterministic fixture model and the built server with a scrubbed environment, and leaves `DATABASE_URL`, Temporal, production tokens and external model configuration unset. The 2026-10-21 browser run used loopback ports 4412/4413 and produced no browser console errors; observed browser requests were confined to `localhost:4412`.

The UI created two tasks in one entry, routed a side note without moving focus, created and approved an explicit Run, and completed the planner → executor → executor → executor → reviewer sequence successfully. The owner inspector showed one captured original for the `inspect` node, found the task marker in search, returned the bounded original text, and returned **0 matches** from the sibling `deliver` node. The small fixture source did not trigger model compaction; that path is covered by the durable runtime tests with synthetic large observations.

### Remaining boundaries

- Postgres conversation tests are implemented but were not run against a live database in this local pass.
- This does not deploy production, evaluate paid-model quality, resume Grok Bot migration, or implement the future Bot/DM/group layer.

