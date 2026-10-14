# ec74fde retest fixes and local replay

Scope: `fix/retest-3`, based on `ec74fde` (#52). Production descriptions came from the bottom of `/workspace/aeeis-migration-progress.md` and `/workspace/aeeis-run597734ec.md`; no production logs were available. Replays use deterministic model responses, existing source/PDF fixtures, real engine validation, persisted PDF bytes, and a local HTTP model fixture. They demonstrate the described failure paths locally; live provider and production acceptance remain retest work.

## Changes

1. Missing inference labels are nonblocking presentation warnings in ordinary and limited-evidence finishes. Each warning emits one JSON line with `protocol=aeeis-finish-content-warning/1`, `marker=finish-content-warning`, `runId`, `taskId`, `rule`, and `path`. Correspondence warnings use the same observable protocol. Unsourced general assumptions, invented source dates, placeholders, and invalid evidence still require correction. The reviewer prompt explicitly treats missing labels as warnings.
2. CSV filter operators normalize symbols, case, whitespace, and aliases before discriminated-union validation. `<`, `less_than`, and `before` become `lt`; `<=` and `less_than_or_equal` become `lte`. Unknown operators receive a precise `filters.N.op` error and the complete valid-op list. Date comparisons retain their existing semantics.
3. Ark HTTP-200 JSON and SSE error bodies are provider errors, not schema failures. Bounded retries use backoff and the same durable idempotency key. Missing keys, disabled retries, exhausted attempts, and partial completion/reasoning/tool content preserve replay fences. Diagnostics and subsequent completion logs retain `usageUnknown=true` and `billingRisk=duplicate-possible`. Timeout retries remain covered by the existing suite.
4. PDF finishes recover null output metadata from matching stored outputs. A final or redundant tool/capability decision can become a finish after source values and stored bytes validate. Source tools resolve run-local source IDs, names/upload aliases, imported artifact identities, PDF output IDs/names, and existing PDF artifacts; ambiguous and foreign resources remain denied. Font appearances shrink to fit (normally no smaller than 6pt), wrap multiline fields, and center single-line text using descender metrics. Oversize values that cannot fit at the minimum emit `minimum-size-overflow`; values and editability are preserved.
5. Regression names cover `run_2867fbfd`, `run_597734ec`, `run_313c8bce`, `ark-200-errorCode`, `run_64943ccc`, `run_febf1391`, `run_9da5581d`, `run_b1917541`, and `address-fit`. Existing repair fallback, source fidelity, download authorization, empty fields, read-only fields, CJK font, timeout, and #50/#51 tests remain in the full suite.

## Run locally

Use Node 22, then:

```sh
npm ci
npm run replay:retest
npm run test:serial
npm run typecheck
npm run build
npm run lint --if-present
git diff --check
```

`replay:retest` selects exactly six Pulse and six PDF tests. It requires no credentials, external model endpoint, production log access, push, or deployment.

Validation on Node `v22.23.3`: full suite **133 files / 1,923 tests passed**, **26 files / 126 tests skipped** under the repository's existing environment gates. Replay: **12 passed**, 24 unrelated tests excluded by the name filter. Typecheck, build, and whitespace checks passed. The repository has no lint script; `lint --if-present` was run, but there is no configured linter to report. A locally generated Latin/CJK address and `p y g j q` render was visually inspected with Poppler; full values and descenders were visible.

## SRE retest matrix

Every case expects `succeeded` with an accepted independent review. Common markers are `aeeis-finish-content-check/1` (`result=ok|fixed`, `problemCount=0`) and `aeeis-finish-evidence-check/1` (`result=ok|fixed`, `invalidCount=0`). A warning alone must not be followed by `artifact.repair_requested`. Specific markers occur only when that path is exercised; a model that returns a correct finish directly need not emit recovery markers.

| Case / prior run | Expected result | Additional log markers to inspect |
| --- | --- | --- |
| Pulse CSV / `run_2867fbfd` | Report accepted; missing labels in risks/body cause no repair, including a limited finish | `finish-content-warning`, `rule=inference_label`, `path=structured.risks[0].text|content`, plus `runId` |
| Pulse follow / `run_4797246a` | Follow-up accepted with inherited evidence | Common finish checks; warning/derivation markers when an inference needs bookkeeping |
| Pulse MD / `run_ce2b8786` | Accepted; source date spelling preserved | Common checks; `derivedInferences>0` when prose counterparts are derived |
| Pulse TXT / `run_4b9022e4` | Accepted with structured artifact | Common checks; `finish-content-warning` for any missing label |
| Pulse JSON / `run_338f6911` | Accepted with `project-pulse/1` structured output | Common checks; `aeeis-finish-normalized/1` if a wrapper is normalized |
| Pulse LT / `run_313c8bce` | Date query returns IDs 1 and 4, total 2; aliases parse | `aeeis-csv-date-filter/1`, `op=lt`, `effective=true`; `aeeis-model-schema-retry/1` only for genuinely unsupported operators |
| PDF 1 / `run_4e0fa30e` | Editable output accepted; missing values remain empty | `aeeis-pdf-filled/1`, common finish checks |
| PDF 2 / `run_64943ccc` | Null output metadata recovered from stored bytes | `aeeis-pdf-finish-synthesized/1`, `path=structured.output`, matching `outputRef` |
| PDF 3 / `run_febf1391` | Final-step tool call ignored; existing PDF finishes | `aeeis-pdf-auto-finish/1`, `reason=final-call-tool-dropped`, matching `outputRef` |
| PDF 4 / `run_0f8a1b50` | Sourced fields match PDF; read-only field preserved | `aeeis-pdf-filled/1`, common finish checks |
| PDF 5 / `run_9da5581d` | Known resource aliases resolve; empty fill also produces a valid PDF and reports every unfilled field | `aeeis-source-resource-resolved/1`, `sourceRef`; `aeeis-pdf-filled/1`, `writtenFields=0` for an empty fill |
| PDF 6 / `run_b1917541` | Existing valid PDF survives a redundant denied-capability attempt; address visible | `aeeis-pdf-auto-finish/1`, `reason=redundant-call-dropped`; `aeeis-pdf-text-fit/1`, `result=fit`, `fontSize` |

Additional regressions: weather `run_597734ec` finishes partial on executor iteration 8, with `finish-content-warning` and evidence-check `limited=true`, without a repair. Ark errors emit `aeeis-model-error/1`, `status=200`, provider `errorCode`, `retryable=true`, `retryDecision=provider-error-retry`, `willRetry=true`, `retryDelayMs`, and billing-risk fields; exhaustion remains observable with `willRetry=false`.

Warnings and finish recovery lines run in the API process via the existing one-line stderr JSON convention. Text-fit lines contain `sourceRef` and field name; correlate them with `aeeis-pdf-filled/1` to find the run. No field values are included in text-fit logs.
