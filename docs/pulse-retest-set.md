# Pulse retest set (sg)

Manual retest cases run after each aeeis deploy. Record run id, verdict and the log counters below.

The same six cases (plus r79 csv) run unattended against a real model with `npm run test:evals -- --live --case pulse`; see `evals/README.md`.

| # | Input | Goal | Must observe |
|---|---|---|---|
| 1 | big CSV (tasks export) | Project Pulse over the export | csvQuery used; no timeout |
| 2 | follow-up on #1 | ask a follow-up question | recommendations cite evidence; unsupported ones under 「推断」 |
| 3 | MD notes | Project Pulse | no `[证据]` placeholders; 「推断」 section separate |
| 4 | TXT notes | Project Pulse | accepted |
| 5 | JSON export | Project Pulse | final artifact has artifactType project-pulse/1 |
| 6 | CSV with `due` (YYYY-MM-DD) and `status` columns | 列出 due 早于今天（以系统时钟 clock.currentDate 为准）且 status 不是 done/closed/完成 的未完成任务，按 due 升序，给出总数并逐条引用证据。 | `aeeis-csv-date-filter/1` ≥ 1 with `op: "lt"` and `effective: true`; count matches an aggregate |

Minimal CSV for #6 (dates relative to the retest day D):

```
id,title,status,due,createdAt
1,Fix login,open,D-10,2026-01-05
2,Write docs,done,D-5,2026-01-05
3,Ship v2,in_progress,D+7,2026-01-05
4,Audit logs,open,D-1,2026-01-05
5,Plan Q4,open,tbd,2026-01-05
```

Expected: ids 1 and 4 (2 is done, 3 is future, 5 has no date).

Local replay-model retest (2026-10-14, inference auto-derivation):

Run `npx vitest run tests/pulse-inference-replay.test.ts` to replay all six shapes with a deterministic model adapter, real source tools, finish validation and review. This is a local fixture replay, not a production-provider retest. All six finish successfully without an inference-correspondence repair: CSV uses an aggregate query; follow-up uses frozen parent-thread evidence; MD, TXT and JSON derive missing labelled prose into structured risk entries with source refs and `derived: true`; the `lt` case returns ids 1 and 4, an aggregate count of 2, and an effective `lt` log.

Regression coverage also exercises a 651 KiB response, a repair with no response, dropped/altered artifact identity, and repairs introducing additional problems or new error types. Repairs merge only failed fields, use at most 4,096 output tokens and 64 KiB of response bytes, disable transport/length retries, and have a 180-second deadline. Rejected repairs retain valid pre-repair evidence as a partial result with limitations. Unknown outcomes and exhausted activity retries now close Temporal execution automatically: valid evidence produces `succeeded` plus `partial`; no evidence produces `failed`. If terminal projection cannot reach the API within its bounded retry policy, the workflow fails. Date precision, source unknowns, source-level refs, unconditional finish logs, and fillable-PDF/CJK checks remain covered.
