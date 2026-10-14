# Fillable PDF retest set (sg)

Manual retest cases run after each aeeis deploy. Select **PDF 表单**
(`builtinSkill: "fillable-pdf/1"`), upload `fixtures/fillable-pdf/registration.pdf`
and the source below. Record Run ID, review verdict, output filename/hash/size,
and any `tool.failed_recoverable` or `artifact.repair_requested` events.

| # | Input alongside the PDF | Goal | Expected filled fields | Expected unknowns / must observe |
|---|---|---|---|---|
| 1 | `profile.json` | Fill the registration form using only the profile | name=Maya Chen; email=maya@example.test; subscribe=true; contactMethod=Email; country=SG; interests=[Music, Travel] | phone empty; caseId explicitly untouched/readOnly (FORM-001). Accepted, every filled field cites the JSON source. |
| 2 | `partial.md` | Fill only the supplied facts; report missing information | name=Maya Chen; email=maya@example.test; country=SG | phone, subscribe, contactMethod, interests empty/unselected; caseId untouched with reason. The template phone value must be cleared. |
| 3 | `profile.csv` | Fill the form from the single CSV row | name=Maya Chen; email=maya@example.test; subscribe=false; contactMethod=Email; country=SG; interests=[Music] | phone empty; caseId untouched. False is a sourced checkbox write and appears in filledFields, separate from unknown checkboxes. |
| 4 | `conflicting.txt` | Fill uncontested facts and leave conflicting values empty | name=Maya Chen | email and country empty with conflict reasons; phone, subscribe, contactMethod, interests missing; caseId untouched. No guessed source priority. |
| 5 | JSON `{"name":"TBD","country":"XX","invented":"value","caseId":"NEW"}` | Inspect fields and fill only valid supported values | none | All eight fields accounted for in unknowns; name stays empty despite required=true; caseId unchanged. Tools reject invented names, bad options, placeholders and readOnly writes. A corrected empty map may produce an editable blank output. |

For every successful case, download the PDF from the artifact card, reopen it in
a PDF viewer and verify that all eight fields are still editable except caseId.
The structured values must match the downloaded PDF, not just the prose. No
`[evidence]`/`[证据]` placeholders or unavailable IDs are accepted. Re-run case 1
with an API restart after `pdf.fill`; the persisted output must still download
with the same SHA-256. Check that another owner or tenant cannot download it.

## Transport and persistence

The material shape remains `{title, source, content}`. PDF `content` is explicitly
`data:application/pdf;base64,` followed by canonical base64; binary data cannot be
silently treated as ordinary text. Both input and output PDFs are capped at
256 KiB decoded. Text materials retain the existing 30,000 character cap.
`fillable-pdf/1` requires exactly one marked PDF material. The workbench encodes
PDF uploads without truncating them; the HTTP body limit is 1,100,000 bytes to
accommodate one PDF plus existing text materials.

`Run.pdfOutputs` is an optional array in the existing File/JSONB Run aggregate:
ref, sourceRef, filename, sha256, sizeBytes, encoding=base64,
mediaType=application/pdf, marked content, and the actual write manifest. It
also retains bounded field metadata for reporting unknowns. There is no new
table or database migration. A Run retains at most eight distinct PDF outputs;
the ref binds bytes, source, filename and write manifest so old artifact links
remain valid. Model prompts receive a binary descriptor and tool metadata, never
base64. PDF tools share existing source page/character and model iteration limits.

The structured artifact contains `output.ref` pointing to that output record.
`GET /api/runs/:id/artifacts/:artifactId/download` uses the existing Run access
checks and serves `application/pdf` for this domain, after checking the bytes'
hash and size. Existing domains continue to download Markdown.

## Conservative defaults

`pdf.formFields` supports exact names, five field types, values, options,
required/readOnly flags, multiselect, and 1-based page when available. Its
offset/limit continuation bounds each result to 6,000 characters; forms are
limited to 200 fields. `pdf.fill` takes the complete desired `{fieldName: value}`
map and rebuilds from the original template each time. It clears all omitted
writable fields, preserves readOnly fields, updates appearances, and never
flattens. Even a no-source run must call `pdf.fill` with `{}` and report every
field in unknowns.

Encrypted PDFs, XFA, buttons/signature fields and non-form PDFs are rejected.
Text that cannot be rendered by the available PDF font is rejected with a
recoverable tool error; it is never silently replaced or transliterated. Custom
font embedding, larger size caps and flattening remain future product choices.
Unknowns must use `{field, text, evidenceRefs}` for each unfilled field; a
readOnly field is explicitly untouched with a reason. False checkbox writes
require source evidence. Required flags never justify invented values.

Finish validation reparses the persisted PDF with pdf-lib and rejects absent
source evidence, unknown/duplicate field names, placeholders, mismatched values,
unreported writes, incomplete unknowns, and incorrect output metadata. Invalid
finishes use the existing one-repair mechanism. Limited-evidence finishes cannot
drop unsupported claims while retaining the corresponding PDF writes. Reviewer
instructions repeat these rules and receive bounded PDF tool observations.

The deterministic HTTP fixture model covers the small form plus intact JSON
sources. Its accepted review proves the execution/persistence contract; cases
using prose, CSV or conflicting facts also need real-model retesting.
