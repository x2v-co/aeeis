import { readFileSync } from 'node:fs';
import type { FillablePdfArtifact, Source } from '../src/runtime/contracts.js';
import { PDF_BASE64_PREFIX } from '../src/runtime/pdf-material.js';
import { materialContentHash } from '../src/runtime/materials.js';
import type { PdfOutput } from '../src/runtime/fillable-pdf.js';

export const formBytes = readFileSync(new URL('../fixtures/fillable-pdf/registration.pdf', import.meta.url));
export const formContent = PDF_BASE64_PREFIX + formBytes.toString('base64');
export const profileContent = readFileSync(new URL('../fixtures/fillable-pdf/profile.json', import.meta.url), 'utf8');
export const profile = JSON.parse(profileContent);
export const source = (id: string, title: string, content: string): Source => ({ id, title, content, source: `upload:${title}`, hash: materialContentHash(content), kind: 'material', untrusted: true });
export const formSource = source('source_form', 'registration.pdf', formContent);
export const profileSource = source('source_profile', 'profile.json', profileContent);
export function pdfArtifact(output: PdfOutput, formRef = formSource.id, evidenceRef = profileSource.id): FillablePdfArtifact {
  return { schemaVersion: 'fillable-pdf/1', form: { sourceRef: formRef, fieldCount: 8 },
    filledFields: output.writtenFields.map(field => ({ ...field, evidenceRefs: [evidenceRef] })),
    unknowns: ['name', 'email', 'phone', 'caseId', 'subscribe', 'contactMethod', 'country', 'interests'].filter(name => !output.writtenFields.some(field => field.name === name))
      .map(field => ({ field, text: field === 'caseId' ? 'Read-only; explicitly untouched.' : 'No source value; left empty.', evidenceRefs: [formRef, ...(evidenceRef ? [evidenceRef] : [])] })),
    output: { filename: output.filename, sha256: output.sha256, sizeBytes: output.sizeBytes, ref: output.ref }, blockers: [] };
}
