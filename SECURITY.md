# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through a GitHub Security Advisory for this repository. If that channel is unavailable, contact the repository maintainers privately before opening an issue. Include the affected version or commit, a minimal reproduction, impact, and any suggested mitigation. Do not publish credentials, Brain data, customer data, or exploitable payloads in a public issue.

We will acknowledge a report, reproduce it in an isolated environment, and coordinate a fix and disclosure timeline with the reporter.

## Security boundaries

- Brain, Memory, Knowledge, Context Manifest, Run, Artifact, Receipt, and Projection data are tenant and privacy scoped. Canonical Brain state is the source of truth; semantic indexes are derived and must not bypass authorization checks.
- External Agents, tools, model providers, project sources, and webhook payloads are untrusted. Their claims and results must pass schema, provenance, authorization, and evidence validation before entering canonical state.
- Unknown model, tool, and external Agent outcomes require provider reconciliation or a deterministic idempotent retry. They must not be blindly replayed after a restart.
- Webhooks must use the configured signature, timestamp, nonce, and idempotency protections. Credentials and signing keys must be rotated through the deployment secret manager.
- RSI candidates require evaluation, approval, shadow or canary observation, and an auditable promotion or rollback decision. A generated change must not directly modify production behavior.

Security fixes should preserve these boundaries and add regression coverage where practical.
