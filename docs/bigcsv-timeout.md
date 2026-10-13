# CSV model timeout investigation

The production report concerns SG version `5108ab2`: Project Pulse stalls in execution, with three 180-second ARK transport attempts. The repository confirms two interacting mechanisms:

- `execute()` presents CSV text under a 48,000-character source budget. A `sources.read` used to append the entire wrapped source to durable observations; every later call resent every observation and all direct dependency artifacts. The 120,000-character request guard rejected growth only after building the request. The reviewer also received raw sources. The planner previously received only source metadata, not raw CSV.
- `HttpModelAdapter` waited for the complete non-streaming body under the same wall deadline as the request. It allowed 16,384 output tokens and a single length retry at up to 32,768, subject to the provider cap. ARK had three transport attempts, each with its own 180-second deadline, so exhaustion could take about nine minutes plus backoff. Reasoning and output progress were invisible to that deadline.

There is no 2 KB switch in the old transport. Prompt amplification is reproducible; additional structured CSV analysis and model reasoning are plausible causes of longer generation. An offline replay cannot establish the provider's exact latency, reasoning token count or billing outcome. No production requests were made for this investigation.

## Reproduce the measurement

Run from the repository root with Node 22. The script invokes the real engine with a deterministic fake model, creates temporary files only in this worktree and removes them. Each plan has an inspection task, then a dependent Pulse task. Each task reads twice before finishing; the inspection artifact contributes about 2.6 KB to the dependent task. The fake model's reported usage is deliberately irrelevant to measurement.

```bash
node --import tsx scripts/measure-pulse-context.ts --baseline=6945778
node --import tsx scripts/measure-pulse-context.ts
node --import tsx scripts/measure-pulse-context.ts --baseline=5108ab2 tests/fixtures/project-pulse-large.csv
node --import tsx scripts/measure-pulse-context.ts tests/fixtures/project-pulse-large.csv
```

`promptChars` is system text plus serialized user input, including JSON escaping and material boundaries, before HTTP envelope overhead. Estimated tokens are `ceil(promptChars / 4)`, **not provider-tokenizer measurements**. All generated cases and the fixture have 200 data rows. Uploads cap individual materials at 30,000 characters, so the 40 KB case injects a source into the repository to represent connector-supplied material.

| CSV characters | Before: first executor | Before: largest executor | After: first executor | After: largest executor |
| ---: | ---: | ---: | ---: | ---: |
| 3,000 | 8,315 | 19,483 (~4,871 tokens) | 6,322 | 11,596 (~2,899 tokens) |
| 10,000 | 15,316 | 40,484 (~10,121 tokens) | 6,910 | 12,903 (~3,226 tokens) |
| 19,903 fixture, production baseline | 25,624 | 71,408 (~17,852 tokens) | 7,348 | 14,362 (~3,591 tokens) |
| 40,000 connector | 45,316 | 86,348 (~21,587 tokens); next call rejected | 7,485 | 16,278 (~4,070 tokens) |

For the 10 KB case, the inspection executor prompts before the fix were 15,316 → 26,348 → 37,381 characters; the dependent task was 18,419 → 29,451 → 40,484. After the fix they are 6,910 → 9,035 → 9,800 and 10,013 → 12,138 → 12,903. The fixture reviewer falls from 30,219 to 17,532 characters, including bounded source-read observations so it can verify received row details.

## Relevant history

- **#20 (`aaaec44`)** changed 1,200-character executor excerpts to a fair 48,000-character source budget, preserving CSV headers and complete records. Its regression test intentionally required a roughly 6 KB CSV in full. It did not page reads or bound cumulative observations.
- **#21 (`e8622bb`)** added one planner schema repair and `allowTextOutput` in the model adapter. It did not change executor source sizing, timeouts or CSV reads.
- **#23 (`44008ff`)** added cancellation/reconciliation behavior around unknown calls. This constrains retries after potentially billable timeouts.
- **#24 (`25bf402`), #26 (`0840ddd`), #27 (`f085de7`)** added budgeted thread history, history projection into all model phases, and follow-up idempotency. They did not bound current CSV observations. The executor budget preserves the existing frozen thread snapshot and its 64 KiB rendered allowance.
- **#25 (`5108ab2`)** changed accepted-review issues to warnings and debug event duplication. It did not fix the execution timeout.
- **#22, #28–#31** cover thread persistence/tests/UI/docs and workbench changes; none fixes CSV model transport or prompt amplification.
- Earlier **#6 (`81775dd`)** introduced the 16,384-token default and doubled length retry; **#10 (`332d452`)** introduced ARK timeout/transport retry behavior.

## Runtime changes and configuration

Large CSV means more than **2,048 UTF-8 bytes**. Planner, executor and reviewer receive a `csv-summary/1` presentation capped at 3,000 characters: data-row count, malformed column-count rows, column names/types, distinct non-empty trimmed values, empty/missing counts, min/max and the first five sample rows. Statistics use all rows. Date extrema compare parsed timestamps across time zones and report the original strings; equal timestamps retain the first observed spelling. Wide summaries omit samples/columns with explicit metadata; text values may be shortened. Samples are not representative rankings. Other material formats retain line-aware presentation. Each phase's current source text budget is 12,000 characters.

`sources.read` preserves small CSV/non-CSV full reads when their serialized result fits 6,000 characters. CSV row reads use optional `offset` (zero-based data row, excluding header) and `limit` (default 20, maximum 100). Each page includes the header, at most 4,000 raw characters, exact page hash, full-source hash, total/returned row counts and `page.nextRead`. The complete serialized result, including JSON escaping, source metadata, material boundaries and continuation fields, must fit 6,000 characters. Quoted newlines and escaped quotes stay in complete records. CSV headers/records that cannot fit a row page, including escape-heavy records, use explicit character fragments. Large non-CSV reads also use character pages, making long single-line text accessible in full. `characterOffset` counts UTF-16 code units in the original source; `page.nextRead` provides the exact continuation, and generated continuations preserve Unicode surrogate pairs. Explicit character continuations also work for small sources. Raw sources remain stored in full.

Observations are projected into at most 10,000 serialized characters. Old results larger than 1,000 characters become stable Run-local references with SHA-256 hashes of canonical JSON and evidence refs. If individual references no longer fit, one aggregate reference records the omitted prefix, its count and hash. The latest result up to 6,000 serialized characters stays intact; larger results receive a preview bounded after JSON escaping. Source-read references preserve `page`, including `page.nextRead`, and the full-source hash outside the omitted payload. Durable observations are unchanged. The reviewer receives bounded source and external observations. The executor's system plus serialized input is capped at **96,000 characters**: oversized dependencies, observations, sources, receipts and answers compact to references (dependencies retain a bounded preview). This projection also preserves source-read continuation metadata and the latest bounded source page. Authorization and protocol fields stay exact, and an oversized fixed core is rejected before reserving/calling the model. Hashes alone do not substantiate omitted facts.

| Environment variable | Default | Accepted values / behavior |
| --- | --- | --- |
| `AEEIS_MODEL_STREAM` (new) | Auto | `1` enables SSE; `0` disables it. Omit for ARK/volcengine/BytePlus auto-on and other providers off. |
| `AEEIS_MODEL_IDLE_TIMEOUT_MS` (new) | `AEEIS_MODEL_TIMEOUT_MS`, normally `180000` | Integer 1000–600000 ms; starts before response headers and resets on received bytes, including reasoning and keepalives. |
| `AEEIS_MODEL_STREAM_OVERALL_TIMEOUT_MS` (new) | `600000` | Integer 1000–600000 ms; per-attempt cap, even if bytes keep arriving. |
| `AEEIS_MODEL_TIMEOUT_MS` | `180000` | Integer 1000–600000 ms; unchanged total deadline for non-streaming attempts and default streaming idle allowance. |
| `AEEIS_MODEL_MAX_ATTEMPTS` | `3` in server config | Integer 1–10; transport retry cap. Interrupted SSE responses are never replayed once SSE headers arrive. |
| `AEEIS_MODEL_RETRY_BASE_MS` / `AEEIS_MODEL_RETRY_MAX_MS` | `500` / `10000` | Integer 0–60000 ms, maximum ≥ base; existing capped backoff with jitter. |

Configuration applies to fixed and catalog-routed HTTP models. Agentpay is unchanged. SSE uses `stream: true` and `stream_options.include_usage`, accepts usage-only final chunks, assembles content deltas, and retains finish-reason handling, output caps, length-retry usage summation, idempotency headers and redacted diagnostics. A JSON response remains accepted if a provider ignores streaming. See the [OpenAI streaming event contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) and [Volcengine ChatCompletions contract](https://api.volcengine.com/api-docs/view?action=ChatCompletions&serviceCode=ark&version=2024-01-01).

SSE framing accepts LF, CRLF and standalone CR, including CRLF split across network chunks, as specified by the [SSE parsing contract](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream). Size limits apply separately to each decoded frame, buffered unparsed data, and retained completion content (1,000,000 UTF-8 bytes each). Large network chunks are drained incrementally. Discarded reasoning, repeated metadata and heartbeats do not consume the retained-output limit; idle and overall deadlines still apply. Non-streaming JSON retains its 1,000,000-byte response limit.

**No reduced-context executor retry after timeout.** A timeout/disconnected or malformed stream is outcome unknown; a changed input cannot reconcile the original durable `inputHash`/call ID and may create a second charge. The engine retains its unknown receipt and budget reservation for explicit provider reconciliation. Existing pre-stream transport retries retain the same idempotency key; a provider may still bill them more than once.

## Validation

With Node `v22.22.2` on PATH, `npm test` passed with Vitest capped at two workers: 113 test files / 1,372 tests passed; 26 files / 125 environment-gated tests skipped. The default worker run hit the existing 40 ms HTTP 401 timing test once because the deadline elapsed before headers arrived; that test passed independently and in the two-worker full run. `npm run typecheck`, `npm run build` and `git diff --check` passed. `package.json` has no lint script. Regression coverage includes full-data CSV statistics and chronological date extrema, quoted records, Unicode continuation, complete non-CSV and escaped CSV paging through the real engine, serialized page budgets, continuation metadata through observation and executor compaction, JSONB-stable hashes, SSE LF/CRLF/CR framing across byte boundaries, discarded reasoning/metadata/heartbeats, independent frame/buffer/content limits, usage/length retry, idle and overall deadlines, ARK SG detection, configuration bounds and unknown executor outcomes without additional calls.
