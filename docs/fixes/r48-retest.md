# r48 retest follow-ups (480d4a4 vs 1eecb40, sg)

## 1. HTTP 429 without visible backoff (pdf3 run_baf90ee8, pdf5 run_a82990ae)
Evidence: model_973f0ccb (pdf3) ran 06:25:45→06:31:58Z and model_e7f9612d (pdf5
reviewer) 06:08:09→06:14:14Z before `model.failed: HTTP 429` and `run.failed`.
No retry event exists. #71's retry ran inside the transport only: it shared the
transport `maxAttempts` (3 in production) with network faults, used the short
transport backoff (0.5–10 s), and had no callback, so retries left no trace in
the Run. After the third 429 the engine turned the error directly into run.failed.

Now: 429 has its own attempt counter (`AEEIS_MODEL_RATE_LIMIT_MAX_ATTEMPTS`,
default 5) and exponential backoff with jitter (`AEEIS_MODEL_RATE_LIMIT_BASE_MS`
2 s, `..._MAX_MS` 60 s). Retry-After is a minimum. A wait that does not fit the
call budget stops immediately. Every 429 calls `onRateLimited`, and the engine
records `model.rate_limit_retry` (with attempt/delayMs/retryAfterMs) or
`model.rate_limit_exhausted`. Exhaustion raises a definite `ModelRateLimited`
("persisted after N attempt(s) with backoff").

## 2. chifeng "Model executor outcome is unknown: ... timed out" (run_4b136ce0)
The repair call (model_e99b2612, 180 s repair timeout) threw `ModelTimeout`.
The timeout branch skips repair calls, so it fell to the generic unknown-outcome
limitation. `modelStopLimitation` now words a timeout as
"Model executor call timed out: ...".

## 3. json regression (run_871a81f4): not caused by byte-cap changes
`artifact.lists_normalized truncated:1` came from a runtime-derived risk
(`derived: true`) split from prose at "；" ("…时点不可控；"). The repair pass
re-normalized the frozen candidate, counted that clause as a truncated model item,
and added "1 truncated list item(s) omitted". The reviewer correctly rejected
that claim, since the source said truncated=false. The #69 byte-cap change does
not touch lists. Derived items are now exempt from the truncation check and end
with "。". The limitation text now says the dropped item was model-written, not a
source truncation.

## 4. 600 s overall timeouts (pdf2 planner, csv/lt final synthesis)
There was no Run-level time split: every call could use the full 600 s call
budget, so a single stalled call could use all of the Run's time before review.
Each new call now gets
`allocateModelCallTimeout`: a per-call cap (`AEEIS_MODEL_CALL_MAX_MS`, 420 s),
and planner/executor calls stop at the Run model budget (`AEEIS_RUN_MODEL_BUDGET_MS`,
30 min of model time) minus a review reserve (`AEEIS_REVIEW_RESERVE_MS`, 240 s;
floor `AEEIS_MODEL_CALL_MIN_MS`, 60 s). The reviewer always gets at least its
reserve. The timeout is a transport option, outside durable request hashes.

Validation: TypeScript; tests/r48-retest-fixes.test.ts plus existing 429,
list and timeout suites; full vitest (Node 20 locally: only the two jsdom
UI suites fail, as on main). No live provider calls.
