#!/usr/bin/env node
// Latin-labelled AcroForm used for the Chinese-source (CJK font) retest case.
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const doc = await PDFDocument.create();
doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([600, 500]), form = doc.getForm();
page.drawText('Contact form (Chinese source)', { x: 40, y: 455, size: 20, font });
for (const [name, y] of [['fullName', 390], ['address', 340], ['city', 290], ['email', 240], ['note', 190]]) {
  page.drawText(name, { x: 40, y: y + 7, size: 12, font });
  const field = form.createTextField(name); field.addToPage(page, { x: 180, y, width: 380, height: 26, font });
  if (name === 'fullName') field.enableRequired();
}
await writeFile(new URL('../fixtures/fillable-pdf/contact-zh.pdf', import.meta.url), await doc.save());
