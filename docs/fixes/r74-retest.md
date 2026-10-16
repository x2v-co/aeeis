# r74 retest follow-ups (b9a97f9, sg, 2026-10-16)

Compared against r62 (e62e258). Evidence: SRE's r74 compare report and per-run events.

## 1. Mid-stream / transport retries exceeded the 420 s per-call cap (pdf1 600003 ms, txt 555 s)
`requestCompletion` used `AEEIS_MODEL_CALL_BUDGET_MS` (600 s) as the wall-clock budget and only
capped each *attempt* at `request.timeoutMs`. A retry started at 277 s therefore ran until 600 s.
Now the budget is `min(callBudgetMs, request.timeoutMs)`, shared by every attempt of one
`complete()` (length retry, midstream retry, transport retry). The midstream-retry budget check
uses the same value.

## 2. First executor call timed out with nothing retained → run.failed (chifeng, json)
New branch after `preserveRunOutput` fails on an executor timeout:
- First time for that task, and the Run still has ≥ `AEEIS_MODEL_CALL_MIN_MS` model time left
  after the review reserve and a call left: `model.timeout_retry`, the step is retried once
  (`step.timeoutRetried`). Run stays `running`.
- Retry also times out (or no budget): a placeholder artifact states explicitly what is unknown
  ("Unknown: task ... produced no model output ..."), Run ends `succeeded` + partial
  (`run.partial {noOutput:true}`). No review (there is nothing to review).
Planner timeouts are unchanged (still fail). No model fallback was added.

## 3. csv: review.requested left dangling after the call budget ran out
- `execute()` no longer opens a review when no model call is left: `review.skipped` +
  `run.partial` instead.
- Safety net in `event()`: any `run.partial` / `run.failed` / `run.cancelled` first closes an
  open `review.requested` with `review.skipped {reason}`.

## 4. Timeout wording
Every timeout now reads `Model response timed out after Xms (<phase> call[, <kind> timeout])`.
No more "Model executor call timed out: Model response timed out ...".

## 5. txt: near-duplicate "10-20 may slip" risks
`similarListText` also compares sentence by sentence (one risk joined two inferences) and ignores
a leading `风险：` label and `[source_...]` refs. `dedupeDerivedRisks` runs after derivation and
drops duplicate sentences across derived risks, keeping the fuller sentence (the subjectless
"的发布可能延期" is replaced by "原定 10-20 的发布可能延期").

## 6. Stream stall detection
`AEEIS_MODEL_STALL_TIMEOUT_MS` (default 90000, 0 disables). Once content/reasoning/tool deltas
have started, an SSE attempt with no new delta for that long is aborted as `stall timeout`
(headers, heartbeats and empty frames do not reset it). It is handled like an idle/first-byte
timeout inside the call budget: midstream retry if allowed, else ModelTimeout. Before the first
delta, the existing first-byte/idle timers still apply (Ark can think silently).

Validation: tsc; tests/r74-retest-fixes.test.ts (9); full vitest (only the two jsdom UI suites
fail locally, as on main). No live provider calls.
