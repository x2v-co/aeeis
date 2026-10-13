# Pulse retest set (sg)

Manual retest cases run after each aeeis deploy. Record run id, verdict and the log counters below.

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
