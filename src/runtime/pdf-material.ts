import { createHash } from 'node:crypto';

/** Explicit transport marker; ordinary text materials retain their 30,000 character limit. */
export const PDF_BASE64_PREFIX = 'data:application/pdf;base64,';
/** Uploaded AcroForm templates (decoded bytes). */
export const MAX_PDF_BYTES = 512 * 1024;
/** Filled outputs may embed a subset CJK font, so they get more headroom than inputs. */
export const MAX_PDF_OUTPUT_BYTES = 1024 * 1024;
/** Sum of decoded bytes retained in Run.pdfOutputs (at most eight outputs). */
export const MAX_RUN_PDF_OUTPUT_BYTES = 4 * 1024 * 1024;
const contentChars = (bytes: number) => PDF_BASE64_PREFIX.length + 4 * Math.ceil(bytes / 3);
export const MAX_PDF_CONTENT_CHARS = contentChars(MAX_PDF_BYTES);
const kib = (bytes: number) => bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MiB` : `${bytes / 1024} KiB`;
export function isBinaryPdf(content: string): boolean { return content.startsWith(PDF_BASE64_PREFIX); }
export function decodePdfMaterial(content: string, maxBytes = MAX_PDF_BYTES): Buffer {
  if (!isBinaryPdf(content)) throw new Error('PDF material must use data:application/pdf;base64, followed by canonical base64');
  if (content.length > contentChars(maxBytes)) throw new Error(`PDF exceeds the ${kib(maxBytes)} size cap`);
  const encoded = content.slice(PDF_BASE64_PREFIX.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid PDF base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maxBytes) throw new Error(`PDF exceeds the ${kib(maxBytes)} size cap`);
  if (bytes.toString('base64') !== encoded || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Invalid PDF bytes or noncanonical base64');
  return bytes;
}
export function pdfSha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function pdfMaterialDescription(content: string): string {
  const bytes = decodePdfMaterial(content);
  return JSON.stringify({ format: 'pdf', encoding: 'base64', sizeBytes: bytes.length, sha256: pdfSha256(bytes), instructions: 'Binary AcroForm PDF. Use pdf.formFields to inspect fields; PDF bytes are withheld from model context.' });
}
