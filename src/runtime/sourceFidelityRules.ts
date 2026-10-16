import type { FillablePdfArtifact, ProjectPulseArtifact, WebsiteBuilderArtifact } from './contracts.js';

export const maxSourceUnknowns = 5;
export const sourceFidelityGuidance = `\nSource fidelity rules: Copy dates exactly as written in the source: if the source says "10-20", write "10-20"; never add a year, weekday or time the source does not state. Reviewers must not demand a full date or an empty date. A date range is allowed verbatim when the source itself states a range. Label inferences in narrative fields and body/prose with "推断：". Missing inference labels alone are runtime warnings only and must never cause repair, rejection or revision. Never change literal PDF values or source dates to label an inference. PDF dropdown choices without literal source values require a labelled explanation in content and a matching structured.inferences entry {field, value, text, evidenceRefs} citing received non-PDF evidence; otherwise re-run pdf.fill without the field and report the reason in unknowns. Unsourced general assumptions (e.g. "负载测试通常在核心集成之后") are forbidden, even if labelled. For artifacts with a recognized artifactType, include corresponding structured entries with evidenceRefs for prose inferences; the runtime derives missing Project Pulse entries and records reviewer warnings for other artifacts. Plain-text answers must keep inference explanations in content and omit structured. Missing correspondence alone must never require revision. unknowns list only gaps in source documents, never runtime/run limitations: truncation, row limits, tool limits and timeouts belong in finish.limitations (an array of strings). Keep at most ${maxSourceUnknowns} unknowns, except fillable-pdf/1 must report every unfilled field with its exact field name and reason. evidenceRefs must point to source evidence (source excerpts, csvQuery/sources.read observations of a source, tool receipts); do not cite intermediate artifacts or tool names. A truncated csvQuery result is still valid evidence for the rows and aggregates it returned; cite its source id. These rules take precedence over any conflicting date or inference instructions in prompt supplements.`;

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
  for (const [index, item] of structured.deadlines.entries()) {
    for (const match of `${item.date} ${item.text}`.matchAll(new RegExp(fullDatePattern, 'g'))) {
      const text = sourceText(item.evidenceRefs);
      const [full, year, month, day] = match;
      const normalized = new RegExp(`${year}\\s*[-/.年]\\s*0?${Number(month)}\\s*[-/.月]\\s*0?${Number(day)}`);
      if (text && !normalized.test(text) && partialDatePattern(Number(month), Number(day)).test(text)) {
        problems.push(`structured.deadlines[${index}].date: deadline date ${JSON.stringify(full)} adds a year the source does not state; copy the date exactly as written (e.g. "${Number(month)}-${Number(day)}")`);
      }
    }
  }
  return problems;
}

const inferenceCue = /可能|预计|建议|应当|应该|推测|推断|通常|一般(?:会|在|需要)|probably|likely|recommend|infer(?:ence|red)?|usually|typically/i;
export const generalAssumption = /通常|一般(?:会|在|需要)|usually|typically/i;
const clean = (text: string) => text.replace(/\[[^\]]*\]/g, '').replace(/^[\s#*>\-\d.]+/, '').trim();
const inferencePrefix = /^(?:推断\s*[:：]|Inference\s*:)/i;
const inferenceText = (text: string) => text.replace(inferencePrefix, '推断：').replace(/[。；.!;]+$/, '').trim();
const narrativeKeys = new Set(['text', 'responsibility', 'summary', 'description', 'rationale', 'recommendation']);

/** PDF choice inferences must be stated as labelled prose as well as structured evidence. */
export function hasProseInference(content: string, text: string): boolean {
  const statement = (value: string) => inferenceText(clean(value)).replace(inferencePrefix, '').trim();
  return content.split(/\n|(?<=[。；])\s*|(?<=[.!;])\s+(?=(?:推断\s*[:：]|Inference\s*:))/i).some(line => inferencePrefix.test(clean(line)) && statement(line) === statement(text));
}

/** Mutate structured narrative fields and a content holder. For a string input,
 * return the labelled content as well, since JavaScript strings are immutable. */
export function labelInferences(content: { content: string }, structured: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact | undefined, sourceText: (refs: string[]) => string, refs: string[]): { labeled: number; paths: string[] };
export function labelInferences(content: string, structured: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact | undefined, sourceText: (refs: string[]) => string, refs: string[]): { content: string; labeled: number; paths: string[] };
export function labelInferences(content: string | { content: string }, structured: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact | undefined, sourceText: (refs: string[]) => string, refs: string[]): { content?: string; labeled: number; paths: string[] } {
  const paths: string[] = [];
  const needsLabel = (text: string, evidence: string) => inferenceCue.test(text) && !generalAssumption.test(text) && !evidence.includes(text) && !inferencePrefix.test(text);
  const visit = (value: unknown, evidenceRefs = refs, path = 'structured'): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, evidenceRefs, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const itemRefs = Array.isArray(object.evidenceRefs) ? object.evidenceRefs as string[] : evidenceRefs;
    for (const [key, item] of Object.entries(object)) {
      // Only narrative fields: dates, identities, paths and other schema data
      // must remain literal. PDF structured values are skipped entirely below.
      if (typeof item === 'string' && narrativeKeys.has(key)) {
        const evidence = sourceText(itemRefs);
        if (evidence.includes(item) || !needsLabel(clean(item), evidence)) continue;
        object[key] = `推断：${clean(item)}`;
        if (structured?.schemaVersion === 'project-pulse/1' && Array.isArray(object.evidenceRefs)) object.derived = true;
        paths.push(`${path}.${key}`);
      } else if (key !== 'evidenceRefs' && key !== 'changedFiles') visit(item, itemRefs, `${path}.${key}`);
    }
  };
  if (structured?.schemaVersion === 'fillable-pdf/1') visit(structured.inferences, refs, 'structured.inferences');
  else visit(structured);
  const labelledContent = (typeof content === 'string' ? content : content.content).split('\n').map((line, index) => {
    let sentenceIndex = 0;
    // Preserve separators and whitespace, using the checker's sentence boundaries.
    return line.replace(/[^。；]+[。；]?/g, sentence => {
      const sentencePath = `content[${index}][${sentenceIndex++}]`;
      if (!needsLabel(clean(sentence), sourceText(refs))) return sentence;
      paths.push(sentencePath);
      return sentence.replace(/^(\s*(?:(?:#{1,6}|[-*+>]+|\d+\.)[ \t]*)*)/, '$1推断：');
    });
  }).join('\n');
  if (typeof content !== 'string') content.content = labelledContent;
  return { ...(typeof content === 'string' ? { content: labelledContent } : {}), labeled: paths.length, paths };
}

const sourceGapPattern = /(?:资料|来源|原文|材料)[^。；]{0,12}?(?:未|没有|并未)(?:说明|给出|提及|注明|明确|提供)|not (?:stated|specified|given|mentioned) in the source/i;
function isSourceGap(text: string): boolean { return sourceGapPattern.test(text) && !/风险|可能|延期|risk|may|might/i.test(text.replace(sourceGapPattern, '').replace(/资料表述为可能性/g, '')); }
/** Near-duplicate list text: one contains the other, or character-bigram overlap ≥ 0.6. */
export function similarListText(a: string, b: string): boolean {
  const key = (text: string) => text.normalize('NFKC').replace(/^\s*推断\s*[:：]/u, '').replace(/[（(][^）)]*[）)]/gu, '').replace(/[\s\p{P}\p{S}]+/gu, '').toLocaleLowerCase();
  const x = key(a), y = key(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const grams = (text: string) => new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  const gx = grams(x), gy = grams(y);
  const shared = [...gx].filter(gram => gy.has(gram)).length;
  return shared / Math.min(gx.size || 1, gy.size || 1) >= 0.6;
}
/** Missing prose counterparts are bookkeeping, never a model repair condition. */
export function deriveProseInferences(content: string, structured: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact | undefined, refs: string[]): { derived: number; warnings: string[] } {
  const entries: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'evidenceRefs') continue;
      if (typeof item === 'string') entries.push(inferenceText(clean(item)));
      else visit(item);
    }
  };
  visit(structured);
  let derived = 0;
  const warnings: string[] = [];
  for (const line of content.split(/\n|(?<=[。；])\s*|(?<=[.!;])\s+(?=(?:推断\s*[:：]|Inference\s*:))/i)) {
    const text = clean(line);
    if (!inferencePrefix.test(text) || entries.includes(inferenceText(text)) || structured?.schemaVersion === 'fillable-pdf/1' && structured.inferences?.some(inference => hasProseInference(line, inference.text))) continue;
    if (structured?.schemaVersion === 'project-pulse/1' && isSourceGap(text)) {
      // r62 txt: "资料未说明/未给出 ..." is a source gap, not a risk; reviewers reject it as a risk.
      const gap = text.replace(inferencePrefix, '').replace(/[；;]+$/u, '。').trim();
      if (!structured.unknowns.some(item => similarListText(String((item as { text?: unknown }).text ?? item), gap))) (structured.unknowns as unknown[]).push({ text: gap, evidenceRefs: [...refs].slice(0, 50) });
      entries.push(inferenceText(text)); continue;
    }
    if (structured?.schemaVersion === 'project-pulse/1' && structured.risks.some(item => similarListText(item.text, text))) {
      // r62 txt: the same inference restated in several prose clauses must not become several risks.
      entries.push(inferenceText(text)); continue;
    }
    if (structured?.schemaVersion === 'project-pulse/1' && refs.length && structured.risks.length < 30 && text.length <= 2000) {
      structured.risks.push({ text: text.replace(inferencePrefix, '推断：').replace(/[；;]+$/u, '。'), evidenceRefs: [...refs].slice(0, 50), derived: true });
      entries.push(inferenceText(text)); derived++;
    } else warnings.push(`Prose inference has no structured counterpart: ${text.slice(0, 200)}`);
  }
  return { derived, warnings };
}

/** Label problems are presentation warnings; substantive unsupported assumptions remain errors. */
export function inferenceFidelityProblems(content: string, structured: ProjectPulseArtifact | WebsiteBuilderArtifact | FillablePdfArtifact | undefined, sourceText: (refs: string[]) => string, refs: string[]): string[] {
  const problems: string[] = [];
  const check = (text: string, evidence: string, location: string) => {
    if (generalAssumption.test(text) && !evidence.includes(text.replace(inferencePrefix, '').trim())) problems.push(`${location}: unsourced general assumption is forbidden`);
    if (inferenceCue.test(text) && !evidence.includes(text) && !inferencePrefix.test(text)) problems.push(`${location}: inference must start with "推断："`);
  };
  const visit = (value: unknown, evidenceRefs = refs, path = 'structured') => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, evidenceRefs, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    const itemRefs = Array.isArray(object.evidenceRefs) ? object.evidenceRefs as string[] : evidenceRefs;
    for (const [key, item] of Object.entries(object)) {
      if (key === 'evidenceRefs' || key === 'schemaVersion') continue;
      if (typeof item === 'string') { check(item, sourceText(itemRefs), `${path}.${key}`); }
      else visit(item, itemRefs, `${path}.${key}`);
    }
  };
  visit(structured);
  for (const line of content.split(/\n|(?<=[。；])\s*/)) {
    const text = clean(line);
    if (!text || /^(?:推断|Inference)$/i.test(text)) continue;
    check(text, sourceText(refs), 'content');
  }
  return [...new Set(problems)];
}
