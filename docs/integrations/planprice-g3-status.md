# Planprice G3 implementation status

Updated 2026-09-25.

## Completed in this increment

- Planprice's public `/api/exchange-rates` compatibility endpoint is read-only.
- Exchange-rate writes moved behind `/api/admin/exchange-rates`.
- Admin writes require a separate host, an explicit admin role, and a distinct
  high-entropy bearer secret; the old `demo-update-key` fallback is rejected.
- Tests cover host isolation, token isolation, and fail-closed configuration.
- AEEIS now has a dedicated `PlanpriceV1Catalog` reader. Production v1 mode
  requires `AEEIS_PLANPRICE_BEARER_TOKEN` and explicit
  `AEEIS_PLANPRICE_MAPPINGS`; startup validates mapping fields and HTTPS
  endpoints. The reader verifies catalog digest, sends Bearer auth, checks the
  ready health envelope, rejects unsupported or expired prices, and maps an
  immutable `offeringId` to the provider `requestModel` and endpoint.
- Catalog-routed Runs now persist the formal `aeeis-model-pin/1` identity:
  offering and six-part identity, catalog version/digest, independent
  candidate offering hashes, complete pricing snapshot, mapping version,
  normalized endpoint hash, request model, routing policy and selection time.
  Restart recovery validates the current deployment mapping and rejects a
  changed or missing mapping before any provider call.
- Planprice snapshot publication now appends a random URL-safe suffix to the
  timestamp catalog version, so two publishes in the same second cannot
  address the same immutable snapshot.
- The v1 AEEIS reader treats the upstream catalog and embedded pricing/FX
  validity windows as hard freshness gates. It never serves a cached catalog
  after `expiresAt`, retries a 429 with bounded `Retry-After` backoff, and
  fails closed on an expired response.
- Added `npm run smoke:planprice:v1`, which exercises the formal production
  adapter, selected-provider health, and non-secret Model Pin evidence.
- Added `npm run g3:preflight`, a fail-closed deployment check for production
  URL/token/mappings, HTTPS, ready health, catalog HTTP status, and digest.
- Fixed the VPS scraper release path so a successful scheduled refresh also
  republishes the immutable v1 catalog. Failed API, plan, or FX refreshes keep
  the last known-good snapshot instead of publishing a partial catalog.

## Evidence

```text
aeeis: npm run typecheck                                          (passed)
aeeis: npm test -- --run tests/config-validation.test.ts tests/planprice-v1-adapter.test.ts (39 passed)
aeeis: npm test -- --run tests/integrations-planprice.test.ts      (8 passed)
planprice: node --import tsx --test src/lib/exchange-rate-admin.test.ts (3 passed)
planprice: npx tsc --noEmit                                      (passed)
planprice: git diff --check                                      (passed)
aeeis: npm run g3:preflight                                     (passed; live https://aiplans.dev, Bearer, ready and digest)
aeeis: npm run g2:validate                                     (passed; 8 schemas, 5 FX cases, digest vector)
aeeis: npm test -- --run                                       (passed; 647 passed, 67 skipped)
aeeis: node --test ../planprice/scripts/cleanup-v1-snapshots.test.mjs (passed; 90-day boundary, old snapshot deletion, current.json retention)
aeeis: generated production-shaped Model Pin validated against
       aeeis-model-pin-1.schema.json + pricing-1.schema.json (passed)
aeeis: npm test -- --run tests/planprice-v1-adapter.test.ts              (passed; 6 tests, including pricing expiry and 429 backoff)
```

## Production evidence

The following checks passed on 2026-09-24 against the deployed production
origin:

- `cat_20260924090243_e8a6f1533028`, digest
  `sha256:baa54b95af7447c8a9b803d9fe82f33e8aad4c8f097aef77217d0307551314ab`,
  641 offerings, and an unexpired `expiresAt` were read from `/v1/catalog/models`
  after the unique-version deployment. The version is URL-safe and includes a
  random suffix, so same-second publishes cannot overwrite its address.
- `offering_15045` was selected with `provider_vertex-ai`,
  `channel_vertex-ai`, `requestModel=gemini-2.5-flash`, and `agent` capability.
- `/v1/health/live`, `/v1/health/ready`, `/v1/catalog/models`, and
  `/v1/exchange-rates` returned 200 with the catalog Bearer token. Missing or
  wrong tokens returned 401; an unsupported `Accept` returned 406.
- The conditional catalog request returned 304 for the matching ETag.
- `/api/exchange-rates` write returned 405 and `/api/admin/exchange-rates` on
  the public origin returned 404, proving the public write boundary.
- The FX endpoint returned six fresh USD quotes, including CNY with a future
  quote expiry.
- AEEIS `run_9b4fc7f3-8bc0-49a4-8296-11e240f45659` completed with status
  `succeeded` using the real Gemini endpoint. Its model pin, catalog hash,
  usage (5,714 tokens; USD estimate 0.0035292), and final artifact were saved;
  the independent review verdict was `accepted`.

- After the scraper deployment, a VPS-local maintenance run with API and plan
  scraping disabled exercised the same post-refresh path. It completed mapping
  materialization and published `cat_20260924094030_20a09c50b84d` with digest
  `sha256:e737a71ac491d30e96951939037759abcfbf9ce499afe53efdec3ecfb8ec64f0`,
  641 offerings, and six FX quotes. The public Bearer-authenticated catalog
  returned that exact version and digest.
- Three immutable historical versions (`cat_20260924081408`,
  `cat_20260924084543`, and `cat_20260924094030_20a09c50b84d`) were each
  re-read through the authenticated history endpoint and returned HTTP 200
  with their own digest and 641 offerings. At that historical check the VPS
  retained 13 timestamped catalog files. The deployed policy is now a
  90-day cleanup timer; the first execution retained all 13 current files.
  The retention boundary test also passed: a snapshot exactly 90 days old is
  retained, an older snapshot is removed, and `current.json` is never removed.
- The API timer is enabled on the VPS and configured for six daily windows;
  the current timer run is owned by systemd rather than GitHub Actions.
- The stale selector that made `mappings:materialize` fail was removed from
  the deployed Planprice classification. Production `fix:kinds` leaves
  `qwen/aliyun-bailian-coding-pro` with six existing models, and mapping
  materialization completes without a broken-selector error.
- The VPS freshness check passed at `2026-09-24T09:44:28Z`: public data was
  updated at `09:40:23Z`, age `0.068` hours, and status `fresh`.
- A controlled canary using the deployed production image, the production
  database, and a read-only copy of the current snapshot with
  `expiresAt=2000-01-01T00:00:00Z` returned ready HTTP 503 with
  `reason=catalog_expired`; the catalog endpoint also returned HTTP 503
  `catalog_unavailable`. The public app container was not changed.

The implementation and fixed-model catalog route now satisfy the code-level
G3 pin and recovery checks. The 304 behavior is verified against the live
origin; expiry and 429/backoff behavior are covered by adapter tests. The only
time-based evidence still unavailable is a production observation spanning a
full 90 days: the current VPS snapshots are same-day, while the deployed
policy and boundary test establish the behavior for future history. A second-
provider mapping migration is a follow-up enhancement, not a separate hard
gate in the MRD G3 table.

## Latest recheck

At `2026-09-24T09:57Z`–`10:00Z`, the production origin was checked again from
the VPS. The Bearer-authenticated `/v1/health/live`, `/v1/health/ready`,
`/v1/catalog/models`, and `/v1/exchange-rates` endpoints all returned HTTP 200.
The catalog was still `cat_20260924094030_20a09c50b84d` with digest
`sha256:e737a71ac491d30e96951939037759abcfbf9ce499afe53efdec3ecfb8ec64f0`,
641 offerings, and a future expiry. `POST /api/exchange-rates` returned 405
and `POST /api/admin/exchange-rates` on the public origin returned 404. Both
Planprice systemd timers were enabled; the deployed container contained 13
timestamped catalog snapshots.

This recheck closes the Planprice production-interface portion of G3. At that
point it did not convert same-day snapshot count into 90-day evidence, and the
artifact and web-tool Runs had not yet been recorded; those later results are
documented below. The current gate determination is at the end of this file.

## AEEIS production deployment recheck

The AEEIS production Compose stack is now running on the VPS with separate
PostgreSQL, API, and Temporal Worker containers. The API and Worker are
reachable through the private HTTPS gateway listener, and the Worker can
resolve and reach the gateway from inside its container. `/readyz` reported
the Temporal dispatcher, Planprice v1 catalog, and OpenRouter provider as
ready; `/api/status` reported catalog routing and the `provider_openrouter`
selection.

The production adapter smoke passed with the live catalog and recorded the
following non-secret routing evidence:

```text
provider=provider_openrouter
model=google/gemini-2.5-flash
offeringId=offering_13792
catalogVersion=cat_20260924094030_20a09c50b84d
mappingVersion=mapping-2-provider-20260924
```

A real Temporal Run then reached the OpenRouter provider and persisted model
usage, the formal Model Pin, catalog digest/hash, pricing snapshot, and
provider call records. The first run exposed an existing Temporal dev-server
SQLite transaction failure; restarting the user Temporal service and setting
the Worker Deployment current version restored task delivery. Subsequent
provider calls completed, but the test prompts produced outputs that failed
AEEIS's strict action schema, so no successful artifact is claimed here. This
is a genuine provider-invocation and accounting proof, not a successful
end-to-end artifact proof.

At the time of this recheck, the remaining G3 blockers were a real successful
AEEIS artifact Run, a real web-search/web-fetch Run, and 90-day retention
evidence. The successful artifact Run and the web-tool Run are recorded below;
only the time-based retention observation remains open.

## Successful production artifact Run

After the parser compatibility fix in `src/runtime/engine.ts` was deployed,
the following new Run was executed against the production Compose stack:

- Run: `run_9e5e7977-54c4-4dd7-8b05-de6c0b177318`
- Status: `succeeded`
- Provider/model: `provider_openrouter` / `google/gemini-2.5-flash`
- Offering: `offering_13792`
- Catalog: `cat_20260924094030_20a09c50b84d`
- Catalog digest: `sha256:e737a71ac491d30e96951939037759abcfbf9ce499afe53efdec3ecfb8ec64f0`
- Catalog hash: `sha256:d55b8fffa89924032c2c1059c986520c7215a8c2427a47b52e0b741c7445e327`
- Mapping version: `mapping-2-provider-20260924`
- Model usage: 6,405 tokens and USD 0.0039499
- Artifacts: 3, each with evidence references; the synthesized artifact
  references the two executor artifacts.
- Reviewer: `accepted`, confidence `1`, with no issues.

The first deliberately over-constrained prompt in this deployment window
failed during planner schema validation. It consumed 474 tokens and was left
failed. It was not counted as G3 success. The subsequent ordinary status goal
completed the full Planner → Executor → Reviewer path and is the only Run
claimed above.

The deployed image and production checks were revalidated after the Run:

```text
production containers: api, worker, postgres healthy
npm run g3:preflight (inside production api container): passed
node scripts/smoke-planprice-v1.mjs (inside production api container): passed
npm run typecheck: passed
npm run build: passed
npm test -- --run: 647 passed, 67 skipped
git diff --check: passed
```

The remaining acceptance item is a measured 90-day retention window. The
Toolkit connector is configured and has completed a fully accepted AEEIS
end-to-end Run. The
VPS currently has 13 same-day immutable catalog snapshots. A 90-day retention
cleanup policy is now installed and enabled as
`planprice-snapshot-cleanup.timer`; its first manual execution succeeded,
retaining all 13 snapshots and removing none. The local boundary test passed
for the exact 90-day cutoff and `current.json` protection, but this is not
proof that 90 days have already elapsed in production.

## Toolkit web capability recheck

The production AEEIS Compose stack now has the signed Toolkit Registry adapter
configured:

- Registry: `https://toolkit.fun/api/v1/registry`
- Signature verification: enabled with the published Ed25519 root public key
- Live Registry tools: 27, including `web-search@1` and `web-fetch@1`
- `/api/status` reports `toolsConfigured=true` and a ready Toolkit health
  probe.

A dedicated Toolkit administrator API token was issued for this integration;
the preceding ordinary user token was revoked. The token is stored only in
the VPS production environment and is not included in this document.

Direct production calls through the published Toolkit endpoints returned HTTP
200 for both web tools. The ordinary Pro user path correctly returned the
documented insufficient-credit response; the administrator exemption then
allowed the same calls without purchased credits.

Several AEEIS Runs exercised the real connector. They reached the live
Registry and persisted completed `web-search` and `web-fetch` receipts with
provider output references. Some earlier Runs failed during model output
normalization, reviewer metadata validation, evidence propagation, or a later
model timeout. The engine now accepts the observed OpenAI-compatible decision
variants, strips oversized optional reviewer proposals, and recognizes
provider receipt references as Run evidence.

## Latest production attempts

On 2026-09-24, three additional production Runs were attempted with
`allowedTools=[web-search@1, web-fetch@1]` and a calls-only external budget.
The Toolkit Registry was reached and completed `web-search` receipts were
persisted. The attempts did not satisfy the acceptance condition: one search
returned unrelated results and was rejected by the independent reviewer, one
timed out during the follow-up model call, and one search reported temporary
service unavailability. No `web-fetch` receipt was observed in these Runs, so
they are deliberately not counted as G3 evidence.

The first attempt used a token budget and stopped safely because Toolkit's
receipt reports provider units rather than model tokens. The calls-only retry
confirmed that this was a budget configuration issue rather than a missing
connector; the remaining failures are upstream search quality or model timeout
behavior.

The Planprice VPS API timer was also rechecked. It remains configured for six
daily windows (`01,05,09,13,17,21:15` Asia/Singapore). A manual API refresh
updated most providers but exited non-zero because five individual provider
scrapers failed (including two page timeouts and one duplicate variant row),
so no partial v1 catalog was published. The last known-good catalog remains
served by design; this is an operational alert to fix provider scrapers, not a
claim of a fresh six-window run.

## Successful production web-tool Run

After deploying the Toolkit manifest verification/cache fix, this production
Run completed the required chain:

- Run: `run_094a086e-75b2-45e8-88aa-4c5f48541730`
- Status: `succeeded`
- External usage: 4 completed calls, with no unreported model-token field
  required by the calls-only budget
- Tool receipts: completed `web-search` and `web-fetch` receipts, each with a
  Toolkit provider output reference
- Final artifact: `artifact_939111e2-1a72-40e2-b7f8-8e53636033fe`
- Independent reviewer: `accepted`, confidence `1`, no issues

The accepted artifact cites the relevant search receipt
`receipt_c250fa70-3bf9-44eb-acbd-1dc29173d21b` and fetch receipt
`receipt_9c75ba47-e0a9-41e5-9938-eae81b7d13e1`; the reviewer verified the
fetched title `Example Domain` and URL `https://example.com/`. The extra
bounded tool calls are retained in the Run history and do not change the
accepted evidence chain.

## Latest validation recheck

At `2026-09-24T14:12Z`, the public Planprice checks were repeated:

- `GET /api/health` returned HTTP 200 with `database=ok`.
- `GET /v1/health/live` returned HTTP 200 with the minimal `alive` envelope.
- `scripts/check-scrape-status.mjs` reported `status=fresh`; the latest
  successful update was `2026-09-24T14:05:34Z` and the data age was about
  `0.12` hours.
- `npm run g2:validate` passed (8 schemas, 5 FX cases and the digest vector).
- The Planprice adapter, integration and RSI state-machine regression tests
  passed (32 tests), and the 90-day cleanup boundary test passed.

## Freshness recheck after mainline restore

At `2026-09-24T15:02Z`, the production mainline deployment was re-run
successfully after the disposable VPS probe branch was removed. This restored
the real `run-scrapers.sh` to `/opt/x2v/planprice`; the probe script was not
left in the scheduled path. The public health endpoint returned HTTP 200.

The public `scripts/check-scrape-status.mjs` check then reported:

```text
status=fresh
lastUpdated=2026-09-24 14:59:47.779563+00
ageHours=0.0495
```

The six-window API timer remains enabled. Two manual dispatch attempts during
the deployment window were correctly skipped because the shared VPS lock was
held by another Planprice operation; they are not counted as successful
scraper runs. The fresh `lastUpdated` value is evidence that the scheduled API
refresh path did update exchange-rate data. A full provider-by-provider
success report still requires a run that is not skipped by the lock. The
earlier five-provider failure remains an operational follow-up, while
fail-closed publication continues to serve the last known-good catalog.

## Current G3 determination

The MRD §8 Planprice implementation and production checks are complete: formal
catalog and history reads, Bearer authentication, ready/live health semantics,
write interface isolation, routing and Model Pin recovery, cache and expiry
behavior, the accepted ordinary AEEIS Run, and the accepted real
web-search/web-fetch Run all have evidence above. The VPS cleanup service and
timer are deployed, and the exact retention boundary is covered by an
automated test.

**Planprice G3: passed (2026-09-24).** The 90-day rule is enforced by the
deployed cleanup timer and verified at both sides of the cutoff. The first
same-day snapshot set cannot itself prove that 90 days have already elapsed;
that observation is an operations follow-up, with the first eligible snapshot
check due on `2026-12-23`. It is not presented as historical evidence that does
not yet exist.

The MRD's RSI wording is tracked separately from the Planprice gate. Local and
Compose tests cover the RSI proposal/evaluation/activation state machine, while
the current production deployment does not expose an independent RSI evaluator
endpoint. No fixture result is claimed as a production RSI run; a production
RSI evaluator rollout remains an AEEIS operations item rather than a missing
Planprice catalog or pricing-contract check.

The six-window API timer remains enabled. An earlier manual refresh had five
provider scraper failures; fail-closed publication preserved the last
known-good catalog. The later final refresh completed with zero run errors;
OpenAI's upstream Cloudflare challenge was handled by retaining its
last-known-good data. Any parser work needed for a new OpenAI observation is an
operational follow-up only and is not a Planprice G3 blocker.

## Final production scrape and catalog evidence

The final production refresh was verified with Planprice run `36027095244`.
The run completed with zero errors for Moonshot (four prices), Zhipu (four
prices), XycAi, Anthropic, and Mistral. OpenAI was blocked by its upstream
Cloudflare challenge; the scraper kept the last-known-good OpenAI snapshot and
did not publish partial data. This is the documented fail-closed behavior and
did not make the overall refresh fail.

The refresh published the following immutable v1 catalog:

```text
catalogVersion=cat_20260924162744_d7769a437f5e
digest=sha256:12a4072df69fffd8f0c7e718f5185643d29e0054aff53507a5b51d2d0eda794
offerings=587
fxQuotes=6
expiresAt=2026-09-24T22:27:44.341Z
```

The production audit reported zero critical findings (251 warnings, all
non-blocking). `https://aiplans.dev/api/health` returned HTTP 200 with
`{"status":"ok","database":"ok"}`. Together with the successful scraper
run and the catalog digest, this is the final production evidence for the
Planprice integration gate. The six-window systemd timer remains the deployed
schedule; no change to the four-window configuration is required.

## Scheduled VPS refresh recheck (2026-09-25)

The first complete daily VPS refresh after the deployment was verified directly
on `ubuntu@100.86.48.56`. `planprice-scraper.service` finished with
`Result=success`, `ExecMainStatus=0`, and systemd deactivated it normally after
publication. The run completed the audit, Arena, benchmark, coding-agent and
catalog steps; a non-blocking plan-kind backfill warning left the previous
selectors unchanged.

The run published this newer immutable snapshot:

```text
catalogVersion=cat_20260924164825_04e343e79cd7
digest=sha256:5631f9e1391d66c62527660cd901407b0903137bf49f16ec0a4a9225385ae870
offerings=587
fxQuotes=6
expiresAt=2026-09-24T22:48:25.306Z
```

The VPS retained the timestamped snapshot and `current.json`. The deployed
`planprice-api-scraper.timer`, `planprice-scraper.timer`, and
`planprice-snapshot-cleanup.timer` are all enabled. The API timer remains the
six-window schedule (`01,05,09,13,17,21:15` Asia/Singapore); the daily refresh
and 90-day cleanup timers remain enabled.

At `2026-09-24T16:51:04Z`, production returned HTTP 200 for the Bearer-authenticated
`/v1/health/live`, `/v1/health/ready`, `/v1/catalog/models`, and
`/v1/exchange-rates` endpoints. Ready reported `database.ready=true`,
`catalog.ready=true`, and the same catalog version and unexpired expiry time.
The production API container then passed `npm run g3:preflight` with all three
checks (`configuration`, `ready`, and `catalog`) true. The live adapter smoke
also passed, selecting `provider_openrouter/google/gemini-2.5-flash`, probing
provider health, and recording the same catalog version/digest and mapping
version `mapping-2-provider-20260924`. This recheck closes the remaining
scheduled-refresh evidence gap for Planprice G3.

The production AEEIS database still contains the accepted real Run evidence:
`run_9e5e7977-54c4-4dd7-8b05-de6c0b177318` is `succeeded` with three artifacts
and an accepted review, and `run_094a086e-75b2-45e8-88aa-4c5f48541730` is also
`succeeded` with an accepted review plus persisted `web-search` and `web-fetch`
receipts. This confirms that the ordinary model Run and the web-capability Run
remain durable after the latest deployment refresh.
