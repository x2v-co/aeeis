import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { HttpModelAdapter } from '../src/runtime/model.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { decodePdfMaterial, pdfSha256 } from '../src/runtime/pdf-material.js';
import { sourceReadUsage } from '../src/runtime/execution-limits.js';
import { pdfArtifact, formContent, profileContent, profile } from './fillable-pdf-fixture.js';
import { createFixtureModelServer } from '../scripts/fixture-model.mjs';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const materials = [{ title: 'registration.pdf', source: 'upload:registration.pdf', content: formContent }, { title: 'profile.json', source: 'upload:profile.json', content: profileContent }];
const plan = { summary: 'Fill PDF', nodes: [{ id: 'fill', title: 'Fill', instruction: 'Fill only sourced values', dependsOn: [] }] };

async function setup(options: { alter?: (finish: any, input: any) => unknown; fields?: Record<string, string | boolean | string[]>; invalidTool?: boolean; resourceAlias?: string; limits?: any; model?: ModelAdapter } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-fillable-pdf-'));
  let repository = new FileRunRepository(directory); await repository.init();
  cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const complete = vi.fn(async (request: ModelRequest) => {
    expect(JSON.stringify(request)).not.toContain(formContent.slice(0, 100));
    if (request.system.includes('Plan a real deliverable')) return { value: plan };
    if (request.system.includes('Independently review')) {
      expect(request.system).toContain('Reviewer: reject');
      expect(request.system).toContain('Required fields without evidence stay empty');
      const input = request.input as any;
      expect(input.sourceObservations.some((item: any) => item.tool === 'pdf.fill')).toBe(true);
      expect(input.artifacts[0].structured.schemaVersion).toBe('fillable-pdf/1');
      return { value: { verdict: 'accepted', summary: 'Verified source evidence and output fields', issues: [] } };
    }
    const input = request.input as any, formRef = input.sourceCatalog[0].id, sourceRef = input.sourceCatalog[1].id;
    expect(input.expectedArtifactType).toBe('fillable-pdf/1');
    if (!input.observations.length) return { value: { type: 'tool', tool: 'pdf.formFields', argument: options.resourceAlias ?? formRef } };
    const filled = input.observations.find((item: any) => item.tool === 'pdf.fill' && item.result.output)?.result;
    if (!filled) {
      const hadError = input.observations.some((item: any) => item.result.error);
      return { value: { type: 'tool', tool: 'pdf.fill', argument: options.resourceAlias ?? formRef, fields: options.invalidTool && !hadError ? { invented: 'Bad' } : options.fields ?? profile } };
    }
    const finish = { type: 'finish', title: 'Filled PDF', content: `Filled sourced values [${sourceRef}]; phone is empty and caseId untouched [${formRef}].`, evidenceRefs: [sourceRef, formRef, filled.output.ref], artifactType: 'fillable-pdf/1', structured: pdfArtifact({ ...filled.output, writtenFields: filled.filledFields }, formRef, sourceRef) };
    return { value: options.alter ? options.alter(finish, input) : finish };
  });
  const model = options.model ?? { pin: { model: 'pdf-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete };
  let engine = new AgentEngine(repository, { model, executionLimits: options.limits });
  const appOptions = () => ({ repository, engine, dispatcher: { notify: async () => {}, close: async () => {} }, principalTokens: {
    alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] as const }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] as const }, outsider: { id: 'alice', tenantId: 'team-b', roles: ['owner'] as const },
  } });
  let app = buildApp(appOptions()); cleanup.push(async () => { await app.close(); });
  const created = await app.inject({ method: 'POST', url: '/api/runs', headers: { authorization: 'Bearer alice' }, payload: { goal: 'Fill the registration PDF using source evidence', builtinSkill: 'fillable-pdf/1', materials } });
  expect(created.statusCode, created.body).toBe(202);
  const id = created.json().id;
  expect(await engine.advance(id)).toBe('needs_approval');
  const proposed = await repository.get(id);
  expect(proposed.resourceSnapshot?.skill).toMatchObject({ id: 'fillable-pdf', interface: 'fillable-pdf/1', digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await engine.command(id, 'approve', { planHash: proposed.plans[0]!.hash, planVersion: proposed.plans[0]!.version });
  return { id, complete, get engine() { return engine; }, get repository() { return repository; }, get app() { return app; },
    async restart() {
      await app.close(); await repository.close(); repository = new FileRunRepository(directory); await repository.init();
      engine = new AgentEngine(repository, { model }); app = buildApp(appOptions());
    },
    async drain() {
      for (let attempt = 0; attempt < 12; attempt++) { const status = await engine.advance(id); if (status === 'succeeded' || status === 'failed') return repository.get(id); }
      throw new Error('PDF run did not terminate');
    },
  };
}

describe('fillable PDF execution and downloads', () => {
  it.each([
    ['pdf1 run_4e0fa30e', 'normal'], ['pdf2 run_64943ccc', 'null-output'],
    ['pdf3 run_febf1391', 'final-tool'], ['pdf4 run_0f8a1b50', 'normal'],
    ['pdf5 run_9da5581d', 'alias'], ['pdf6 run_b1917541', 'redundant-capability'],
  ])('%s local replay validates persisted fields and reaches accepted review', async (_name, mode) => {
    const logs: any[] = [];
    vi.spyOn(console, 'warn').mockImplementation(line => logs.push(JSON.parse(String(line))));
    try {
      const fixture = await setup({ resourceAlias: mode === 'alias' ? 'upload:registration.pdf' : undefined, fields: mode === 'alias' ? {} : undefined,
        limits: mode === 'final-tool' ? { maxNodeSourcePages: 2 } : undefined,
        alter: finish => {
          if (mode === 'null-output') finish.structured.output = null;
          if (mode === 'final-tool' || mode === 'redundant-capability') return { type: 'capability', toolId: 'pdf.fill', toolVersion: '1', input: {}, purpose: 'Repeat PDF fill' };
          return finish;
        } });
      const run = await fixture.drain();
      expect(run.status, run.error).toBe('succeeded'); expect(run.review?.verdict).toBe('accepted');
      expect(run.pdfOutputs).toHaveLength(1); expect(run.artifacts).toHaveLength(1);
      expect(run.artifacts[0]?.structured).toMatchObject({ schemaVersion: 'fillable-pdf/1', filledFields: mode === 'alias' ? [] : expect.arrayContaining([{ name: 'email', value: profile.email, evidenceRefs: [run.context.sources[1]!.id] }]) });
      if (mode === 'alias') expect(run.artifacts[0]?.structured?.unknowns).toHaveLength(8);
      expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
      if (mode === 'null-output') expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-pdf-finish-synthesized/1', runId: run.id }));
      if (mode === 'alias') expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-source-resource-resolved/1', runId: run.id }));
      if (mode.includes('tool') || mode === 'redundant-capability') expect(logs).toContainEqual(expect.objectContaining({ protocol: 'aeeis-pdf-auto-finish/1', runId: run.id, reason: mode === 'final-tool' ? 'final-call-tool-dropped' : 'redundant-call-dropped' }));
    } finally { vi.restoreAllMocks(); }
  });

  it('rejects requests with zero or two PDFs before creating a run', async () => {
    const fixture = await setup();
    for (const uploads of [[], [materials[0], materials[0]]]) {
      const response = await fixture.app.inject({ method: 'POST', url: '/api/runs', headers: { authorization: 'Bearer alice' }, payload: { goal: 'Fill form', builtinSkill: 'fillable-pdf/1', materials: uploads } });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('exactly one');
    }
  });
  it('lists, fills, validates, reviews and downloads the persisted editable PDF across restart', async () => {
    const fixture = await setup();
    await fixture.engine.advance(fixture.id); await fixture.engine.advance(fixture.id);
    const filled = await fixture.repository.get(fixture.id);
    expect(filled.pdfOutputs).toHaveLength(1);
    expect(sourceReadUsage(filled.steps).pages).toBe(2);
    await fixture.restart();
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.review?.verdict).toBe('accepted');
    expect(run.artifacts[0]?.structured).toMatchObject({ schemaVersion: 'fillable-pdf/1', form: { fieldCount: 8 }, unknowns: [{ field: 'phone' }, { field: 'caseId' }] });
    expect(run.allowedTools).toEqual([]); expect(run.toolReceipts).toHaveLength(1);
    expect(run.toolReceipts[0]).toMatchObject({ operation: 'pdf.fill', outputRefs: [run.pdfOutputs![0]!.ref], authorization: { decision: 'authorized', taskId: 'fill' } });
    const url = `/api/runs/${run.id}/artifacts/${run.artifacts[0]!.id}/download`;
    const response = await fixture.app.inject({ url, headers: { authorization: 'Bearer alice' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe('attachment; filename="filled-form.pdf"');
    expect(response.headers['cache-control']).toBe('no-store');
    const bytes = decodePdfMaterial(run.pdfOutputs![0]!.content);
    expect(response.rawPayload).toEqual(bytes);
    const form = (await PDFDocument.load(response.rawPayload)).getForm();
    expect(form.getFields()).toHaveLength(8);
    expect(form.getTextField('phone').getText() ?? '').toBe('');
    expect(form.getTextField('caseId').getText()).toBe('FORM-001');
    expect(pdfSha256(response.rawPayload)).toBe(run.pdfOutputs![0]!.sha256);
    expect((await fixture.app.inject({ url })).statusCode).toBe(401);
    for (const token of ['bob', 'outsider']) expect((await fixture.app.inject({ url, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    await fixture.repository.mutate(run.id, current => { current.pdfOutputs![0]!.content = current.context.sources[0]!.content; });
    expect((await fixture.app.inject({ url, headers: { authorization: 'Bearer alice' } })).statusCode).toBe(409);
  });
  it('returns a recoverable error for an invented field, then accepts a corrected fill', async () => {
    const fixture = await setup({ invalidTool: true });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded'); expect(run.pdfOutputs).toHaveLength(1);
    expect(run.events.filter(event => event.type === 'tool.failed_recoverable')).toHaveLength(1);
    expect(run.steps[0]!.observations.find(item => (item.result as any).error)?.result).toMatchObject({ error: { recoverable: true, message: 'Unknown form field: invented' } });
  });
  it.each(['evidence', 'value', 'unknownField', 'missingUnknown', 'placeholder', 'placeholderContent', 'unknownId', 'outputHash', 'missingStructured'] as const)('repairs and rejects invalid %s before review', async problem => {
    const fixture = await setup({ alter: (finish, input) => {
      if (problem === 'evidence') finish.structured.filledFields[0].evidenceRefs = [input.sourceCatalog[0].id];
      if (problem === 'value') finish.structured.filledFields[0].value = 'Forged';
      if (problem === 'unknownField') finish.structured.unknowns[0].field = 'invented';
      if (problem === 'missingUnknown') finish.structured.unknowns = [];
      if (problem === 'placeholder') finish.structured.filledFields[0].value = 'TBD';
      if (problem === 'placeholderContent') finish.content = 'Filled [evidence]';
      if (problem === 'unknownId') finish.structured.filledFields[0].evidenceRefs = ['source_00000000-0000-4000-8000-000000000000'];
      if (problem === 'outputHash') finish.structured.output.sha256 = '0'.repeat(64);
      if (problem === 'missingStructured') delete finish.structured;
      return finish;
    } });
    const run = await fixture.drain();
    expect(run.status).toBe('failed'); expect(run.artifacts).toEqual([]);
    expect(run.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(2);
    expect(run.error).toContain('retries exhausted');
    expect(run.review).toBeUndefined();
    expect(fixture.complete.mock.calls.some(([request]) => request.system.includes('Independently review'))).toBe(false);
  });
  it('normalizes evidence aliases, fragment refs and wrapped output, then repairs a mismatched value', async () => {
    const fixture = await setup({ alter: (finish, input) => {
      finish.structured.form.sourceRef = `source: ${input.sourceCatalog[0].id.toUpperCase()}`;
      finish.structured.filledFields.forEach((field: any) => { field.evidenceRefs = [`${input.sourceCatalog[1].id}#line1`]; });
      if (!input.outputRecovery) finish.structured.filledFields[0].value = 'Wrong';
      return { type: 'finish', result: finish };
    } });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(1);
    expect(run.artifacts[0]?.structured?.schemaVersion).toBe('fillable-pdf/1');
  });
  it('withholds a PDF write if its observation exceeds the source allowance', async () => {
    const fixture = await setup({ limits: { maxNodeSourceChars: 1 } });
    const run = await fixture.drain();
    expect(run.status).toBe('failed'); expect(run.pdfOutputs).toBeUndefined();
    expect(run.steps[0]!.observations[0]!.tool).toBe('pdf.formFields.limit');
  });
  it('accepts a complete PDF finish on the limited final call, with explicit limitations', async () => {
    const fixture = await setup({ limits: { maxNodeSourcePages: 2 } });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.artifacts[0]?.partial).toBe(true);
    expect(run.artifacts[0]?.structured?.schemaVersion).toBe('fillable-pdf/1');
  });
  it('preserves every unfilled field while moving runtime unknowns to finish limitations', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fixture = await setup({ fields: {}, alter: finish => {
        finish.content = `No fields filled; caseId untouched [${finish.structured.form.sourceRef}].`;
        finish.limitations = ['Source coverage is incomplete'];
        finish.structured.unknowns.push({ text: 'Tool limit reached', evidenceRefs: [finish.structured.form.sourceRef] });
        return finish;
      } });
      const run = await fixture.drain();
      expect(run.status, run.error).toBe('succeeded');
      expect(run.artifacts[0]).toMatchObject({ partial: true, limitations: ['Source coverage is incomplete', 'Tool limit reached'], structured: { filledFields: [] } });
      expect(run.artifacts[0]?.structured?.unknowns).toHaveLength(8);
      const logs = warnings.mock.calls.map(([message]) => JSON.parse(String(message)));
      expect(logs.filter(log => log.protocol === 'aeeis-finish-content-check/1')).toEqual([expect.objectContaining({ result: 'fixed', movedUnknowns: 1, cappedUnknowns: 0 })]);
      expect(logs.filter(log => log.protocol === 'aeeis-finish-evidence-check/1')).toEqual([expect.objectContaining({ result: 'ok' })]);
    } finally { warnings.mockRestore(); }
  });
  it('rejects invalid final-call evidence without pruning fields that remain written in the PDF', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fixture = await setup({ limits: { maxNodeSourcePages: 2 }, alter: finish => {
        finish.structured.filledFields[0].evidenceRefs = ['unreceived']; return finish;
      } });
      const run = await fixture.drain();
      expect(run.status).toBe('failed'); expect(run.artifacts).toEqual([]);
      expect(run.pdfOutputs?.[0]?.writtenFields).toHaveLength(6);
      expect(run.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(2);
      const logs = warnings.mock.calls.map(([message]) => JSON.parse(String(message)));
      expect(logs.filter(log => log.protocol === 'aeeis-finish-content-check/1')).toEqual(Array(3).fill(expect.objectContaining({ result: 'rejected' })));
      expect(logs.filter(log => log.protocol === 'aeeis-finish-evidence-check/1')).toEqual(Array(3).fill(expect.objectContaining({ result: 'rejected', invalidRefs: ['unreceived'], removedRefs: 0, droppedClaims: 0 })));
    } finally { warnings.mockRestore(); }
  });
  it('completes through the real HTTP fixture-model transport', async () => {
    const server = createFixtureModelServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const model = new HttpModelAdapter(`http://127.0.0.1:${address.port}/v1`, 'fixture', 'fixture', undefined, 5000);
    const fixture = await setup({ model });
    const run = await fixture.drain();
    expect(run.status, run.error).toBe('succeeded');
    expect(run.calls.map(call => call.phase)).toEqual(['planner', 'executor', 'executor', 'executor', 'reviewer']);
    expect(run.artifacts[0]?.structured).toMatchObject({ schemaVersion: 'fillable-pdf/1', output: { filename: 'registration-filled.pdf' } });
  });
});
