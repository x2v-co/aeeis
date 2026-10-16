# Timeout outcomes (production retest 1eecb40)

Evidence: run_a101f7a9/model_13ffacf8, run_bac28d0b/model_28ade1ce,
run_48bc52c3/model_0f9d00df and run_46da1725/model_a3375761 record 180000ms
idle timeouts; run_c4c56408/model_9906e65e records a 600000ms overall timeout.
The durable requests are approximately 5–19 KB, below the 96 KB executor bound,
and freeze thinking=disabled. Ark streaming defaults on. The idle clock starts
only after body bytes; first-byte defaults to 240 seconds. These are stalls after
bytes, potentially including heartbeat/framing bytes, rather than evidence that
streaming was disabled or the prompt exceeded context. The bundles do not retain
transport frame/gap logs, so the remote cause cannot be established from them.
The roughly 6–10 minute calls can include the configured midstream replay and
share a 600-second call budget. Increasing deadlines cannot establish progress.

Root cause of the indefinite result: ModelOutcomeUnknown represented both a
stopped execution and unresolved billing. With no completed output the engine
left the run unknown; Temporal replaced the diagnostic with a generic reason.
Timeouts now have a distinct error type: the receipt remains unknown for billing,
but execution retains completed output as partial or fails with the specific
timeout. Limited final calls retain observed evidence via the existing fallback.
Historical unknown terminalization also preserves the durable failure reason.

An adjacent timer bug applied the SSE idle timer even to JSON fallback and HTTP
error bodies. Only actual SSE now uses that timer; JSON retains its overall
request deadline. No provider configuration or timeout increase is required.

Validation: npx tsc --noEmit; focused timeout, transport, execution-limit and PDF
regressions; npm test -- --maxWorkers=2 --minWorkers=1 (Node 22). No live calls.
