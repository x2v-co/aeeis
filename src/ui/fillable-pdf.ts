import type { FillablePdfArtifact } from '../runtime/contracts.js';

export function isFillablePdfArtifact(value: unknown): value is FillablePdfArtifact {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<FillablePdfArtifact>;
  return item.schemaVersion === 'fillable-pdf/1' && Boolean(item.form && item.output)
    && [item.filledFields, item.unknowns, item.blockers].every(items => Array.isArray(items) && items.every(row => row && typeof row === 'object' && Array.isArray(row.evidenceRefs)));
}
export function renderFillablePdf(pdf: FillablePdfArtifact, evidence: (ref: string) => HTMLElement, doc: Document = document): HTMLElement {
  const panel = doc.createElement('div'); panel.className = 'fillable-pdf';
  const append = (parent: HTMLElement, tag: string, text: string) => { const item = doc.createElement(tag); item.textContent = text; parent.append(item); return item; };
  append(panel, 'strong', 'PDF 表单');
  append(panel, 'p', `${pdf.form.fieldCount} 个字段 · ${pdf.filledFields.length} 个已填写`);
  panel.append(evidence(pdf.form.sourceRef));
  append(panel, 'p', `${pdf.output.filename} · ${pdf.output.sizeBytes} B · SHA-256 ${pdf.output.sha256}`);
  const table = doc.createElement('table');
  const header = doc.createElement('tr'); ['字段', '已填写的值', '证据'].forEach(text => append(header, 'th', text)); table.append(header);
  for (const field of pdf.filledFields) {
    const row = doc.createElement('tr');
    append(row, 'td', field.name);
    append(row, 'td', Array.isArray(field.value) ? field.value.join(', ') : String(field.value));
    const refs = doc.createElement('td'); field.evidenceRefs.forEach(ref => refs.append(evidence(ref))); row.append(refs); table.append(row);
  }
  panel.append(table);
  for (const [label, items] of [['未知信息 / 未填写', pdf.unknowns], ['阻塞', pdf.blockers]] as const) {
    append(panel, 'h4', `${label} · ${items.length}`);
    for (const item of items) {
      const row = append(panel, 'p', `${'field' in item && item.field ? `${item.field} · ` : ''}${item.text}`);
      item.evidenceRefs.forEach(ref => row.append(evidence(ref)));
    }
  }
  return panel;
}
