# r62 retest follow-ups (e62e258, sg, 2026-10-16)

Compared against r48 (480d4a4). Per-item evidence was in the r62 debug/events export.

## 1. chifeng: repair timeout worded as "Model response timed out", Run failed
The first executor answer (no source material in this Run) failed only on
`content: unsourced general assumption`. The 180 s repair call timed out. Two gaps:
- The repair catch stored the raw transport message as `finishRepair.discarded`. The
  #73 `modelStopLimitation` wording ran only in the non-repair branch, so repair never
  used it.
- The fallback replaced the whole `content` with a placeholder, and then required a
  retained observed evidence ref. A no-source Run never has one, so it threw
  "no valid evidence remains" and the Run failed.

Now:
- Every model timeout reads `Model <phase> call timed out: ...`, including repair
  timeouts and the `run.partial` reason (`modelTimeoutReason`).
- A `general_assumption` content problem drops only the offending sentences.
- The retained-evidence check is skipped only when the task observed no evidence at
  all and every original problem was `general_assumption`. All other cases are
  unchanged (still fail).
- Result: `succeeded` + partial, with the timeout limitation.

## 2. pdf2 / csv / lt: no review.requested / review.completed
The 240 s review reserve only sized call timeouts. It never caused a review. All three
Runs left through early-stop paths that end the Run before review:
- pdf2: an executor timeout went to `preserveRunOutput` → succeeded/partial.
- csv: the provider error body made the outcome unknown → partial.
- lt: the repair answered without fixing the problem → repair fallback ended the Run.

Now:
- **Executor/planner timeout with retained work:** after `run.partial`, the Run goes
  to `reviewing` once (`stopReview: pending`, `review.requested {partial:true, afterStop}`).
  The verdict cannot fail the Run or trigger rework. Accepted removes "Independent
  review was not completed". needs_revision adds the issues as a limitation. A failed
  review keeps succeeded/partial. Switch it off with `AEEIS_REVIEW_AFTER_STOP=0`.
- **Repair that returned but did not resolve its problems (lt):** the pruned artifact
  stays partial (`artifact.repair_fallback`) and the Run continues to normal review.
- **Unchanged:** repair fallbacks caused by a repair timeout, rejection or oversize
  still stop without another model call.
- **Not reviewed (csv):** unknown, non-timeout outcomes. Provider billing must be
  reconciled before another paid call. This is intentional.

## 3. pdf2 420058 ms
That call was a normal executor call (fillable-pdf output recovery), capped at
`AEEIS_MODEL_CALL_MAX_MS` = 420 s. The 58 ms overrun is abort latency. Handling was
correct: timeout → partial with the PDF retained. Two changes:
- Executor calls now get `(remaining − review reserve) / pending plan tasks`, still
  between the min and max caps. A single-task plan like pdf2 still gets 420 s.
- `model.started` records `timeoutMs`, so the allocation is visible in events.

## 4. txt regression (needs_revision ×3 → failed)
Mostly model variance, with one #73 contribution. Review round 1 flagged a
model-written causal claim. Rounds 2 and 3 flagged risks that were duplicated or
were really unknowns. All of those were runtime-derived (`derived: true`) prose
inferences: the same "10-20 may slip" clause appeared up to three times, plus
"资料未说明 ...". Before #73, clauses ending in "；" were dropped as truncated. #73
correctly kept them, which exposed the missing de-duplication.

Now `deriveProseInferences`:
- skips near-duplicate risks (`similarListText`: containment or ≥ 0.6 bigram overlap);
- routes source-gap statements to `unknowns`.

Unchanged: a review still allows 2 revision rounds, and a 3rd needs_revision fails
the Run. That is the reviewer gate, not a bug. The Run did go back for rework twice.

## 5. 429 path not exercised in r62
Added an end-to-end test: the real `HttpModelAdapter` inside `AgentEngine`, with a
mocked fetch returning 429 then 200. It asserts that `model.rate_limit_retry`
(planner, attempt 1) is written and that the Run succeeds.

Validation: tsc; tests/r62-retest-fixes.test.ts (8); full vitest (only the two jsdom
UI suites fail, as on main). No live provider calls.
