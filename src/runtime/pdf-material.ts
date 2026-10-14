import { createHash } from 'node:crypto';

/** Explicit transport marker; ordinary text materials retain their 30,000 character limit. */
export const PDF_BASE64_PREFIX = 'data:application/pdf;base64,';
export const MAX_PDF_BYTES = 256 * 1024;
export const MAX_PDF_CONTENT_CHARS = PDF_BASE64_PREFIX.length + 4 * Math.ceil(MAX_PDF_BYTES / 3);
export function isBinaryPdf(content: string): boolean { return content.startsWith(PDF_BASE64_PREFIX); }
export function decodePdfMaterial(content: string): Buffer {
  if (!isBinaryPdf(content)) throw new Error('PDF material must use data:application/pdf;base64, followed by canonical base64');
  if (content.length > MAX_PDF_CONTENT_CHARS) throw new Error('PDF exceeds the 256 KiB size cap');
  const encoded = content.slice(PDF_BASE64_PREFIX.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid PDF base64');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_PDF_BYTES) throw new Error('PDF exceeds the 256 KiB size cap');
  if (bytes.toString('base64') !== encoded || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Invalid PDF bytes or noncanonical base64');
  return bytes;
}
export function pdfSha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function pdfMaterialDescription(content: string): string {
  const bytes = decodePdfMaterial(content);
  return JSON.stringify({ format: 'pdf', encoding: 'base64', sizeBytes: bytes.length, sha256: pdfSha256(bytes), instructions: 'Binary AcroForm PDF. Use pdf.formFields to inspect fields; PDF bytes are withheld from model context.' });
}
