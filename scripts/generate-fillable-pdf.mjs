#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const directory = new URL('../fixtures/fillable-pdf/', import.meta.url);
await mkdir(directory, { recursive: true });
const doc = await PDFDocument.create();
doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([600, 800]), form = doc.getForm();
page.drawText('Source-backed registration form', { x: 40, y: 755, size: 20, font });
const label = (text, y) => page.drawText(text, { x: 40, y: y + 7, size: 12, font });
for (const [name, y] of [['name', 690], ['email', 640], ['phone', 590], ['caseId', 540]]) {
  label(name, y);
  const field = form.createTextField(name); field.addToPage(page, { x: 180, y, width: 340, height: 26, font });
  if (name === 'name') { field.enableRequired(); field.setMaxLength(80); }
  if (name === 'phone') field.setText('TEMPLATE PHONE');
  if (name === 'caseId') { field.setText('FORM-001'); field.enableReadOnly(); }
}
label('subscribe', 495); form.createCheckBox('subscribe').addToPage(page, { x: 180, y: 495, width: 20, height: 20 });
label('contactMethod', 450);
const radio = form.createRadioGroup('contactMethod');
for (const [option, x] of [['Email', 180], ['Phone', 310]]) {
  radio.addOptionToPage(option, page, { x, y: 450, width: 18, height: 18 });
  page.drawText(option, { x: x + 25, y: 455, size: 12, font });
}
label('country', 400);
const dropdown = form.createDropdown('country'); dropdown.addOptions(['SG', 'US']); dropdown.addToPage(page, { x: 180, y: 400, width: 180, height: 26, font });
label('interests', 300);
const list = form.createOptionList('interests'); list.addOptions(['Music', 'Travel', 'Sport']); list.enableMultiselect(); list.addToPage(page, { x: 180, y: 290, width: 180, height: 90, font });
await writeFile(new URL('registration.pdf', directory), await doc.save());
