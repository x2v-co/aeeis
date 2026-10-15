# Partial runs and provider usage

Partial runs charge only completed provider calls, using the provider's reported
usage. A partial artifact or an interrupted run does not make completed calls free.

Timed-out calls and calls with an unknown outcome or missing usage are reported as
`unreportedCalls`. Do not estimate charges for these calls or bill them as completed
calls. Reconcile their request IDs/idempotency keys with the provider first; charge
only confirmed completed usage after reconciliation. A local timeout does not prove
that the provider stopped or that no charge occurred. Retried attempts can also have
unknown usage and must be reconciled, without double-counting confirmed usage.

Ark hosts default to `stream: true` with usage reporting. The first-byte deadline is
240,000 ms (other providers: 120,000 ms); `AEEIS_MODEL_FIRST_BYTE_TIMEOUT_MS` overrides
it. Any nonempty response bytes, including SSE keepalives and `reasoning_content`
deltas, clear the first-byte deadline and refresh the stream idle deadline. Headers
alone do not count. Idle, stream overall and call wall-clock budgets still apply;
the default call budget remains 600,000 ms. A continuously active stream can therefore
still time out at the overall/call budget and require reconciliation.
