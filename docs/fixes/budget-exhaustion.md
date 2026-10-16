# PDF repetition and budget exhaustion

Evidence: run_dd906518 spent all 20 model calls and failed at evt_c0fdb252;
run_5024608a spent 12 iterations on inspect_form_fields. Their third executor
prompts show a 1225-character pdf.formFields result compacted to a context
reference after a subsequent observation. That projection retained fieldCount
and page metadata but discarded the entire fields array. Duplicate detection
then appended only a reference telling the model to reuse the omitted result.
This creates a feedback loop: ask for missing field details, receive a duplicate
reference, still have no field details. The final PDF5 assessment explicitly
reported those details missing despite their presence in durable observations.

The projection now retains PDF field schemas, and duplicate results carry their
original payload. Two consecutive duplicates trigger a final synthesis rather
than consuming the rest of the node's allowance. Changed inputs still execute.
The prompt reports the minimum of the node and remaining run call allowances;
the last two calls are reserved for synthesis and review. If the run budget is
already exhausted (including restored historical runs), the engine retains
completed output or builds a labelled, bounded partial from collected source
observations without making another provider call. With no work to retain,
exhaustion remains an explicit failure.

Validation: TypeScript; budget, prompt projection, duplicate, execution-limit,
and PDF regressions; full npm test with two workers on Node 22. No live calls.
