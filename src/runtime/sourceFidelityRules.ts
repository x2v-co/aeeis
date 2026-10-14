import type { FillablePdfArtifact, ProjectPulseArtifact, WebsiteBuilderArtifact } from './contracts.js';

export const maxSourceUnknowns = 5;
export const sourceFidelityGuidance = `\nSource fidelity rules: Copy dates exactly as written in the source: if the source says "10-20", write "10-20"; never add a year, weekday or time the source does not state. Reviewers must not demand a full date or an empty date. A date range is allowed verbatim when the source itself states a range. Any inference in any field (including nextActions, blockers, unknowns and summary) or body/prose must start with "推断：". Unsourced general assumptions (e.g. "负载测试通常在核心集成之后") are forbidden, even if labelled. Every inference in body/prose must have a corresponding structured entry with evidenceRefs; for Project Pulse use the appropriate section. unknowns list only gaps in source documents, never runtime/run limitations: truncation, row limits, tool limits and timeouts belong in finish.limitations (an array of strings). Keep at most ${maxSourceUnknowns} unknowns, except fillable-pdf/1 must report every unfilled field with its exact field name and reason. evidenceRefs must point to source evidence (source excerpts, csvQuery/sources.read observations of a source, tool receipts); do not cite intermediate artifacts or tool names. A truncated csvQuery result is still valid evidence for the rows and aggregates it returned; cite its source id. These rules take precedence over any conflicting date or inference instructions in prompt supplements.`;

/** Normalize before schema validation, including models returning string items. */
export function normalizeSourceUnknowns(structured: Record<string, unknown>): { limitations: string[]; moved: number; capped: number } {
  const limitations: string[] = [];
  let moved = 0;
  const fieldUnknowns = structured.schemaVersion === 'fillable-pdf/1';
  const unknowns = Array.isArray(structured.unknowns) ? structured.unknowns.filter(item => {
    // Every unfilled PDF field needs its own reason, including source gaps caused by limits.
    if (fieldUnknowns && item && typeof item === 'object' && typeof (item as { field?: unknown }).field === 'string') return true;
    const text = typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as { text?: unknown }).text ?? '') : '';
    if (!isRuntimeLimitation(text)) return true;
    limitations.push(text); moved++;
    return false;
  }) : undefined;
  const capped = fieldUnknowns ? 0 : Math.max(0, (unknowns?.length ?? 0) - maxSourceUnknowns);
  if (unknowns) structured.unknowns = fieldUnknowns ? unknowns : unknowns.slice(0, maxSourceUnknowns);
  return { limitations, moved, capped };
}

function isRuntimeLimitation(text: string): boolean {
  // Missing source information about timeout policy is a document gap.
  if (/(?:策略|阈值|配置|policy|configuration).{0,20}(?:未说明|未明确|不详|not documented|unspecified)/i.test(text)) return false;
  return /截断|行数.{0,8}(?:限制|上限)|(?:工具|调用|执行|运行|读取|查询).{0,12}(?:限制|上限|超时|预算)|超时|truncat|row.?limit|tool.?limit|timeout|timed out|execution allowance|limited evidence|execution.{0,15}(?:limit|budget)/i.test(text);
}

const fullDatePattern = /\b(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/;
const partialDatePattern = (month: number, day: number) => new RegExp(`(?<![\\d/.-])0?${month}\\s*[-/.月]\\s*0?${day}(?![\\d])`);

/** Reject invented years while allowing source dates and ranges at their original precision. */
export function pulseFidelityProblems(structured: ProjectPulseArtifact, sourceText: (refs: string[]) => string): string[] {
  const problems: string[] = [];
  for (const item of structured.deadlines) {
    for (const match of `${item.date} ${item.text}`.matchAll(new RegExp(fullDatePattern, 'g'))) {
      const text = sourceText(item.evidenceRefs);
      const [full, year, month, day] = match;
      const normalized = new RegExp(`${year}\\s*[-/.年]\\s*0?${Number(month)}\\s*[-/.月]\\s*0?${Number(day)}`);
      if (text && !normalized.test(text) && partialDatePattern(Number(month), Number(day)).test(text)) {
        problems.push(`deadline date ${JSON.stringify(full)} adds a year the source does not state; copy the date exactly as written (e.g. "${Number(month)}-${Number(day)}")`);
      }
    }
  }
  return problems;
}

const inferenceCue = /可能|预计|建议|应当|应该|推测|推断|通常|一般(?:会|在|需要)|probably|likely|recommend|infer(?:ence|red)?|usually|typically/i;
const generalAssumption = /通常|一般(?:会|在|需要)|usually|typically/i;
const clean = (text: string) => text.replace(/\[[^\]]*\]/g, '').replace(/^[\s#*>\-\d.]+/, '').trim();

/** Conservative lexical checks supplement the semantic checks required of both models. */
export function inferenceFidelityProblems(content: string, structured: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact | undefined, sourceText: (refs: string[]) => string, refs: string[]): string[] {
  const problems: string[] = [];
  const entries: string[] = [];
  const check = (text: string, evidence: string, location: string) => {
    if (generalAssumption.test(text) && !evidence.includes(text.replace(/^推断：\s*/, ''))) problems.push(`${location}: unsourced general assumption is forbidden`);
    if (inferenceCue.test(text) && !evidence.includes(text) && !text.startsWith('推断：')) problems.push(`${location}: inference must start with "推断："`);
  };
  const visit = (value: unknown, evidenceRefs = refs, path = 'structured') => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, evidenceRefs, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const itemRefs = Array.isArray(object.evidenceRefs) ? object.evidenceRefs as string[] : evidenceRefs;
    for (const [key, item] of Object.entries(object)) {
      if (key === 'evidenceRefs' || key === 'schemaVersion') continue;
      if (typeof item === 'string') { entries.push(clean(item)); check(item, sourceText(itemRefs), `${path}.${key}`); }
      else visit(item, itemRefs, `${path}.${key}`);
    }
  };
  visit(structured);
  for (const line of content.split(/\n|(?<=[。；])\s*/)) {
    const text = clean(line);
    if (!text || /^(?:推断|Inference)$/i.test(text)) continue;
    check(text, sourceText(refs), 'content');
    if ((text.startsWith('推断：') || (inferenceCue.test(text) && !sourceText(refs).includes(text)))
      && !entries.some(entry => entry.startsWith('推断：') && text.replace(/[。；.!;]+$/, '') === entry.replace(/[。；.!;]+$/, ''))) {
      problems.push('content: prose inference requires a corresponding structured entry');
    }
  }
  return [...new Set(problems)];
}
