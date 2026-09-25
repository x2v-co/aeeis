# Contributing to AEEIS

AEEIS is an active-development TypeScript Agent Runtime and Control Plane. The repository contains an executable local runtime and development Compose stack, while several production integrations are still being validated. Contributions should improve a clearly stated boundary or provide evidence for a design decision.

Preferred contributions:

- RFCs and protocol examples;
- domain model and schema reviews;
- evaluation cases and conformance tests;
- Connector, Skill, Workflow, and local tooling proposals;
- threat models, privacy reviews, and failure analysis.

Before proposing an implementation, describe the user problem, the affected domain object, compatibility impact, authorization boundary, failure behavior, and rollback path. Do not include private Brain data, customer data, credentials, or unsanitized execution logs.

For substantial protocol changes, open an Issue first and link the resulting RFC. A change is not accepted merely because an Agent can generate it; it needs a reproducible example and an evaluation plan.

## Local checks

Use Node.js 22 or newer:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

When PostgreSQL is available, also run `npm run test:postgres`. Changes to Temporal, the dispatcher, external Agent callbacks, RSI, or Compose should include `docker compose up -d --build` followed by `npm run smoke:compose`.

Every pull request should explain the source of truth it changes, the owner/tenant and authorization boundary, the restart or unknown-result behavior, compatibility impact, and the rollback or reconcile path. Changes that alter a persisted protocol or receipt should include a migration or replay/conformance note.
