import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { AgentEngine } from '../src/runtime/engine.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import type { ModelRequest } from '../src/runtime/model.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { terminalizeRun } from '../src/runtime/terminalize-run.js';
import { buildApp } from '../src/runtime/http.js';
import { pdfArtifactContent, pdfOutputMetadata } from '../src/runtime/fillable-pdf.js';
import { decodePdfMaterial } from '../src/runtime/pdf-material.js';
import { pdfArtifact, formContent, profileContent, profile } from './fillable-pdf-fixture.js';

afterEach(() => vi.restoreAllMocks());

const lastFill = (input: any) => [...input.observations].reverse().find((item: any) => item.tool === 'pdf.fill' && item.result.output)?.result;
const fill = (input: any, fields = profile) => ({ type: 'tool', tool: 'pdf.fill', argument: input.sourceCatalog[0].id, fields });
function finish(input: any, result = lastFill(input)) {
  const structured = pdfArtifact({ ...result.output, writtenFields: result.filledFields }, input.sourceCatalog[0].id, input.sourceCatalog[1].id);
  return { type: 'finish', title: 'Registration form', content: pdfArtifactContent(structured), artifactType: 'fillable-pdf/1', structured, evidenceRefs: [input.sourceCatalog[0].id, input.sourceCatalog[1].id, result.output.ref] };
}
async function setup(decide: (input: any, request: ModelRequest) => unknown, options: { nodes?: any[]; limits?: any; review?: (input: any) => unknown; maxModelCalls?: number; caseContent?: string; caseTitle?: string } = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    const input = request.input as any;
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Fill registration', nodes: options.nodes ?? [{ id: 'fill', title: 'Fill', instruction: 'Fill only sourced fields', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: options.review?.(input) ?? { verdict: 'accepted', summary: 'Verified', issues: [] } };
    return { value: decide(input, request) };
  });
  const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
  let engine = new AgentEngine(repository, { model, executionLimits: options.limits });
  const run = await engine.create({ goal: 'Fill registration from case JSON, explaining every unresolved field', builtinSkill: 'fillable-pdf/1', maxModelCalls: options.maxModelCalls ?? 20,
    materials: [{ title: 'registration.pdf', source: 'upload', content: formContent }, { title: options.caseTitle ?? 'case.json', source: 'upload', content: options.caseContent ?? profileContent }] });
  await engine.advance(run.id);
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash, planVersion: (await repository.get(run.id)).plans[0]!.version });
  return { repository, id: run.id, complete, get engine() { return engine; }, restart() { engine = new AgentEngine(repository, { model }); }, async drain() {
    for (let i = 0; i < 30; i++) if (['succeeded', 'failed'].includes(await engine.advance(run.id))) return repository.get(run.id);
    throw new Error('Retest exceeded bounded turns');
  } };
}

describe('production PDF retest regressions', () => {
  it('finalizes verified PDF bytes as partial when tool recovery uses its three calls', async () => {
    let reviews = 0;
    const fixture = await setup(input => {
      if (!lastFill(input)) return fill(input);
      if (input.outputRecovery) return { type: 'tool', tool: 'sources.search', argument: 'registration' };
      return finish(input);
    }, { review: () => { reviews++; return { verdict: 'needs_revision', summary: 'Clarify gaps', issues: ['Explain remaining unknowns'] }; } });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
    expect(reviews).toBe(1);
    expect(run.calls.filter(call => call.phase === 'executor')).toHaveLength(5);
    expect(run.artifacts).toHaveLength(1);
    expect((run.artifacts[0]!.structured as any).output.sha256).toBe(run.pdfOutputs![0]!.sha256);
    expect(run.artifacts[0]!.limitations!.join(' ')).toContain('Output recovery call allowance exhausted');
    expect(run.artifacts[0]!.limitations!.join(' ')).toContain('Explain remaining unknowns');
    expect(run.events.find(event => event.type === 'artifact.recovery_fallback')?.data.validationNotes).toEqual([expect.objectContaining({ code: 'review_revision' })]);
  });

  it('fails clearly when exhausted recovery has no valid candidate or stored PDF', async () => {
    const fixture = await setup(() => ({ type: 'tool', tool: 'sources.search', argument: 'registration' }));
    await fixture.repository.mutate(fixture.id, run => {
      run.steps[0]!.outputRecovery = { reason: 'Missing PDF output', candidate: { type: 'finish', title: 'Invalid', content: 'No PDF', evidenceRefs: [] }, problems: [{ path: 'structured.output', code: 'artifact_contract', message: 'Missing PDF output' }], toolsAllowed: false, callOffset: 0, exhausted: true };
    });
    const run = await fixture.drain();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('no valid artifact candidate remains');
    expect(run.error).toContain('Missing PDF output');
    expect(run.calls).toHaveLength(1); // No speculative recovery call.
    expect(run.artifacts).toEqual([]);
  });
  it.each(['finish', 'repair', 'review', 'review-repair', 'revision', 'revised-fill'] as const)('preserves the PDF and unknown billing receipt when %s is interrupted', async phase => {
    let reviews = 0;
    const interrupted = () => { throw new ModelOutcomeUnknown('Model request connection was interrupted; reconcile before retrying'); };
    const fixture = await setup(input => {
      if (!lastFill(input)) return fill(input);
      if (phase === 'finish' || phase === 'repair' && input.outputRecovery) return interrupted();
      if (input.outputRecovery?.problems[0].code === 'review_revision') {
        if (phase === 'revised-fill' && input.observations.filter((item: any) => item.tool === 'pdf.fill').length === 1) return fill(input, { name: profile.name });
        return interrupted();
      }
      const decision = finish(input);
      if (phase === 'repair') decision.structured.filledFields = [];
      return decision;
    }, { review: () => {
      reviews++;
      if (phase === 'review' || phase === 'review-repair' && reviews > 1) return interrupted();
      if (phase === 'review-repair') return { verdict: 'invalid' };
      return { verdict: 'needs_revision', summary: 'Explain fields', issues: ['Explain unresolved fields'] };
    } });
    const run = await fixture.drain();
    expect(run).toMatchObject({ status: 'succeeded', partial: true });
    expect(run.error).toBeUndefined();
    expect(run.artifacts).toHaveLength(1);
    const artifact = run.artifacts[0]!;
    expect(artifact.structured).toMatchObject({ schemaVersion: 'fillable-pdf/1', output: pdfOutputMetadata(run.pdfOutputs!.at(-1)!) });
    expect(artifact.content).toContain(profile.name);
    expect(run.limitations!.join(' ')).toContain('Independent review was not completed');
    const unknown = run.calls.at(-1)!;
    expect(unknown.state).toBe('unknown');
    const count = fixture.complete.mock.calls.length;
    fixture.restart();
    expect(await fixture.engine.advance(run.id)).toBe('succeeded');
    expect((await terminalizeRun(fixture.repository, run.id, 'Activity timeout')).artifacts).toEqual(run.artifacts);
    expect(fixture.complete).toHaveBeenCalledTimes(count);
    // Later provider confirmation settles the receipt; it must not run review again.
    await fixture.engine.reconcileModelCall(run.id, { callId: unknown.id, inputHash: unknown.inputHash, idempotencyKey: unknown.idempotencyKey,
      outcome: 'completed', output: { verdict: 'accepted', summary: 'Late result' }, usage: { inputTokens: 12, outputTokens: 3 }, reason: 'Provider audit' });
    const settled = await fixture.repository.get(run.id);
    expect(settled.status).toBe('succeeded');
    expect(settled.calls.at(-1)).toMatchObject({ state: 'discarded', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(settled.artifacts).toEqual(run.artifacts);
  });

  it('keeps a genuine first executor unknown without a produced PDF reconcilable', async () => {
    const fixture = await setup(() => { throw new ModelOutcomeUnknown('First request outcome unknown'); });
    expect(await fixture.engine.advance(fixture.id)).toBe('unknown');
    expect(await fixture.engine.advance(fixture.id)).toBe('unknown');
    const run = await fixture.repository.get(fixture.id);
    expect(run.artifacts).toEqual([]);
    expect(run.pdfOutputs).toBeUndefined();
    expect(run.calls.at(-1)!.state).toBe('unknown');
    expect(fixture.complete).toHaveBeenCalledTimes(2);
  });

  it('terminalizes an activity timeout after pdf.fill with a verified artifact', async () => {
    const fixture = await setup(input => fill(input));
    await fixture.engine.advance(fixture.id);
    const filled = await fixture.repository.get(fixture.id);
    expect(filled.artifacts).toEqual([]);
    const run = await terminalizeRun(fixture.repository, fixture.id, 'Activity timeout during finish');
    expect(run).toMatchObject({ status: 'succeeded', partial: true });
    expect(run.artifacts[0]!.structured).toMatchObject({ output: pdfOutputMetadata(filled.pdfOutputs![0]!) });
  });

  it('returns a downloadable unverified PDF draft when field evidence cannot be reconstructed after an unknown finish', async () => {
    const fixture = await setup(input => {
      if (!lastFill(input)) return fill(input, { country: 'SG' });
      throw new ModelOutcomeUnknown('Finish connection interrupted');
    }, { caseContent: '{"country":"Singapore"}' });
    const run = await fixture.drain();
    expect(run).toMatchObject({ status: 'succeeded', partial: true });
    const artifact = run.artifacts[0]!;
    expect(artifact.structured).toBeUndefined();
    expect(artifact.retainedPdfOutput).toMatchObject(pdfOutputMetadata(run.pdfOutputs![0]!));
    expect(artifact.content).toContain('Unverified PDF draft');
    expect(artifact.limitations!.join(' ')).toContain('field evidence could not be validated');
    const app = buildApp({ repository: fixture.repository, engine: fixture.engine });
    try {
      const url = `/api/runs/${run.id}/artifacts/${artifact.id}/download`;
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.rawPayload).toEqual(decodePdfMaterial(run.pdfOutputs![0]!.content));
      await fixture.repository.mutate(run.id, current => { current.pdfOutputs![0]!.sizeBytes++; });
      // Download metadata is pinned to the retained artifact and checked against actual bytes.
      expect((await app.inject({ url })).statusCode).toBe(200);
      await fixture.repository.mutate(run.id, current => { current.pdfOutputs![0]!.content = current.context.sources[0]!.content; });
      expect((await app.inject({ url })).statusCode).toBe(409);
    } finally { await app.close(); }
  });

  it('PDF3: accepts CSV row and column citations on map_csv_to_fields', async () => {
    const fixture = await setup(input => {
      if (!lastFill(input)) return fill(input, { contactMethod: 'Email' });
      const decision = finish(input);
      decision.structured.filledFields[0]!.evidenceRefs = [`source: ${input.sourceCatalog[1].id.toUpperCase()}#row2:contactMethod`];
      return decision;
    }, { caseTitle: 'case.csv', caseContent: 'contactMethod\nEmail', nodes: [{ id: 'map_csv_to_fields', title: 'Map CSV', instruction: 'Fill from CSV', dependsOn: [] }] });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.artifacts[0]!.structured).toMatchObject({ filledFields: [{ name: 'contactMethod', value: 'Email', evidenceRefs: [run.context.sources[1]!.id] }] });
    expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
  });

  it.each(['cite', 'clear'] as const)('PDF3: repairs repeated identical field evidence rejection by choosing to %s', async mode => {
    let rejected = 0;
    const fixture = await setup((input, request) => {
      if (!lastFill(input)) return fill(input, { contactMethod: 'Email' });
      if (input.outputRecovery) {
        expect(request.system).toContain('cite the received non-PDF source id or re-run pdf.fill without that field');
        expect(input.outputRecovery.reason).toContain('list it in unknowns with a reason');
        if (rejected === 2 && mode === 'clear' && lastFill(input).filledFields.length) return fill(input, {});
      }
      const decision = finish(input);
      if (rejected++ < 2) decision.structured.filledFields[0]!.evidenceRefs = [lastFill(input).output.ref];
      return decision;
    }, { caseTitle: 'case.csv', caseContent: 'contactMethod\nEmail' });
    await fixture.engine.advance(fixture.id);
    await fixture.engine.advance(fixture.id);
    await fixture.engine.advance(fixture.id);
    expect(await fixture.repository.get(fixture.id)).toMatchObject({ status: 'running', steps: [{ outputRecoveryAttempts: 2 }] });
    fixture.restart();
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(2);
    expect(run.pdfOutputs!.at(-1)!.writtenFields).toEqual(mode === 'cite' ? [{ name: 'contactMethod', value: 'Email' }] : []);
    if (mode === 'clear') expect(run.artifacts[0]!.structured!.unknowns).toContainEqual(expect.objectContaining({ field: 'contactMethod', text: expect.any(String) }));
  });

  it.each(['structured', 'clear'] as const)('PDF2: repairs inferred country by choosing %s evidence', async mode => {
    const text = 'country="SG" follows from Singapore';
    const fixture = await setup((input, request) => {
      if (!lastFill(input)) return fill(input, { country: 'SG' });
      if (input.outputRecovery) {
        expect(input.outputRecovery.reason).toContain('Otherwise leave it empty with a reason in unknowns');
        expect(request.system).toContain('structured.inferences');
        if (mode === 'clear' && lastFill(input).filledFields.length) return fill(input, {});
      }
      const decision = finish(input);
      if (mode === 'structured' || !input.outputRecovery) decision.content += `\n建议${text}`;
      if (mode === 'structured' && input.outputRecovery) decision.structured.inferences = [{ field: 'country', value: 'SG', text: `建议${text}`, evidenceRefs: [input.sourceCatalog[1].id] }];
      return decision;
    }, { caseContent: '{"country":"Singapore"}', limits: { maxNodeSourcePages: 1 } });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.steps[0]!.outputRecoveryAttempts).toBe(1);
    const artifact = run.artifacts[0]!;
    if (mode === 'structured') {
      expect(artifact.content).toContain(`推断：建议${text}`);
      expect(artifact.structured).toMatchObject({ filledFields: [{ name: 'country', value: 'SG' }], inferences: [{ field: 'country', value: 'SG' }] });
      expect(run.steps[0]!.observations.some(observation => observation.tool === 'output.warning')).toBe(false);
    } else {
      expect((await PDFDocument.load(decodePdfMaterial(run.pdfOutputs!.at(-1)!.content))).getForm().getDropdown('country').getSelected()).toEqual([]);
      expect(artifact.structured!.unknowns).toContainEqual(expect.objectContaining({ field: 'country', text: expect.any(String) }));
    }
  });

  it('PDF3: records inspection-task writes and repairs an omitted manifest on the final limited call', async () => {
    let stored: any;
    const fixture = await setup(input => {
      if (input.task.id === 'inspect_pdf_fields' && !lastFill(input)) return fill(input);
      stored = lastFill(input) ?? stored;
      if (input.task.id === 'document') {
        expect(input.pdfOutputs[0].filledFields).toEqual(stored.filledFields);
        expect(input.availableEvidenceRefs).toContain(input.pdfOutputs[0].output.ref);
      }
      const decision = finish(input, stored);
      if (input.task.id === 'inspect_pdf_fields' && !input.outputRecovery) decision.structured.filledFields = [];
      return decision;
    }, { limits: { maxNodeSourcePages: 1 }, nodes: [
      { id: 'inspect_pdf_fields', title: 'Inspect', instruction: 'Inspect and fill', dependsOn: [] },
      { id: 'document', title: 'Document', instruction: 'Explain fields and unknowns', dependsOn: ['inspect_pdf_fields'] },
    ] });
    await fixture.engine.advance(fixture.id); // Persist actual write before restart.
    fixture.restart();
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.toolReceipts).toHaveLength(1);
    expect(run.toolReceipts[0]).toMatchObject({ operation: 'pdf.fill', capabilitiesUsed: ['write'], inputRefs: [run.context.sources[0]!.id], outputRefs: [run.pdfOutputs![0]!.ref], authorization: { taskId: 'inspect_pdf_fields', decision: 'authorized' } });
    expect(run.steps[0]!.outputRecoveryAttempts).toBe(1);
    expect(run.calls.find(call => call.validationErrors?.some(issue => issue.path === 'structured.filledFields'))?.validationErrors?.[0]?.message).toContain('Missing writes');
    for (const artifact of run.artifacts) expect((artifact.structured as any).filledFields.map(({ name, value }: any) => ({ name, value }))).toEqual(run.pdfOutputs![0]!.writtenFields);
  });

  it.each(['missing', 'invented'] as const)('PDF4: rejects %s PDF output, then allows pdf.fill across restart', async mode => {
    const fixture = await setup((input, request) => {
      if (input.outputRecovery) {
        expect(request.system).toContain('Tools are allowed');
        expect(input.executionBudget.finalOnly).toBe(false);
        expect(input.outputRecovery.reason).toContain('No matching stored PDF exists');
        return lastFill(input) ? finish(input) : fill(input);
      }
      const structured: any = { schemaVersion: 'fillable-pdf/1', form: { sourceRef: input.sourceCatalog[0].id, fieldCount: 8 }, filledFields: [], unknowns: [], blockers: [] };
      if (mode === 'invented') structured.output = { filename: 'filled-form.pdf', sha256: 'a'.repeat(64), sizeBytes: 1, ref: 'pdf_invented' };
      return { type: 'finish', title: 'Form', content: 'Needs filling.', artifactType: 'fillable-pdf/1', structured, evidenceRefs: [input.sourceCatalog[0].id] };
    }, { limits: { maxNodeIterations: 2 } });
    await fixture.engine.advance(fixture.id);
    expect(await fixture.repository.get(fixture.id)).toMatchObject({ status: 'running', steps: [{ outputRecovery: { toolsAllowed: true } }] });
    fixture.restart();
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.artifacts[0]!.structured).toMatchObject({ output: pdfOutputMetadata(run.pdfOutputs![0]!) });
    expect(run.toolReceipts).toHaveLength(1);
  });

  it('PDF4: rejects a missing fill with feedback and fails only after two retries', async () => {
    const fixture = await setup(input => ({ type: 'finish', title: 'Form', content: 'Unwritten form.', artifactType: 'fillable-pdf/1', evidenceRefs: [input.sourceCatalog[0].id],
      structured: { schemaVersion: 'fillable-pdf/1', form: { sourceRef: input.sourceCatalog[0].id, fieldCount: 8 }, filledFields: [], unknowns: [], blockers: [] } }));
    const run = await fixture.drain();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('retries exhausted');
    expect(run.calls.filter(call => call.phase === 'executor')).toHaveLength(3);
    expect(run.pdfOutputs).toBeUndefined();
  });

  it('PDF5: feeds independent review issues back, permits a revised fill, and produces a specific document', async () => {
    let reviews = 0;
    const issue = 'Fill the supported case values and explain phone and read-only caseId with PDF and case JSON citations; the document is too generic.';
    const fixture = await setup((input, request) => {
      if (!lastFill(input)) return fill(input, {});
      if (input.outputRecovery?.problems[0].code === 'review_revision') {
        expect(input.outputRecovery.reason).toContain(issue);
        expect(request.system).toContain('Tools are allowed');
        expect(input.executionBudget.finalOnly).toBe(false);
        if (!lastFill(input).filledFields.length) return fill(input);
      }
      const decision = finish(input);
      if (!input.outputRecovery) decision.content = 'PDF ready.';
      return decision;
    }, { limits: { maxNodeSourcePages: 1 }, review: input => ++reviews === 1 ? { verdict: 'needs_revision', summary: 'Document too generic', issues: [issue] } : { verdict: 'accepted', summary: 'Specific supported document', issues: [] } });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(reviews).toBe(2);
    expect(run.pdfOutputs).toHaveLength(2);
    expect(run.toolReceipts).toHaveLength(2);
    expect(run.artifacts).toHaveLength(1);
    expect(run.artifacts[0]!.content).toContain('Maya Chen');
    expect(run.artifacts[0]!.content).toContain('phone: No source value; left empty.');
    expect(run.artifacts[0]!.content).toContain('caseId: Read-only');
    expect((run.artifacts[0]!.structured as any).unknowns.every((item: any) => item.evidenceRefs.includes(run.context.sources[1]!.id))).toBe(true);
    const form = (await PDFDocument.load(decodePdfMaterial(run.pdfOutputs!.at(-1)!.content))).getForm();
    expect(form.getTextField('name').getText()).toBe(profile.name);
    expect(form.getTextField('caseId').getText()).toBe('FORM-001');
    expect(form.getTextField('phone').getText() ?? '').toBe('');
  });

  it('PDF5: rejects TBD, XX and read-only NEW writes, then repairs missing case citations while leaving fields untouched', async () => {
    const attempts = [{ name: 'TBD' }, { country: 'XX' }, { caseId: 'NEW' }];
    const fixture = await setup(input => {
      const failures = input.observations.filter((item: any) => item.result.error?.errorCode === 'pdf_input');
      if (!lastFill(input)) return fill(input, attempts[failures.length] ?? {});
      const decision = finish(input);
      for (const unknown of decision.structured.unknowns) {
        if (unknown.field === 'name') unknown.text = 'Case name is a placeholder; left empty.';
        if (unknown.field === 'country') unknown.text = 'Case country is a placeholder and not an allowed SG/US choice; left empty.';
      }
      decision.content = pdfArtifactContent(decision.structured);
      if (!input.outputRecovery) for (const unknown of decision.structured.unknowns) unknown.evidenceRefs = [input.sourceCatalog[0].id];
      return decision;
    }, { caseContent: JSON.stringify({ name: 'TBD', country: 'XX', caseId: 'NEW' }) });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.events.filter(event => event.type === 'tool.failed_recoverable')).toHaveLength(3);
    expect(run.steps[0]!.outputRecoveryAttempts).toBe(1);
    expect(run.pdfOutputs).toHaveLength(1);
    expect(run.toolReceipts).toHaveLength(1);
    const form = (await PDFDocument.load(decodePdfMaterial(run.pdfOutputs![0]!.content))).getForm();
    expect(form.getTextField('name').getText() ?? '').toBe('');
    expect(form.getDropdown('country').getSelected()).toEqual([]);
    expect(form.getTextField('caseId').getText()).toBe('FORM-001');
    expect(run.artifacts[0]!.content).toContain('left empty');
    expect((run.artifacts[0]!.structured as any).unknowns).toHaveLength(8);
  });

  it('PDF5: limits repeated independent-review revisions', async () => {
    const fixture = await setup(input => lastFill(input) ? finish(input) : fill(input), { review: () => ({ verdict: 'needs_revision', summary: 'Still incomplete', issues: ['Explain the unresolved fields'] }) });
    const run = await fixture.drain();
    expect(run.status).toBe('failed');
    expect(run.events.filter(event => event.type === 'review.revision_requested')).toHaveLength(2);
    expect(run.calls.filter(call => call.phase === 'reviewer')).toHaveLength(3);
  });

  it.each(['sha256', 'sizeBytes', 'ref', 'title', 'content'] as const)('PDF finish repairs invalid %s on a limited final call', async field => {
    const fixture = await setup(input => {
      if (!lastFill(input)) return fill(input);
      const decision = finish(input);
      if (!input.outputRecovery) {
        if (field === 'sha256') decision.structured.output.sha256 = 'not-a-hash';
        else if (field === 'sizeBytes') decision.structured.output.sizeBytes = 0;
        else if (field === 'ref') decision.structured.output.ref = '';
        else decision[field] = '';
      }
      return decision;
    }, { limits: { maxNodeSourcePages: 1 } });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.steps[0]!.outputRecoveryAttempts).toBe(1);
    expect(run.artifacts[0]!.structured).toMatchObject({ output: pdfOutputMetadata(run.pdfOutputs![0]!) });
  });

  it('recovery preserves the hard Run model budget', async () => {
    const fixture = await setup(input => ({ type: 'finish', title: 'Form', content: 'Unwritten form.', artifactType: 'fillable-pdf/1', evidenceRefs: [input.sourceCatalog[0].id] }), { maxModelCalls: 3 });
    const run = await fixture.drain();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Model call budget exhausted');
    expect(run.calls).toHaveLength(3);
  });
});
