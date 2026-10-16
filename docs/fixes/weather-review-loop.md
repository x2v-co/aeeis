# Unsupported weather review (run_3a6cfd65)

Evidence: the goal was 北京今天天气和未来三天预报. Sources and the approved
capability catalog were empty. artifact_d48565cd explicitly declined the live
query, yet reviewer model_bbf4319f/evt_39e9b8b0 requested actual forecast data and
another revision. Earlier reviews had already consumed both automatic revisions.
Fidelity observations from earlier attempts also remained in the review prompt,
so the final reviewer discussed channel recommendations absent from the final
artifact. Prompt instructions to accept honest limitations did not establish a
terminal capability outcome.

Review now checks the existing deterministic weather-availability predicate
before opening another model call. With no source or retrieval capability, the
run closes failed with the specific `Capability limit (live_weather)` reason,
retains produced work as partial, and records run.capability_limited. This does
not claim an accepted independent review or a delivered forecast. It also works
for a restored run already at review. Supplied weather sources and approved
retrieval capabilities retain the normal independent review path. Other supported
work in a mixed goal remains in the retained artifacts.

Validation: TypeScript; fresh/restored unsupported weather, supplied observations,
planning, repair, review and bound-task regressions; full npm test with two workers
on Node 22. No live provider calls.
