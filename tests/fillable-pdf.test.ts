import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { decisionSchema, fillablePdfArtifactSchema, materialSchema, requestSchema } from '../src/runtime/contracts.js';
import { coerceStringArtifactItems, normalizeFinishOutput } from '../src/runtime/engine.js';
import { fillPdf, inspectPdf, pdfFormFields, pdfOutputForModel, validateFillablePdfArtifact, fillablePdfEvidenceRefs } from '../src/runtime/fillable-pdf.js';
import { decodePdfMaterial, MAX_PDF_BYTES, PDF_BASE64_PREFIX, pdfSha256 } from '../src/runtime/pdf-material.js';
import { materialForModel, materialFormat, readMaterialPage, presentedMaterials, materialContentHash } from '../src/runtime/materials.js';
import { formBytes, formContent, formSource, profileSource, profile, pdfArtifact, source } from './fillable-pdf-fixture.js';

async function fixture() {
  const output = await fillPdf(formSource, profile), artifact = pdfArtifact(output);
  const observed = new Set([formSource.id, profileSource.id, output.ref]);
  const validate = (value = artifact) => validateFillablePdfArtifact(value, [formSource, profileSource], [output], observed);
  return { output, artifact, observed, validate };
}

describe('fillable PDF materials and tools', () => {
  it('accepts one explicit PDF with source text and keeps the existing text cap', () => {
    const material = { title: formSource.title, source: formSource.source, content: formContent };
    expect(requestSchema.parse({ goal: 'Fill', builtinSkill: 'fillable-pdf/1', materials: [material] }).builtinSkill).toBe('fillable-pdf/1');
    expect(() => materialSchema.parse({ ...material, content: 'x'.repeat(30001) })).toThrow('30000');
    const large = Buffer.alloc(MAX_PDF_BYTES + 1); large.write('%PDF-');
    expect(() => decodePdfMaterial(PDF_BASE64_PREFIX + large.toString('base64'))).toThrow('size cap');
  });
  it.each(['data:application/pdf;base64,%%%%', 'data:application/pdf;base64,YWJj', 'data:application/pdf;base64,', '%PDF-raw'])('rejects malformed bytes: %s', content => {
    expect(() => decodePdfMaterial(content)).toThrow();
  });
  it('detects the marker regardless of filename and never presents base64 as evidence text', () => {
    const renamed = { ...formSource, title: 'upload', source: 'browser' };
    expect(materialFormat(renamed)).toBe('pdf');
    for (const value of [materialForModel(renamed), readMaterialPage(renamed), ...presentedMaterials([renamed])]) {
      expect(value.content).toContain('pdf.formFields');
      expect(value.content).toContain(pdfSha256(formBytes));
      expect(JSON.stringify(value)).not.toContain(formContent.slice(0, 100));
      expect(value.contentHash).toBe(materialContentHash(value.content.split('\n').slice(1, -1).join('\n')));
    }
    expect(readMaterialPage(renamed, { characterOffset: 40 }).content).toBe(readMaterialPage(renamed).content);
  });
  it('lists every supported field type, values, flags, options and pages with bounded continuation', async () => {
    const result = await pdfFormFields(formSource);
    expect(result.fieldCount).toBe(8);
    expect(result.fields.map(field => field.type)).toEqual(['text', 'text', 'text', 'text', 'checkbox', 'radio', 'dropdown', 'optionList']);
    expect(result.fields.find(field => field.name === 'name')).toMatchObject({ required: true, readOnly: false, value: '', page: 1 });
    expect(result.fields.find(field => field.name === 'caseId')).toMatchObject({ readOnly: true, value: 'FORM-001' });
    expect(result.fields.find(field => field.name === 'country')).toMatchObject({ options: ['SG', 'US'], multiselect: false });
    expect(result.fields.find(field => field.name === 'interests')).toMatchObject({ options: ['Music', 'Travel', 'Sport'], multiselect: true });
    expect(await pdfFormFields(formSource, 0, 2)).toMatchObject({ fields: [{ name: 'name' }, { name: 'email' }], page: { nextRead: { argument: formSource.id, offset: 2, limit: 2 } } });
    expect((await pdfFormFields(formSource, 6, 2)).page.nextRead).toBeNull();
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
  });
  it('fills all types, clears missing template values, preserves readOnly and leaves fields editable', async () => {
    const { output, validate } = await fixture(); await validate();
    const doc = await PDFDocument.load(decodePdfMaterial(output.content));
    const form = doc.getForm();
    expect(form.getFields()).toHaveLength(8);
    expect(form.getTextField('name').getText()).toBe('Maya Chen');
    expect(form.getTextField('phone').getText() ?? '').toBe('');
    expect(form.getTextField('caseId').getText()).toBe('FORM-001');
    expect(form.getCheckBox('subscribe').isChecked()).toBe(true);
    expect(form.getRadioGroup('contactMethod').getSelected()).toBe('Email');
    expect(form.getDropdown('country').getSelected()).toEqual(['SG']);
    expect(form.getOptionList('interests').getSelected()).toEqual(['Music', 'Travel']);
    expect(output.sizeBytes).toBe(decodePdfMaterial(output.content).length);
    expect(output.sha256).toBe(pdfSha256(decodePdfMaterial(output.content)));
    expect(JSON.stringify(pdfOutputForModel(output))).not.toContain('base64');
  });
  it('supports explicitly sourced false and empty maps; required unknowns stay empty', async () => {
    const output = await fillPdf(formSource, { subscribe: false });
    const observed = new Set([formSource.id, profileSource.id, output.ref]);
    const evidence = { ...profileSource, content: '{"subscribe":false}', hash: materialContentHash('{"subscribe":false}') };
    await expect(validateFillablePdfArtifact(pdfArtifact(output), [formSource, evidence], [output], observed)).resolves.toBeUndefined();
    expect((await inspectPdf({ ...formSource, content: output.content })).find(field => field.name === 'subscribe')?.value).toBe(false);
    const blank = await fillPdf(formSource, {});
    await validateFillablePdfArtifact(pdfArtifact(blank, formSource.id, ''), [formSource], [blank], new Set([formSource.id, blank.ref]));
    expect(pdfArtifact(blank).unknowns).toHaveLength(8);
  });
  it('starts each fill from the source template and gives each write manifest a distinct ref', async () => {
    const first = await fillPdf(formSource, { name: 'Maya' });
    const second = await fillPdf(formSource, { email: 'maya@example.test' });
    expect((await inspectPdf({ ...formSource, content: second.content })).find(field => field.name === 'name')?.value).toBe('');
    expect(first.ref).not.toBe(second.ref);
    expect((await fillPdf(formSource, {})).ref).not.toBe((await fillPdf(formSource, { subscribe: false })).ref);
    expect((await fillPdf(formSource, {}, 'another.pdf')).ref).not.toBe((await fillPdf(formSource, {})).ref);
  });
  it.each([
    [{ invented: 'value' }, 'Unknown form field'], [{ caseId: 'NEW' }, 'readOnly'],
    [{ subscribe: 'true' }, 'boolean'], [{ name: true }, 'string'], [{ name: '' }, 'non-empty'],
    [{ country: 'CA' }, 'Invalid option'], [{ country: 'XX' }, 'Placeholder'], [{ country: ['SG', 'US'] }, 'multiselect'],
    [{ contactMethod: ['Email'] }, 'one option'], [{ interests: 'Music' }, 'multiselect'],
    [{ interests: ['Music', 'Music'] }, 'Invalid option'], [{ name: 'TBD' }, 'Placeholder'],
    [{ name: '[evidence]' }, 'Placeholder'], [{ name: '{{name}}' }, 'Placeholder'],
    [{ name: 'x'.repeat(81) }, 'maxLength'],
  ])('rejects invalid writes %j', async (fields, error) => {
    await expect(fillPdf(formSource, fields as any)).rejects.toThrow(error as string);
  });
  it.each(['TBD', 'XX', 'NEW', 'N/A', 'TODO', '?', 'NA', 'N.A.', 'unknown', 'null', 'not provided', '  todo  '])('PDF5: rejects placeholder %s and permits omission with a sourced reason', async value => {
    await expect(fillPdf(formSource, { name: value })).rejects.toThrow('Placeholder');
    const output = await fillPdf(formSource, {});
    await validateFillablePdfArtifact(pdfArtifact(output), [formSource, profileSource], [output], new Set([formSource.id, profileSource.id, output.ref]));
    expect((await inspectPdf({ ...formSource, content: output.content })).find(field => field.name === 'name')?.value).toBe('');
  });
  it('rejects non-form, unsupported and XFA PDFs without changing their bytes', async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    const content = async () => PDF_BASE64_PREFIX + Buffer.from(await doc.save({ updateFieldAppearances: false })).toString('base64');
    await expect(inspectPdf({ ...formSource, content: await content() })).rejects.toThrow('AcroForm fields');
    doc.getForm().createButton('button');
    await expect(inspectPdf({ ...formSource, content: await content() })).rejects.toThrow('Unsupported');
    doc.getForm().acroForm.dict.set(PDFName.of('XFA'), PDFString.of('xfa'));
    await expect(inspectPdf({ ...formSource, content: await content() })).rejects.toThrow('XFA');
  });
  it('keeps PDF decisions strict and schemas require field evidence', () => {
    expect(decisionSchema.parse({ type: 'tool', tool: 'pdf.fill', argument: formSource.id, fields: {} })).toMatchObject({ filename: 'filled-form.pdf' });
    expect(() => decisionSchema.parse({ type: 'tool', tool: 'pdf.fill', argument: formSource.id, fields: {}, flatten: true })).toThrow();
    expect(() => decisionSchema.parse({ type: 'tool', tool: 'pdf.fill', argument: formSource.id, fields: {}, filename: '../file.pdf' })).toThrow();
  });
});

describe('fillable PDF finish validation', () => {
  it('PDF3: maps writes to the referenced output, retaining explicitly sourced false and excluding other versions', async () => {
    const evidence = { ...profileSource, content: '{"name":"Maya Chen","subscribe":false}' };
    const first = await fillPdf(formSource, { name: 'Maya Chen', subscribe: false });
    const second = await fillPdf(formSource, { name: 'Maya Chen' });
    const artifact = pdfArtifact(first);
    const observed = new Set([formSource.id, evidence.id, first.ref, second.ref]);
    await expect(validateFillablePdfArtifact(artifact, [formSource, evidence], [second, first], observed)).resolves.toBeUndefined();
    artifact.filledFields = artifact.filledFields.filter(field => field.name !== 'subscribe');
    await expect(validateFillablePdfArtifact(artifact, [formSource, evidence], [second, first], observed)).rejects.toThrow('subscribe');
  });
  it('PDF5: requires unknowns to cite the PDF and every consulted case source', async () => {
    const { artifact, validate } = await fixture();
    artifact.unknowns[0]!.evidenceRefs = [formSource.id];
    await expect(validate()).rejects.toThrow(`Missing: ["${profileSource.id}"]`);
    artifact.unknowns[0]!.evidenceRefs = [formSource.id, profileSource.id];
    await expect(validate()).resolves.toBeUndefined();
  });
  it('extracts form/output/field/unknown evidence refs and accepts complete output', async () => {
    const { artifact, validate, output } = await fixture();
    expect(fillablePdfArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(fillablePdfEvidenceRefs(artifact)).toEqual([formSource.id, output.ref, profileSource.id]);
    await validate();
    artifact.filledFields[0]!.evidenceRefs = [];
    expect(() => fillablePdfArtifactSchema.parse(artifact)).toThrow();
    await expect(validate()).rejects.toThrow('received source evidence');
  });
  it.each(['#row2', ':contactMethod', '/rows/2', '[2]', '@row2'])('accepts received CSV field evidence scoped with %s', async scope => {
    const csv = source('source_csv', 'case.csv', 'contactMethod\nEmail'), output = await fillPdf(formSource, { contactMethod: 'Email' });
    const artifact = pdfArtifact(output, formSource.id, csv.id);
    artifact.filledFields[0]!.evidenceRefs = [`source: ${csv.id.toUpperCase()}${scope}`];
    await expect(validateFillablePdfArtifact(artifact, [formSource, csv], [output], new Set([formSource.id, csv.id, output.ref]))).resolves.toBeUndefined();
    await expect(validateFillablePdfArtifact(artifact, [formSource, csv], [output], new Set([formSource.id, output.ref]))).rejects.toThrow('received source evidence');
  });
  it.each(['valid', 'no-label', 'no-entry', 'wrong-value', 'unreceived', 'run-evidence'] as const)('validates inferred SG dropdown evidence (%s)', async mode => {
    const caseSource = source('source_case', 'case.json', '{"country":"Singapore"}'), output = await fillPdf(formSource, { country: 'SG' });
    const artifact = pdfArtifact(output, formSource.id, caseSource.id), text = 'country="SG" follows from Singapore';
    artifact.inferences = [{ field: 'country', value: mode === 'wrong-value' ? 'US' : 'SG', text, evidenceRefs: [mode === 'unreceived' ? 'unreceived' : caseSource.id] }];
    if (mode === 'no-entry') delete artifact.inferences;
    if (mode === 'run-evidence') caseSource.kind = 'run-evidence';
    const validation = validateFillablePdfArtifact(artifact, [formSource, caseSource], [output], new Set([formSource.id, caseSource.id, output.ref]), `${mode === 'no-label' ? '' : '推断：'}${text}`);
    if (mode === 'valid') await expect(validation).resolves.toBeUndefined();
    else await expect(validation).rejects.toThrow(/unknowns/);
  });
  it.each(['source_form', 'artifact_intermediate', 'receipt_tool', 'source_unreceived'])('rejects filled value evidence %s', async ref => {
    const { artifact, validate } = await fixture();
    artifact.filledFields[0]!.evidenceRefs = [ref];
    await expect(validate()).rejects.toThrow('received source evidence');
  });
  it.each(['value', 'name', 'unknown', 'missingUnknown', 'missingWrite', 'duplicate', 'placeholder', 'hash', 'size', 'filename', 'count', 'source', 'output'] as const)('rejects inaccurate %s', async problem => {
    const { artifact, validate } = await fixture();
    if (problem === 'value') artifact.filledFields[0]!.value = 'Invented person';
    if (problem === 'name') artifact.filledFields[0]!.name = 'invented';
    if (problem === 'unknown') artifact.unknowns[0]!.field = 'invented';
    if (problem === 'missingUnknown') artifact.unknowns = [];
    if (problem === 'missingWrite') artifact.filledFields.pop();
    if (problem === 'duplicate') artifact.filledFields.push(artifact.filledFields[0]!);
    if (problem === 'placeholder') artifact.filledFields[0]!.value = 'TBD';
    if (problem === 'hash') artifact.output.sha256 = '0'.repeat(64);
    if (problem === 'size') artifact.output.sizeBytes++;
    if (problem === 'filename') artifact.output.filename = 'other.pdf';
    if (problem === 'count') artifact.form.fieldCount++;
    if (problem === 'source') artifact.form.sourceRef = profileSource.id;
    if (problem === 'output') artifact.output.ref = 'invented';
    await expect(validate()).rejects.toThrow();
  });
  it('reopens stored bytes and catches a changed field even with matching metadata', async () => {
    const { output, artifact, observed } = await fixture();
    const doc = await PDFDocument.load(decodePdfMaterial(output.content));
    doc.getForm().getTextField('name').setText('Forged');
    const bytes = await doc.save();
    output.content = PDF_BASE64_PREFIX + Buffer.from(bytes).toString('base64');
    artifact.output.sha256 = output.sha256 = pdfSha256(bytes);
    artifact.output.sizeBytes = output.sizeBytes = bytes.length;
    await expect(validateFillablePdfArtifact(artifact, [formSource, profileSource], [output], observed)).rejects.toThrow('does not match output PDF');
  });
  it('rejects an unreceived source even if it exists in the source catalog', async () => {
    const { output, artifact } = await fixture();
    await expect(validateFillablePdfArtifact(artifact, [formSource, profileSource], [output], new Set([formSource.id, output.ref]))).rejects.toThrow('received source evidence');
  });
  it.each(['', '#row2', ':contactMethod'])('rejects inherited Run evidence even with scope %s', async scope => {
    const { output, artifact, observed } = await fixture();
    const inherited = { ...profileSource, kind: 'run-evidence' as const };
    artifact.filledFields[0]!.evidenceRefs = [`${inherited.id}${scope}`];
    await expect(validateFillablePdfArtifact(artifact, [formSource, inherited], [output], observed)).rejects.toThrow('received source evidence');
  });
  it.each(['top-level', 'wrapper', 'string', 'data', 'structuredData'] as const)('normalizes %s finish encodings', async shape => {
    const { artifact } = await fixture();
    const finish = { type: 'finish', title: 'PDF', content: 'Filled', structured: artifact, evidenceRefs: [profileSource.id] };
    const value = shape === 'top-level' ? artifact : shape === 'wrapper' ? { type: 'finish', artifact: finish } : shape === 'string' ? JSON.stringify(finish) : { ...finish, structured: undefined, [shape]: JSON.stringify(artifact) };
    expect(normalizeFinishOutput(value)).toMatchObject({ type: 'finish', artifactType: 'fillable-pdf/1', structured: artifact });
    expect(coerceStringArtifactItems({ ...artifact, unknowns: ['No source'] }, [formSource.id])).toEqual([{ key: 'unknowns', items: [{ text: 'No source', evidenceRefs: [formSource.id] }], count: 1 }]);
  });
});
