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

Use Node.js 22 or newer. The default quality gate is deterministic and runs type checking, the unit test suite in one worker, and the production build:

```bash
npm ci
npm run verify
```

When PostgreSQL is available, also run:

```bash
AEEIS_VERIFY_POSTGRES=1 \
AEEIS_TEST_DATABASE_URL=postgresql://aeeis:aeeis@127.0.0.1:5432/aeeis \
npm run verify
```

Changes to Temporal, the dispatcher, external Agent callbacks, RSI, or Compose should include `docker compose up -d --build` followed by `npm run smoke:compose`. Monitoring and complete local protocol checks can be added with `AEEIS_VERIFY_MONITORING=1` and `AEEIS_VERIFY_FULL_LOCAL=1`.

Every pull request should explain the source of truth it changes, the owner/tenant and authorization boundary, the restart or unknown-result behavior, compatibility impact, and the rollback or reconcile path. Changes that alter a persisted protocol or receipt should include a migration or replay/conformance note.

## 编码边界

- Goal、Plan、Run、Receipt、Evidence、Brain 和 Grant 是 AEEIS 的事实源。
- 外部渠道只能通过带幂等键的投影或回调进入，不能直接修改事实源。
- 新的外部副作用必须定义授权、预算、超时、unknown 和 reconcile 路径。
- 数据库 schema 变化必须提供迁移、回滚边界和重启恢复测试。
