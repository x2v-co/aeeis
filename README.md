# AEEIS

> A user-owned, long-running agent with a durable Brain, a single identity, and verifiable personal self-improvement.

AEEIS is being redesigned as an independent RSI agent. It is not a continuation of `ai-chat-system`, and this repository is not a generic ChatGPT clone.

The first design target is a project continuity agent that can read project context, decompose and execute long-running work, coordinate internal and external agents, preserve evidence, request approval, and gradually adapt to the user's working style.

## Status

The first TypeScript implementation now contains the core Plan DAG state machine, an in-memory AEEIS service, a small HTTP API, and durable Run Receipt objects. It is an early development scaffold, not production-ready.

## Design documents

- [Design baseline](docs/design/2026-09-18-aeeis-design-baseline.md)
- [Agent protocol and domain model](docs/design/2026-09-18-agent-protocol-domain-model.md)
- [Task DAG and Temporal execution](docs/design/2026-09-18-task-dag-temporal-design.md)
- [Multi-agent collaboration, competition, and open world](docs/design/2026-09-18-multi-agent-open-world-design.md)
- [External project contracts](docs/design/2026-09-18-external-project-contracts.md)
- [Commercialization, operations, community, and open source](docs/design/2026-09-18-commercial-community-open-source-strategy.md)
- [TypeScript-first implementation decision](docs/design/2026-09-18-typescript-first-implementation.md)

## Quick start

```bash
npm install
npm test
npm run typecheck
npm run dev
```

The development API listens on `http://localhost:3000`. It currently exposes `GET /health`, goal and plan creation, plan snapshots, and task transitions. Persistence, authentication, Brain, Temporal, and external integrations are intentionally next steps.

## Architecture in one view

```text
User-owned Brain
        ↓
AEEIS semantic control plane
  Identity · Policy · Goal · Plan · Run · Receipt · RSI
        ↓
Execution and capability planes
  toolkit_new · ownhow · planprice · Temporal · Connectors
        ↓
Channels and projections
  Web · Feishu · CLI · external task systems · external agents
```

AEEIS keeps ownership of task meaning, authorization, context, evidence, durable business state, and evolution decisions. External projects provide infrastructure and capability planes through versioned contracts.

## Open-source direction

AEEIS follows a protocol-first, progressive Open Core direction. Protocol schemas, receipts, export formats, local tooling, SDKs, evaluation harnesses, and compatibility tests are intended to be open. Hosted control plane, enterprise governance, managed relay, advanced routing, reputation, billing, and operations are potential commercial capabilities.

The public repository is intended for design review, RFCs, protocol examples, evaluation cases, and future Connector/Skill contributions. Do not submit private Brain data, customer tasks, credentials, or unsanitized run logs.

## Contributing

Start with an Issue or RFC for protocol and domain changes. Contributions should explain the problem, affected boundary, compatibility impact, security and privacy implications, and how the change can be evaluated and rolled back.

## License

Apache-2.0. Product names and trademarks remain with their respective owners.
