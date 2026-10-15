# Memory and skill change audit

`src/change-audit.ts` provides immutable JSON snapshots, SHA-256 hash chains,
an in-memory store, and `ChangeAuditService.rollback(entryId, actor, reason)`.
`PostgresChangeAuditStore` uses the existing advisory migration lock mechanism
and `005-change-audit.sql`. Its transaction callback supplies a PostgreSQL client
so canonical writes and audit appends commit together. Database triggers reject
updates, deletes, and truncation of the audit table.

Each persistence boundary has its own ordered chain:

| API source | Mutations | Storage |
| --- | --- | --- |
| `memory` | Domain memory creation, correction, retraction | Domain store: memory, JSON journal, or PostgreSQL stream `domain-memory` |
| `brain` | Claim creation, retraction, bundle import, scope deletion | Brain checkpoint; also PostgreSQL stream `brain` when configured |
| `knowledge` | Local knowledge upsert, bulk upsert, removal | In-memory or PostgreSQL stream `knowledge` |
| `skill` | OwnHow apply and version rollback | In-memory by default; PostgreSQL stream `skill` in the server when `DATABASE_URL` is set |

File and HTTP knowledge providers are read-only and have no local mutation hooks.
Existing records are not backfilled into fabricated creation events. Optional
`ChangeContext` arguments supply the actor and reason for service calls. A reason
contains `trigger` and at least one of `taskId` or `runId`. Existing call sites use
their goal, scope, record, or proposal id as task context, or the evidence Run id
when available. HTTP skill actions retain the authenticated actor and approval
reference or rollback reason.

```ts
const entries = await domain.changeAudit.list();
await domain.changeAudit.rollback(entries[0]!.id,
  { kind: 'user', id: 'owner' },
  { runId: 'run_example', trigger: 'restore after review' });
await domain.changeAudit.verifyChain();
```

Knowledge providers and OwnHow expose the same `changeAudit` API. Synchronous
Brain callers use `brain.changeAudit.list()`, `brain.changeAudit.verifyChain()`
and `brain.rollbackChange(entryId, principal, reason)`, then save through their
existing `BrainPersistence`. Brain rollback requires the claim owner or an
installation operator. Domain and knowledge service APIs are trusted internal
APIs; their HTTP audit routes require installation operator authority.

The existing admin API pattern is extended with:

- `GET /api/admin/change-audit/:source` — optional `subjectKind`, `subjectId`,
  and `limit` (1–1000, default 100); returns `entries`, `valid`, and `headHash`.
- `POST /api/admin/change-audit/:source/:entryId/rollback` — body
  `{"reason":{"runId":"run_example","trigger":"restore after review"}}`.
  The actor is taken from authentication.

Rollback restores the selected entry's `before` snapshot, even when later
changes exist. A null snapshot deletes the subject. It appends a new `rollback`
entry whose `before` is the actual current state, so rollback itself can be
undone. A domain correction captures both records together: rollback restores
the superseded record and removes the replacement. Brain scope deletion is
logged per claim; restoring claims does not recreate deleted access grants.
OwnHow rollback restores the exact active method JSON; proposal status,
receipts, and OwnHow's separate version history remain historical evidence.

OwnHow's filesystem and PostgreSQL cannot share a transaction. The adapter
compensates method changes if an audit commit fails, but an abrupt process or
machine failure between those writes needs reconciliation. Changes made by
external OwnHow processes are outside these AEEIS hooks.

`verifyChain()` detects changed entries, broken links, duplicates, and
reordering. Retain a head hash externally and pass it to `verifyChain(headHash)`
to also detect deletion of a valid suffix. A hash chain is tamper evidence,
not a signature against an attacker able to replace the entire chain and its
trusted head.
