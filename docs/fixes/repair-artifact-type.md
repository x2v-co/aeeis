# Repair contract and byte cap (run_d0d2ca25)

Evidence: model_0a827b36 returned a plain-text itinerary with an inference-only
structured sidecar, no artifactType, and citations to artifact_36a4d2ce. That
dependency had evidenceRefs=[], and the run had no sources. The shared fidelity
prompt requested structured inference notes even for plain-text outputs, while
prepareFinish required one of three typed contracts. Repair freezes artifact
identity and could not turn this sidecar into a valid typed artifact. Its error
also listed the same dependency ID as both invalid and allowed. Event
 evt_98ef7c9d records these original problems and the subsequent transport failure;
model_327d86e2 failed with `Repair response exceeds byte cap`.

Plain-text inference-only sidecars now become labelled prose and pass the normal
citation/fidelity checks. Guidance scopes structured inference entries to typed
artifacts. Dependency refs, including inline refs, expand to primary evidence;
source-free dependencies are omitted with an explicit unverified limitation.
Evidence diagnostics list only primary evidence IDs. Typed schemas remain strict.

The transport previously compared 64 KB with raw SSE bytes. Per-token JSON
frames, repeated metadata and reasoning can exceed that limit even for a small
4096-token repair. The bundle has no failed response body or frame counters, so
its exact overhead cannot be measured. The repair limit now measures decoded
UTF-8 completion bytes. Separate bounded wire/frame/buffer limits still apply.
Transport and decoded-content failures have distinct, accurate error messages;
the engine retains the original validation problems separately.

Validation: TypeScript, focused contract/repair/transport/evidence regressions,
and full npm test with two workers on Node 22. No live provider calls.
