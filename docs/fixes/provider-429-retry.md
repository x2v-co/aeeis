# Provider rate limits (run_ee478491)

Evidence: model_2cb0cda7 failed at evt_1841335f with HTTP 429, followed by
run.failed/evt_9461ae3b. The transport classified 429 as retryable but checked
responseBytes before permitting retry, so a normal nonempty JSON error body
prevented all retries. Empty-body tests did not exercise that path.

An explicit 429 rejection now has its own bounded retry path before the partial
body replay fence. Attempts use the existing capped exponential backoff with
jitter and the same request body/idempotency key. Retry-After delay seconds and
HTTP dates establish a minimum wait, even beyond the ordinary backoff cap. A
wait that cannot fit in the remaining wall-clock budget returns a definite 429
failure immediately. Explicitly disabled retries and exhausted attempt limits
remain effective; generation stream/body replay restrictions remain intact.

Validation: TypeScript; fake-timer tests cover jittered exponential delays,
Retry-After seconds/date/invalid/past values, persistent 429, disabled retries,
and wall-clock bounds; model HTTP/SSE tests; full npm test with two workers on
Node 22. No live provider calls.
