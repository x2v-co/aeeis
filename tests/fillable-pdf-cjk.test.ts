import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { fillPdf, needsCjkFont, validateFillablePdfArtifact, PdfInputError } from '../src/runtime/fillable-pdf.js';
import { decodePdfMaterial, MAX_PDF_OUTPUT_BYTES, PDF_BASE64_PREFIX } from '../src/runtime/pdf-material.js';
import type { FillablePdfArtifact } from '../src/runtime/contracts.js';
import { formSource, profile, source } from './fillable-pdf-fixture.js';

const zhForm = source('source_form_zh', 'contact-zh.pdf', PDF_BASE64_PREFIX + readFileSync(new URL('../fixtures/fillable-pdf/contact-zh.pdf', import.meta.url)).toString('base64'));
const zhProfileText = readFileSync(new URL('../fixtures/fillable-pdf/profile-zh.json', import.meta.url), 'utf8');
const zhProfile = source('source_profile_zh', 'profile-zh.json', zhProfileText);
const values = JSON.parse(zhProfileText) as Record<string, string>;
const fields = { fullName: values['姓名']!, address: values['地址']!, city: values['城市']!, email: values['邮箱']! };

function fontNames(bytes: Uint8Array, doc: PDFDocument): string[] {
  return doc.context.enumerateIndirectObjects().flatMap(([, object]) => {
    const dict = object as { get?: (key: PDFName) => unknown };
    const base = typeof dict.get === 'function' && String(dict.get(PDFName.of('Type'))) === '/Font' ? dict.get(PDFName.of('BaseFont')) : undefined;
    return base ? [String(base)] : [];
  });
}

describe('fillable PDF CJK values', () => {
  it('fills Chinese name/address with an embedded Noto subset and verifies every field on reread', async () => {
    const output = await fillPdf(zhForm, fields);
    const bytes = decodePdfMaterial(output.content, MAX_PDF_OUTPUT_BYTES), doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    expect(form.getTextField('fullName').getText()).toBe('陈美雅');
    expect(form.getTextField('address').getText()).toBe(fields.address);
    expect(form.getTextField('note').getText() ?? '').toBe('');
    expect(output.writtenFields).toEqual(Object.entries(fields).map(([name, value]) => ({ name, value })));
    expect(fontNames(bytes, doc).some(name => /NotoSansCJKsc/.test(name))).toBe(true);
    // Subset only: a few dozen glyphs, nowhere near the 2 MB source font.
    expect(output.sizeBytes).toBeLessThan(64 * 1024);
    const artifact: FillablePdfArtifact = { schemaVersion: 'fillable-pdf/1', form: { sourceRef: zhForm.id, fieldCount: 5 },
      filledFields: Object.entries(fields).map(([name, value]) => ({ name, value, evidenceRefs: [zhProfile.id] })),
      unknowns: [{ field: 'note', text: '来源资料没有备注。', evidenceRefs: [zhForm.id, zhProfile.id] }],
      output: { filename: output.filename, sha256: output.sha256, sizeBytes: output.sizeBytes, ref: output.ref }, blockers: [] };
    const observed = new Set([zhForm.id, zhProfile.id, output.ref]);
    await expect(validateFillablePdfArtifact(artifact, [zhForm, zhProfile], [output], observed)).resolves.toBeUndefined();
    // A single changed character must not match the persisted PDF.
    const changed = structuredClone(artifact); changed.filledFields[0]!.value = '陈美娅';
    await expect(validateFillablePdfArtifact(changed, [zhForm, zhProfile], [output], observed)).rejects.toThrow('does not match');
  });
  it('keeps Latin-only fills on the standard font path', async () => {
    expect(needsCjkFont(profile)).toBe(false);
    expect(needsCjkFont({ name: 'Zoë Müller' })).toBe(false);
    expect(needsCjkFont({ name: '陈美雅' })).toBe(true);
    expect(needsCjkFont({ interests: ['Music', '旅行'] })).toBe(true);
    const output = await fillPdf(formSource, profile), bytes = decodePdfMaterial(output.content, MAX_PDF_OUTPUT_BYTES);
    expect(fontNames(bytes, await PDFDocument.load(bytes)).some(name => /Noto/.test(name))).toBe(false);
  });
  it('rejects characters outside the bundled subset with a recoverable error', async () => {
    await expect(fillPdf(zhForm, { fullName: '陈𠀋' })).rejects.toBeInstanceOf(PdfInputError);
    await expect(fillPdf(zhForm, { fullName: '陈𠀋' })).rejects.toThrow('cannot render');
  });
});
