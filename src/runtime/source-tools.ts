/** Built-in evidence tools share authorization, allowances and privacy rules. */
export const structuredSourceTools = ['sources.sample', 'sources.markdownOutline', 'sources.markdownSection', 'sources.jsonSummary', 'sources.jsonRead', 'sources.pdfRead'] as const;
export function isStructuredSourceTool(tool: unknown): boolean {
  return typeof tool === 'string' && (structuredSourceTools as readonly string[]).includes(tool);
}
export function isPdfTool(tool: unknown): boolean { return tool === 'pdf.formFields' || tool === 'pdf.fill'; }
export function isSourceReadTool(tool: unknown): boolean {
  return tool === 'sources.read' || tool === 'sources.csvQuery' || isStructuredSourceTool(tool) || isPdfTool(tool);
}
export function isSourceTool(tool: unknown): boolean { return tool === 'sources.search' || isSourceReadTool(tool); }
