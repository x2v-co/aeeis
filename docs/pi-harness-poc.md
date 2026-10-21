# pi-ai adapter PoC

## Status — 2026-10-20

The minimal adapter is implemented and exercised offline through the **real installed pi/OpenAI Responses parser**, with an injected HTTP fixture and the real AEEIS Engine/repository. No paid model requests, credential discovery, production changes, Grok Bot connections, AEEIS commits, or pushes were performed. The server's default adapter/routing is unchanged.

- Baseline: `e014270467bc1a18e1aaa9141efd16b42d29faaa`.
- Isolated clone: `/Users/kl/workspace/x2v/aeeis-pi-adapter`, branch `feat/pi-model-adapter-poc`.
- The original dirty `/Users/kl/workspace/x2v/aeeis` checkout was not modified.
- Dependency: exactly `@earendil-works/pi-ai@1.3.0`, with lockfile integrity. Installation added 69 packages without changing any previously locked package version.
- Final verification passed: **2,286 passed / 127 skipped** in both the full serial and two-worker suites; typecheck, build and strict checking of the new test files passed. The 79 new pi tests comprise 61 adapter tests and 18 Engine integration tests.

## Runnable local case — 2026-10-21

From the checkout root:

```bash
node --import tsx scripts/demo-pi-local.ts
```

This prints each phase and creates a fresh ignored `data/pi-demo-*` directory containing a local status JSON file, repository, report, timeline and event/state snapshots. It demonstrates rejected wrong-plan approval, correct approval (automatically submitted by the demo script for its own Run only), a pending native capability, exactly one real local file read, an authorized receipt, report/review completion, and reopening the repository without another execution.

Model responses and usage are scripted fixtures, not real model inference or billing. The successful demonstration exited 0 with four fixture responses, one file read, one receipt, `succeeded` status and `accepted` review. The script's initial double-close cleanup error was corrected before that successful rerun; no runtime implementation was changed for the demo.

## Supported surface

Implementation: `src/adapters/pi/model.ts`, exported `PiModelAdapter` and `PiToolBinding`.

| Feature | Current support |
| --- | --- |
| Provider/API | `provider: 'openai'`, `api: 'openai-responses'` only; explicit pinned model and base endpoint. |
| Authentication | Explicit API-key argument; no environment credential lookup, OAuth or workload-identity flow. |
| Request | One `complete()` creates at most one HTTP dispatch. No agent loop or tool execution inside the adapter. |
| Injection | Optional `fetch` dependency; tests never fall through to real network. Uses pi's actual concrete `stream` API. |
| Text | Completed JSON decisions; completed non-JSON text only with `allowTextOutput`. |
| Native tools | Exactly one call, from explicitly configured trusted bindings intersected with the frozen approved capability catalog. |
| Retry | Pi and SDK retry limits are zero; a fetch wrapper also refuses a second dispatch. No length retry or thinking downgrade. |
| Output bound | Total consumed HTTP/SSE body bytes, including framing, are bounded before pi parsing. UTF-8 text is not counted as characters. |
| Timeout/cancel | Adapter deadline and cooperative transport abort; local waiting ends even if injected fetch ignores the signal. Remote billing/side effects are not assumed rolled back. |
| Reasoning | Supported `reasoningEffort` values only. Null/omitted means omitted on the wire, overriding pi's automatic `effort: none` insertion. Unsupported thinking toggles fail explicitly. |
| Output tokens | Explicitly validated against model/pin limits and Responses minimum 16; no silent clamping. |
| Usage | Observed input/output totals, observed cache/reasoning counters, and pi-normalized diagnostic counters. Missing data stays missing. |
| USD budgets | Not supported for this PoC: blocked before model dispatch. No inferred USD from simple input/output prices. |
| Health/server routing | No new health probe or production routing registration. Existing HTTP adapter remains the default. |

The pin endpoint is the Responses **base URL**, matching `model.baseUrl`; the adapter appends `/responses`. HTTPS is required except loopback; credentials/query/fragment in the URL are rejected. Model sampling/header overrides are disallowed. If the provider reports a terminal model identity different from the pin, output is rejected rather than silently accepting a substitution; rolling aliases that resolve to another reported ID are therefore not supported.

`cacheRetention` accepts none/short/long (default none). These are provider hints, not proof of a cache hit or cache disablement. No cache reuse, savings, live provider behavior or billed costs have been measured.

## Tool and recovery boundary

A binding supplies `name`, `toolId`, `toolVersion`, `description`, and a trusted Zod `input` schema. Its input JSON Schema must match the frozen descriptor for that ID/version. Native tools are only advertised for the executor input shape, not planning, reviewing, final-only or finish-repair requests.

The native argument envelope is:

```json
{ "input": { "key": "status" }, "purpose": "Read the approved status" }
```

The adapter emits the existing canonical decision:

```json
{ "type": "capability", "toolId": "fixture.lookup", "toolVersion": "1", "input": { "key": "status" }, "purpose": "Read the approved status" }
```

Raw provider argument JSON is parsed strictly and compared with pi's parsed object; malformed/repaired JSON, coercions and silently stripped input fields are not accepted. Multiple native calls reject the whole response. Text JSON capability decisions use the same binding/input validation. Native call IDs are not business idempotency keys; neither model arguments nor provider receipts grant authorization.

AEEIS still owns exact plan-hash/version approval, `ToolGateway`, `pendingTool`, durable execution fencing, idempotency keys, receipts, cancel state and reconciliation. The model adapter does not own persistence. Runtime tests reconstruct Engines and reopen the file repository; these are **not** fault-injection proof of all filesystem/SQL/Temporal crash windows.

The adapter sends AEEIS's idempotency key as a header, but does not assume the provider implements deduplication. An ambiguous model outcome requires explicit reconciliation; it is not automatically resubmitted by the adapter. Existing outer Engine retry/reconciliation policy remains unchanged.

Preparation failures and definite HTTP request rejections record known zero token consumption, allowing the Engine to settle their reservations. Once a provider terminal event arrives, the adapter closes its controlled input stream normally so pi can finalize without waiting indefinitely for a gateway to close SSE. It independently checks terminal status and rejects inconsistent completion metadata. Local recursive JSON Schema references are generated relative to the full `{input,purpose}` envelope, not embedded from a standalone root.

## Usage and budget semantics

`ModelCallUsage` is a backward-compatible extension of `{ inputTokens, outputTokens }`. Optional `details` records:

- source `pi-ai/1.3.0` and `accounting: tokens-only`;
- observed numeric provider fields under `reported`;
- optional observed cache-read, cache-write and reasoning counts;
- pi-normalized counters under `normalized`, which are diagnostic, **not evidence that absent fields were reported as zero**.

For Responses, provider `input_tokens` already includes cache reads/writes, and `output_tokens` already includes reasoning. These totals are counted once. Pi's own estimated `cost` is not imported into AEEIS billing. A failed terminal response can contain valid raw usage while pi leaves normalized counters at zero; accounting uses the observed provider totals.

The adapter persists `usageAccounting: 'tokens-only'` in `ModelPin`. Static recovery checks this field; compatibility catalogs retain the adapter's pin unchanged. Formal Planprice catalog routing is explicitly rejected in this PoC because its current pin builder assumes a Chat Completions endpoint. Run totals and the global ledger therefore cannot start inferring USD after restart or after a legacy-shaped manual reconciliation supplies only token totals without `details`. Run/global USD-budget admission rejects this adapter before model dispatch. Token/call budgets continue to work, and missing/invalid token usage stops budgeted continuation rather than becoming free usage.

This is intentionally not a new pricing engine. Provider/cache-specific price tiers, authoritative billing reconciliation, and production enablement remain separate work.

## Published-package findings

The earlier source audit used `earendil-works/pi@fbc456d827d7a4a951c50e7145af066226e2f8e9`. Implementation also inspected the installed 1.3.0 declarations and provider code:

- Root 1.3.0 does not export a standalone `stream`; the concrete import is `@earendil-works/pi-ai/api/openai-responses`, and `normalizeContext` produces its branded transcript input.
- Both the pi retry helper and the SDK request can be set to zero retries on this explicit-key path. The wrapper additionally rejects HTTP redispatch and redirects.
- `result()` can resolve on provider failure; the adapter instead inspects terminal events and stop reasons.
- Pi may repair/coerce tool input and zero-fill missing meters. The adapter validates raw arguments and observes raw usage events before normalization.
- Anthropic has a separate preferred-strict-tool downgrade/resubmit path. It is **not enabled** in this batch; supporting it requires a separately verified transport policy.

Package metadata declares MIT. A complete transitive-license/security audit and provider commercial-term review have not been completed. No claim of production readiness follows from npm installation or offline tests.

## Runtime requirements

Pi itself requires Node >=22.19.0, but already-locked AEEIS development dependencies (including jsdom) require newer supported LTS minors. The project now declares the compatible intersection: **`^22.22.2 || ^24.15.0 || >=26.0.0`**. No unrelated dependency version was upgraded to achieve this.

Local verification uses macOS arm64, Node v26.4.0, npm 11.17.0 and Vitest 2.1.9. CI still selects Node 22, which resolves the current 22.x release; CI/Linux execution has not been run in this local session.

## Verification evidence

### Baseline and portability fix

The untouched baseline had 2,206 passing tests, one failure, and 127 skips. The failure was `deploy/stack/bin/selftest.sh:167` using GNU-style `sed -i` under macOS BSD sed. Fixing that exposed other host-specific assumptions in the same **test script**:

- Explicit `sed -i.bak` suffix supports BSD and GNU sed.
- The replay-count check accepts BSD `wc -l` spacing while still requiring exactly four.
- Test aging uses Python `os.utime`, not GNU `touch -d`.
- The fake backup container gets a macOS-only `mv -T` shim with atomic replacement and directory-rejection assertions. Real deployment/backup scripts were not changed.

The three deployment tests passed after these changes. `systemd-analyze` is unavailable locally, so its existing optional validation is not claimed as executed. Fake-container tests do not replace real Docker/Linux validation.

### Adapter acceptance

`tests/pi-model.test.ts` exercises the real pi parser with HTTP/SSE fixtures. `tests/pi-runtime.test.ts` uses the actual Engine and file repository. `tests/support/pi-fixture.ts` contains no live fallback or real key.

| Area | Evidence |
| --- | --- |
| Approval/execution | Exact plan hash/version required; one native capability reaches invoke/receipt/finish; no pre-approval invoke. |
| Tool validation | Wrong name/version/schema, invalid/malformed arguments, multiple calls and unsolicited calls fail. |
| Recovery/fencing | Unknown tools reconcile after reconstruction without a second invoke; competing Engines do not duplicate dispatch. |
| Authorization | Forged receipt authorization is replaced by runtime admission. |
| Cancellation | Late model/tool results do not revive cancelled Runs; remote effects are not described as undone. |
| Transport | One fetch on 429/5xx/disconnect; timeout, pre/post-dispatch abort, byte caps and incomplete/error terminals handled. |
| Usage | Cache-inclusive totals, reported zero versus unknown, rejected output usage, global ledger, restart and manual reconciliation covered. |
| USD safety | Run/global USD budgets reject before dispatch; frozen old prices do not override the durable tokens-only pin. |

Final results after all hardening:

| Command/check | Result |
| --- | --- |
| `npm run verify` | Passed all three stages: typecheck, full serial tests, build; 236.7s overall. |
| Serial full suite | 165 test files passed / 26 skipped; **2,286 tests passed / 127 skipped**, 227.55s. |
| `npm test -- --pool=forks --maxWorkers=2 --minWorkers=1` | Same **2,286 passed / 127 skipped**, 145.13s. |
| New pi coverage | 61 adapter tests + 18 Engine integration tests, all passing. |
| Strict test TypeScript | Passed with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`; production tsconfig does not include tests. |
| Diff/format checks | Tracked diff check and trailing-whitespace checks on all five new source/test/report files passed. |

The first intermediate post-implementation full run also passed (2,267 tests), before the additional pricing/terminal/schema regression cases were added. Only the final runs above describe the current code.

Environment-gated exclusions remain 118 PostgreSQL-backed tests and 9 real Linux sandbox tests. Optional monitoring and full-local Docker smoke stages were not enabled. No real paid model, production recovery, real cache hit rate or billing comparison was tested.

## Deferred scope

No `pi-agent-core`, `pi-mcp` or `pi-durable` integration. No registration in collaboration/RSI model execution or cost accounting; those consumers are not covered by this Engine-only integration. Formal catalog routing, durable multi-tool batches, conversational loops, compaction, streaming UI, four-dimensional model routing, other providers, and Bot lifecycle/DM/group features remain later work. This isolated PoC is not completion of H1–H12 harness parity or a production rollout.
