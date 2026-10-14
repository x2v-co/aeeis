import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, decodePDFRawStream, type PDFRawStream } from 'pdf-lib';
import { fillPdf, resolveSourceResource, synthesizePdfArtifact } from '../src/runtime/fillable-pdf.js';
import { PDF_BASE64_PREFIX, decodePdfMaterial } from '../src/runtime/pdf-material.js';
import { formSource, profileSource, profile, source } from './fillable-pdf-fixture.js';

async function addressTemplate(multiline = false) {
  const doc = await PDFDocument.create(), page = doc.addPage([400, 150]);
  const field = doc.getForm().createTextField('address');
  if (multiline) field.enableMultiline();
  field.addToPage(page, { x: 20, y: 50, width: multiline ? 130 : 220, height: multiline ? 60 : 20 });
  field.setFontSize(12);
  return source('source_address', 'address.pdf', PDF_BASE64_PREFIX + Buffer.from(await doc.save()).toString('base64'));
}
function appearance(doc: PDFDocument) {
  const widget = doc.getForm().getTextField('address').acroField.getWidgets()[0]!;
  const normal = widget.getAppearances()!.normal;
  return Buffer.from(decodePDFRawStream(doc.context.lookup(normal) as PDFRawStream).decode()).toString('latin1');
}

describe('PDF retest rendering and resource boundaries', () => {
  it.each([false, true])('address-fit: shrinks single-line text and wraps multiline fields (multiline=%s)', async multiline => {
    const template = await addressTemplate(multiline);
    const address = '99 Example Street, Unit 08-01, Sample District, Singapore';
    const output = await fillPdf(template, { address });
    const doc = await PDFDocument.load(decodePdfMaterial(output.content));
    expect(doc.getForm().getTextField('address').getText()).toBe(address);
    const ap = appearance(doc), size = Number(/ ([\d.]+) Tf/.exec(ap)![1]);
    expect(size).toBeGreaterThanOrEqual(6); expect(size).toBeLessThanOrEqual(12);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    if (multiline) expect(ap.match(/ Tj/g)!.length).toBeGreaterThan(1);
    else {
      expect(size).toBeLessThan(12);
      expect(font.widthOfTextAtSize(address, size)).toBeLessThanOrEqual(216);
      const baseline = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(ap)![1]);
      const descent = font.heightAtSize(size) - font.heightAtSize(size, { descender: false });
      expect(baseline - descent).toBeGreaterThanOrEqual(2);
      expect(baseline + font.heightAtSize(size, { descender: false })).toBeLessThanOrEqual(18);
    }
  });
  it('address-fit: fits a CJK address without changing field text', async () => {
    const template = await addressTemplate(), address = '新加坡示例街道一百号八楼零一室测试区域';
    const output = await fillPdf(template, { address });
    const doc = await PDFDocument.load(decodePdfMaterial(output.content));
    expect(doc.getForm().getTextField('address').getText()).toBe(address);
    const size = Number(/ ([\d.]+) Tf/.exec(appearance(doc))![1]);
    expect(size).toBeGreaterThanOrEqual(6); expect(size).toBeLessThan(12);
  });
  it('run_9da5581d: resolves known PDF names and output IDs but rejects ambiguous and foreign IDs', async () => {
    const output = await fillPdf(formSource, profile);
    for (const ref of ['registration.pdf', 'upload:registration.pdf', 'REGISTRATION.PDF', output.ref, output.filename, 'source: SOURCE_FORM']) {
      expect(resolveSourceResource(ref, [formSource, profileSource], [output])?.id).toBe(formSource.id);
    }
    expect(resolveSourceResource('registration.pdf', [formSource, { ...formSource, id: 'source_other' }])).toBeUndefined();
    expect(resolveSourceResource('artifact_uploaded', [{ ...formSource, source: 'artifact:artifact_uploaded' }])?.id).toBe(formSource.id);
    expect(resolveSourceResource('artifact_foreign', [formSource, profileSource], [output])).toBeUndefined();
    expect(resolveSourceResource('pdf_foreign', [formSource, profileSource], [output])).toBeUndefined();
  });
  it('run_b1917541: auto-finish synthesis requires received source values and verified bytes', async () => {
    const output = await fillPdf(formSource, profile);
    const refs = new Set([formSource.id, profileSource.id, output.ref]);
    expect(await synthesizePdfArtifact(output, [formSource, profileSource], refs)).toBeDefined();
    expect(await synthesizePdfArtifact(output, [formSource, profileSource], new Set([formSource.id, output.ref]))).toBeUndefined();
    expect(await synthesizePdfArtifact({ ...output, writtenFields: [{ name: 'name', value: 'Invented value' }] }, [formSource, profileSource], refs)).toBeUndefined();
    const blank = await fillPdf(formSource, {});
    expect((await synthesizePdfArtifact(blank, [formSource, profileSource], new Set([...refs, blank.ref])))?.unknowns).toHaveLength(8);
  });
  it('address-fit: reports minimum-size overflow instead of silently claiming text fits', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await fillPdf(await addressTemplate(), { address: 'long address '.repeat(80) });
      expect(info.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({ protocol: 'aeeis-pdf-text-fit/1', fontSize: 6, result: 'minimum-size-overflow' }));
      expect(warn).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); }
  });
});
