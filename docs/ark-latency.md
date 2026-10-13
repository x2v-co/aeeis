# ARK latency investigation (SG)

Investigated on `fix/ark-latency` at baseline `100a3e7`, before these changes. No production logs,
requests or exact uploaded TXT/MD files are available in this checkout. The
reported 1–2 minute typical calls, 6.3 minute maximum, zero-byte waits over 180s,
MD timeout and approximately five-minute follow-up hang are operator evidence;
the measurements below are reproducible estimates through the actual engine.

Run `node --import tsx scripts/measure-ark-context.ts`. The deterministic model
plans an inspection and a dependent Pulse task, makes one bounded source-tool
call, then finishes each task and reviews. Counts are UTF-16 characters:
`system.length + JSON.stringify(input).length`, including escaping and material
boundaries, excluding HTTP envelope overhead. They are not tokenizer counts.
Random identifiers have fixed lengths. CSV is the checked-in 200-row fixture;
TXT/MD are generated 200-task inputs. The follow-up parent has eight 30,000-char
artifacts; normal history selection freezes 32,704 bytes of excerpts/summaries.

| Case (source chars) | Planner (system + input) | First executor | Inspection finish | Dependent finish | Reviewer |
| --- | ---: | ---: | ---: | ---: | ---: |
| Big CSV (19,903) | 2,535 + 3,429 = 5,964 | 10,919 | 11,840 | 14,019 | 13,540 |
| TXT (25,000) | 2,535 + 10,222 = 12,757 | 17,712 | 22,860 | 20,813 | 24,558 |
| MD (29,000) | 2,535 + 13,444 = 15,979 | 20,933 | 21,920 | 24,033 | 23,621 |
| Thread follow-up | 3,061 + 38,293 = 41,354 | 46,156 | 47,417 | 49,308 | 48,038 |

Every measured call originally requests `max_tokens: 16384`; one completed
`finish_reason: length` retry doubles it to 32768 (bounded by a known provider
pin limit). Planner repair can add another logical call. Finish is an executor
decision, not a separate transport API. Model budget/usage counts completed
attempts, including a reported length retry; invisible retries may still bill.

Current main already contains #35 CSV queries and #37 bounded readers. Large
CSV (>2,048 bytes) embeds schema, whole-data statistics/counts and seven hybrid
sample rows (up to 3,000 chars), rather than raw CSV. Text uses hybrid samples;
MD/JSON use bounded excerpts. Each phase allows 12,000 source chars, observations
are compacted to 10,000 and executor total context to 96,000. Thread history can
add 64 KiB of rendered JSON to each phase; copied artifact excerpts were up to
8 KiB each. This explains why follow-up prompts can dwarf a CSV planner prompt.
The small CSV planner can still hang: prompt size alone does not explain a
zero-byte wait or why concurrency two failed to improve it.

`thinking` and `reasoning_effort` were absent. ARK supports an explicit thinking
switch and effort control, with support/defaults/mappings dependent on the
chosen model. Reasoning deltas and keepalives reset idle timing, although the
adapter discards reasoning text from its retained JSON result. See the official
[ARK thinking documentation](https://docs.volcengine.com/docs/ark/deep-thinking?lang=en).
Provider queueing, prompt prefill, reasoning and transport/proxy buffering are
plausible sources of time before visible output. Offline measurements cannot
separate them or establish billing; disabling thinking should be evaluated
against output quality and the exact deployed model's support.

The original 180,000ms streaming idle clock begins before `fetch`, resets at
headers and then at body reads. It mixes header/first-byte waiting with later
gaps. Streaming overall 600,000ms is **per HTTP attempt**, from fetch through
`[DONE]`, even if reasoning/heartbeats arrive. It is not a run-wide deadline.
There is no 600s total run deadline in the engine. Non-streaming has a separate
180s default full-response deadline. Temporal async advance polling allows
20 minutes per engine tick, with a 25-minute activity deadline and two-hour
schedule-to-close window. Each tick normally makes one logical model call;
a multi-call Run gets fresh ticks, and business waits/reconciliation park it.
The MD report is consistent with a single active stream exceeding 600s, but
requires production `timeoutKind` logs to prove. Provider/network limits outside
the repository cannot be ruled out (Undici can independently time out headers).

Retries previously allowed at most one **opt-in** zero-body-byte idle replay,
requiring an idempotency key. Timeout/partial output remains an unknown outcome,
with durable request hashes and explicit reconciliation before later replay.
Any body byte, including reasoning, heartbeat or an incomplete frame, must
continue to prevent automatic replay. Headers establish HTTP status, not model
output; a successful response with no body bytes is still a first-byte wait.

Automatic fallback is intentionally skipped. The engine freezes one model pin
and pricing snapshot per Run before approval; calls/global reservations lack a
per-attempt provider pin. Switching providers inside `complete()` would misstate
the model used and its tariff, leave primary billing unknown, and make later
reconciliation target the wrong provider. Correct fallback requires durable
attempt-level pins, reservations and outcome accounting; mutating the shared
adapter pin after dispatch is unsafe. `AEEIS_MODEL_FALLBACK*` is not implemented.

## Implemented controls and measured effect

First-byte waiting now has its own 120,000ms deadline, from dispatch through the
first non-empty body chunk. Headers and empty chunks do not reset it. Idle
180,000ms applies only after body activity. The historical
`AEEIS_MODEL_RETRY_EMPTY_IDLE` switch defaults to `1` and now governs only
first-byte timeouts with zero body bytes and an idempotency key: up to the
configured three attempts (two replays), with identical body/key. `0` restores
the conservative immediate unknown outcome. Any body bytes prohibit transport
replay, including HTTP error bodies. Empty 429/5xx and pre-byte connection
failures retain bounded retries. Overall timeouts never automatically replay.

**Billing risk:** zero bytes are lack of visible processing, not proof of no
processing or charge. ARK/gateways may ignore idempotency keys. Invisible
attempts can bill more than once and are absent from AEEIS reported usage;
retries/fallback cannot be described as free. Exhaustion remains unknown, with
the same durable call/key and explicit provider reconciliation required.

`AEEIS_MODEL_THINKING=enabled|disabled|auto` and
`AEEIS_MODEL_REASONING_EFFORT=minimal|low|medium|high` are explicit opt-ins;
unset sends neither. Empty strings fail startup validation. Tokens and both
controls (including explicit omission) are frozen in each new call's logical
request, protecting the same body during reconciliation after env changes.
Legacy saved calls omit both controls and keep their original allowance.
`AEEIS_MODEL_MAX_TOKENS=16384` is the initial ceiling; planner/repair starts at
min(4096, ceiling), executor/finish/reviewer uses the ceiling or a smaller pin
allowance. Completed length retries still double once (planner 4096 → 8192),
respect the known provider output limit and run the existing usage budget check.

Each phase's source presentation now allows 6,000 chars. Large MD/JSON planning
uses bounded outline/shape summaries; CSV retains existing 3,000-char full-data
statistics/schema/samples. Planning explicitly directs whole-file queries and
bounded readers, rather than exhaustive paging. Source-tool serialized-result
allowances default to 12,000 per node / 36,000 per Run (was 24,000 / 72,000);
page defaults stay 4 / 12. A final partial finish is reserved as before. New
follow-up snapshots default to 12 KiB with 2 KiB marked excerpts and a 16 KiB
rendered cap, keeping recent goals, plan/review summaries and bounded output
excerpts. Stored originals, frozen older histories and request hashes remain
intact. These are deterministic excerpts, not additional model summaries.

| Case | Planner after | First executor after | Inspection finish after | Dependent finish after | Reviewer after |
| --- | ---: | ---: | ---: | ---: | ---: |
| CSV | 6,383 (2,954 + 3,429) | 10,919 | 11,840 | 14,019 | 13,540 |
| TXT | 10,227 (2,954 + 7,273) | 14,763 | 19,911 | 17,864 | 21,609 |
| MD | 7,411 (2,954 + 4,457) | 14,761 | 15,748 | 17,861 | 17,449 |
| Thread follow-up | 21,580 (3,480 + 18,100) | 25,958 | 27,219 | 29,110 | 27,677 |

The same measurement now freezes 11,852 bytes of follow-up history. Planner
instructions add 419 chars; CSV was already compact and is deliberately not
degraded. MD planning falls 54%, follow-up planning 48% and its largest executor
41%. TXT hybrid samples already clip individual lines, so its reduction is
smaller. These figures establish input size reductions, not provider speedups.

Active-stream overall increases from 600,000 to **900,000ms per attempt**, with
validation up to 1,800,000ms. Reducing it to 420s would tighten the existing MD
failure boundary, so 15 minutes gives active reasoning streams more room while
first-byte failures still cut off at two minutes. Temporal advance polling
allows 60 minutes per tick; new activity commands allow 65 minutes through a
replay-safe patch, with a two-hour schedule-to-close window. The default upper
bound with two empty waits, one active call and one completed length retry is
about 38 minutes plus backoff, below this tick allowance. No Run-wide 600s
deadline is introduced. Custom attempt/timeout combinations must fit the tick
allowance; old already-scheduled activity commands keep their old limits.

`aeeis-model-completion/1` logs headersMs, firstByteMs, per-attempt elapsedMs,
responseBytes, promptChars, maxTokens and usage, without prompt/output content.
`aeeis-model-error/1` additionally records timeoutKind and retry decisions (its
elapsedMs is cumulative within that length attempt). Comparing header/first-byte
waits with the post-byte duration identifies queue/buffering versus active
generation delays; it cannot distinguish provider prefill from internal thinking
or prove billing. Recreate API/worker with updated stack env and run the existing
Temporal history replay gate. Explicit old env values override new defaults.

## Validation and workspace limits

Node 22.23.3: `npm run typecheck`, `npm run build` and `git diff --check` pass.
The final focused transport/config/reconciliation/history/Temporal tests pass
(187 tests), and a separate mocked HTTP/catalog selection passes 42 tests.
Coverage includes default zero-byte retry/exhaustion, before-header hangs,
headers/empty chunks not resetting first-byte timing, zero-length chunks not
resetting idle timing, any-byte replay fences, all thinking/effort values,
planner length doubling, summaries and frozen wire settings after restart/env
changes, saved and hash-only legacy requests, and a four-call streaming Run
lasting 720s without a 600s total deadline. Offline Temporal replay passes.

`npm test -- --maxWorkers=2 --minWorkers=1` was attempted in full. This sandbox
denies localhost binds and Node subprocess execution (`EPERM`), also preventing
the Temporal test server from starting. The initial full pass exposed four
budget-related assertions; these were corrected to use explicit larger
allowances when exercising complete pagination and to respect the rendered
history cap. The subsequent broader run passes 1,351 tests across 94 files
(125 existing environment-gated tests skipped), excluding the 26 socket/CLI/
Temporal-server test files blocked by the sandbox. No test configuration was
changed to conceal the full-suite limitation. Re-run the entire suite with
localhost/child-process permissions before deployment.

Staging/commit is blocked by the managed workspace: Git's worktree metadata at
`/workspace/aeeis/.git/worktrees/aeeis-ark` is mounted read-only, so `git add`
cannot create `index.lock`. All edits are confined to `/workspace/aeeis-ark`;
verification logs live in `/tmp/aeeis-ark-*`. No push, deployment or production
provider call was performed.
