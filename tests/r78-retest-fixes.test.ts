import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine, allocateModelCallTimeout } from '../src/runtime/engine.js';
import { ModelTimeout, type ModelAdapter, type ModelRequest } from '../src/runtime/model.js';
import { fillPdf, validateFillablePdfArtifact } from '../src/runtime/fillable-pdf.js';
import { baseEvidenceRef, evidenceIdShape } from '../src/runtime/evidence-refs.js';
import { executionLimitReason, executionLimitsSchema } from '../src/runtime/execution-limits.js';
import { inferenceFidelityProblems, labelInferences } from '../src/runtime/sourceFidelityRules.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { formContent, formSource, pdfArtifact, profileContent, profileSource } from './fillable-pdf-fixture.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');

describe('r78 pdf2: filled-field evidence', () => {
  it('accepts a dropdown that cites the case source plus the form PDF, and keeps only the case source', async () => {
    const output = await fillPdf(formSource, { name: 'Maya Chen', email: 'maya@example.test', country: 'SG' });
    const artifact = pdfArtifact(output);
    artifact.filledFields.find(field => field.name === 'country')!.evidenceRefs = [profileSource.id, formSource.id, output.ref];
    const observed = new Set([formSource.id, profileSource.id, output.ref]);
    await expect(validateFillablePdfArtifact(artifact, [formSource, profileSource], [output], observed)).resolves.toBeUndefined();
    expect(artifact.filledFields.find(field => field.name === 'country')!.evidenceRefs).toEqual([profileSource.id]);
  });
  it('still rejects a filled field cited only to the form PDF or to unreceived evidence', async () => {
    const output = await fillPdf(formSource, { country: 'SG' });
    const observed = new Set([formSource.id, profileSource.id, output.ref]);
    const onlyForm = pdfArtifact(output); onlyForm.filledFields[0]!.evidenceRefs = [formSource.id];
    await expect(validateFillablePdfArtifact(onlyForm, [formSource, profileSource], [output], observed)).rejects.toThrow('must cite received source evidence: country');
    const unreceived = pdfArtifact(output); unreceived.filledFields[0]!.evidenceRefs = [profileSource.id, 'source_not_received_anywhere_0000'];
    await expect(validateFillablePdfArtifact(unreceived, [formSource, profileSource], [output], observed)).rejects.toThrow('must cite received source evidence: country');
  });
});

describe('r78 pdf5: empty writes and template placeholders', () => {
  it('treats "" and [] as omissions instead of a tool error', async () => {
    const output = await fillPdf(formSource, { name: 'Maya Chen', phone: '', interests: [], subscribe: false });
    expect(output.writtenFields.map(field => field.name).sort()).toEqual(['name', 'subscribe']);
    expect(output.unfilledFields.map(field => field.name)).toContain('phone');
  });
  it('rejects copying a template placeholder value', async () => {
    await expect(fillPdf(formSource, { phone: 'TEMPLATE PHONE' })).rejects.toThrow('Placeholder value rejected for field: phone');
  });
});

describe('r78 md/lt: evidence ref salvage', () => {
  const real = 'source_7f2559d3-015e-4d9f-87bf-40b86ee31bad';
  it('maps a one-character typo to the only close received id', () => {
    expect(baseEvidenceRef('source_7f259d3-015e-4d9f-87bf-40b86ee31bad', new Set([real]))).toBe(real);
  });
  it('never maps a near miss when another known id is equally close or the match was not received', () => {
    const sibling = 'source_7f2559d3-015e-4d9f-87bf-40b86ee31bae';
    expect(baseEvidenceRef('source_7f2559d3-015e-4d9f-87bf-40b86ee31baf', new Set([real]), new Set([real, sibling]))).toBe('source_7f2559d3-015e-4d9f-87bf-40b86ee31baf');
    expect(baseEvidenceRef('source_7f259d3-015e-4d9f-87bf-40b86ee31bad', new Set(['source_other']), new Set([real, 'source_other']))).toBe('source_7f259d3-015e-4d9f-87bf-40b86ee31bad');
  });
  it('strips closing JSON punctuation glued to an exact id, and recognises noise', () => {
    const id = 'source_02e55a1a-b68a-4953-bf8d-df1f6f3fdc72';
    expect(baseEvidenceRef(`${id}]}],`, new Set([id]))).toBe(id);
    expect(evidenceIdShape.test("owners':[],")).toBe(false);
    expect(evidenceIdShape.test(id)).toBe(true);
    expect(evidenceIdShape.test(`${id}#row=3`)).toBe(true);
  });
});

describe('r78 csv: model-call reserve for pending tasks and review', () => {
  const runWith = (calls: number, nodes: number) => ({
    maxModelCalls: 20, calls: Array.from({ length: calls }, (_, index) => ({ id: `c${index}`, phase: index ? 'executor' : 'planner', taskId: index ? 'n0' : undefined })),
    plans: [{ version: 1, nodes: Array.from({ length: nodes }, (_, index) => ({ id: `n${index}`, dependsOn: [] })) }],
    steps: Array.from({ length: nodes }, (_, index) => ({ taskId: `n${index}`, status: index ? 'pending' : 'running', observations: [] })),
  }) as unknown as AgentRun;
  const limits = executionLimitsSchema.parse({ maxNodeIterations: 100 });
  it('finalizes the current task early enough to leave one call per pending task plus the review', () => {
    expect(executionLimitReason(runWith(15, 4), runWith(15, 4).steps[0]!, limits)).toBe('Run model call budget nearly exhausted');
    expect(executionLimitReason(runWith(14, 4), runWith(14, 4).steps[0]!, limits)).toBeUndefined();
    expect(executionLimitReason(runWith(17, 1), runWith(17, 1).steps[0]!, limits)).toBeUndefined();
    expect(executionLimitReason(runWith(18, 1), runWith(18, 1).steps[0]!, limits)).toBe('Run model call budget nearly exhausted');
  });
});

describe('r78 chifeng: sourceless general assumptions', () => {
  it('labels them deterministically when the Run has no source material', () => {
    const text = '- 是否避开周末高峰？8月为草原旺季，周末房价和人流通常更高。\n| 景点 | 草原夜间一般会降温 |';
    const labelled = labelInferences(text, undefined, () => '', [], { sourceless: true });
    expect(labelled.labeled).toBeGreaterThan(0);
    expect(inferenceFidelityProblems(labelled.content, undefined, () => '', [], { sourceless: true })).toEqual([]);
  });
  it('keeps them an error when sources exist', () => {
    const text = '周末房价和人流通常更高。';
    const labelled = labelInferences(text, undefined, () => 'other text', ['source_a']);
    expect(labelled.labeled).toBe(0);
    expect(inferenceFidelityProblems(labelled.content, undefined, () => 'other text', ['source_a'])).toContain('content: unsourced general assumption is forbidden');
  });
});

describe('r78 chifeng/pdf2: share-limited overall timeout', () => {
  it('a boosted allocation borrows from later tasks but leaves each minCallMs', () => {
    const base = { phase: 'executor' as const, usedMs: 400_000, runBudgetMs: 1_800_000, reviewReserveMs: 240_000, callMaxMs: 420_000, minCallMs: 60_000, pendingTasks: 5 };
    expect(allocateModelCallTimeout(base)).toBe(232_000);
    expect(allocateModelCallTimeout({ ...base, boost: true })).toBe(420_000);
    expect(allocateModelCallTimeout({ ...base, usedMs: 1_300_000, boost: true })).toBe(60_000);
  });
  it('retries the task once with a larger timeout when the call hit its even share, not the Run deadline', async () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}`, title: `T${index}`, instruction: `Write part ${index}`, dependsOn: index ? [`t${index - 1}`] : [] }));
    const repository = new InMemoryRunRepository();
    let part1 = 0;
    const timeouts: number[] = [];
    const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
      if (isPlanner(request)) return { value: { summary: 'Guide', nodes } };
      if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
      const input = request.input as any;
      if (input.task.id === 't1') {
        timeouts.push(request.timeoutMs ?? 0);
        if (++part1 === 1) throw new ModelTimeout(`Model response timed out after ${request.timeoutMs}ms (overall timeout). Provider billing requires reconciliation.`);
      }
      return { value: { type: 'finish', title: input.task.title, content: `${input.task.title} 已完成。`, evidenceRefs: [] } };
    } } satisfies ModelAdapter });
    const run = await engine.create({ goal: 'Write a guide' } as never);
    await engine.advance(run.id);
    const plan = (await repository.get(run.id)).plans[0]!;
    await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
    for (let i = 0; i < 30; i++) {
      const current = await repository.get(run.id);
      if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
      await engine.advance(run.id).catch(() => undefined);
    }
    const final = await repository.get(run.id);
    const retry = final.events.find(item => item.type === 'model.timeout_retry');
    expect(retry?.data).toMatchObject({ shareLimited: true });
    expect(part1).toBe(2);
    expect(timeouts[1]!).toBeGreaterThan(timeouts[0]!);
    expect(final.status, final.error).toBe('succeeded');
    expect(final.partial ?? false).toBe(false);
  });
});

describe('r78 pdf2/pdf5: intermediate fillable task and output verification', () => {
  it('an inspection task may finish before any fill, and pdf.formFields on the output reads the written values', async () => {
    const repository = new InMemoryRunRepository();
    const plan = { summary: 'Fill', nodes: [
      { id: 'inspect', title: 'Inspect fields', instruction: 'Inspect the AcroForm fields', dependsOn: [] },
      { id: 'fill', title: 'Fill PDF', instruction: 'Fill sourced values and verify', dependsOn: ['inspect'] },
    ] };
    const seen: any[] = [];
    const engine = new AgentEngine(repository, { model: { pin, complete: async (request: ModelRequest) => {
      if (isPlanner(request)) return { value: plan };
      if (isReviewer(request)) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
      const input = request.input as any, formRef = input.sourceCatalog[0].id, caseRef = input.sourceCatalog[1].id;
      const observations = input.observations as any[];
      if (input.task.id === 'inspect') {
        if (!observations.length) return { value: { type: 'tool', tool: 'pdf.formFields', argument: formRef } };
        return { value: { type: 'finish', title: 'Field inventory', content: `8 fields; name, email and country are supplied [${caseRef}] [${formRef}].`, evidenceRefs: [formRef, caseRef],
          structured: { schemaVersion: 'fillable-pdf/1', form: { sourceRef: formRef, fieldCount: 8 }, filledFields: [], unknowns: [], blockers: [] } } };
      }
      const fill = observations.find(item => item.tool === 'pdf.fill' && item.result.output)?.result;
      if (!fill) return { value: { type: 'tool', tool: 'pdf.fill', argument: formRef, fields: { name: 'Maya Chen', email: 'maya@example.test', country: 'SG', phone: '' } } };
      const verify = observations.find(item => item.tool === 'pdf.formFields' && item.result.id === fill.id);
      if (!verify) return { value: { type: 'tool', tool: 'pdf.formFields', argument: fill.id } };
      seen.push(verify.result);
      const artifact = pdfArtifact({ ...fill.output, writtenFields: fill.filledFields }, formRef, caseRef);
      artifact.filledFields.find(field => field.name === 'country')!.evidenceRefs = [caseRef, formRef];
      return { value: { type: 'finish', title: 'Filled PDF', content: `Filled name, email and country [${caseRef}]; other fields left empty [${formRef}].`, evidenceRefs: [caseRef, formRef, fill.id], artifactType: 'fillable-pdf/1', structured: artifact } };
    } } satisfies ModelAdapter });
    const run = await engine.create({ goal: 'Fill the registration PDF', builtinSkill: 'fillable-pdf/1', materials: [
      { title: 'registration.pdf', source: 'upload:registration.pdf', content: formContent },
      { title: 'partial.json', source: 'upload:partial.json', content: JSON.stringify({ name: 'Maya Chen', email: 'maya@example.test', country: 'SG' }) },
    ] } as never);
    await engine.advance(run.id);
    const proposed = (await repository.get(run.id)).plans[0]!;
    await engine.command(run.id, 'approve', { planHash: proposed.hash, planVersion: proposed.version });
    for (let i = 0; i < 20; i++) {
      const current = await repository.get(run.id);
      if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
      await engine.advance(run.id).catch(() => undefined);
    }
    const final = await repository.get(run.id);
    const types = final.events.map(item => item.type);
    expect(types).toContain('artifact.structured_dropped');
    expect(types).not.toContain('model.validation_failed');
    expect(types).not.toContain('tool.failed_recoverable');
    expect(seen[0].fields.find((field: any) => field.name === 'name').value).toBe('Maya Chen');
    expect(final.status, final.error).toBe('succeeded');
    expect(final.partial ?? false).toBe(false);
    const pdf = final.artifacts.find(artifact => artifact.taskId === 'fill')!.structured as any;
    expect(pdf.filledFields.find((field: any) => field.name === 'country').evidenceRefs).toHaveLength(1);
  });
});
void profileContent;
