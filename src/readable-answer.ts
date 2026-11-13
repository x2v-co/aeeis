/** What a person reads of a Run's answer, in the chat and at the top of a finished task: the answer itself.
 * The Run keeps the full text with its evidence IDs, runtime caveats and summary blocks; those stay one click away.
 * Pure string code, shared by the server and the page. */

/** The runtime's own list of what a partial Run left unverified, appended once the Run is delivered: the heading, then
 * only one-line "- " items to the end of the text (each gap is folded to one line). A model's own "Unknown:" section with
 * anything after it, such as a conclusion, does not match, so it is never cut. */
export const RUNTIME_UNKNOWN_SUFFIX = /\n\nUnknown:\n- Remaining work:[^\n]*(?:\n- [^\n]*)*\s*$/;
/** The runtime's own opening line when the model finished on limited evidence; the answer follows the blank line. */
const LIMITED_EVIDENCE_PREFIX = /^Partial answer — limited evidence: [^\n]*\n\n/;
/** Where a machine summary the text opens with ends, such as a structured summary the model also pasted into its
 * prose. Only a block that names its schema counts: JSON an owner asked for is the answer itself. Earlier processing can
 * leave such a block invalid (empty lists lose their brackets), so it is matched by its braces, not parsed. */
function leadingSummaryEnd(text: string): number | undefined {
  if (!/^\{\s*"schemaVersion"\s*:/.test(text)) return;
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return index + 1;
  }
  return;
}
const EVIDENCE_GROUP = /[ \t]*[\[【](?:\s*(?:receipt|executor|source|artifact|model|ctx|context|wm_slice|evidence)_[A-Za-z0-9_-]+\s*[,，;；、]?)+\s*[\]】]/g;
const TOKENED_LINK = /https?:\/\/[^\s<>()\[\]"'，。]*[?&](?:_token|token|access_token|sig|signature)=[^\s<>()\[\]"'，。]*/gi;

/** Drops the runtime's partial-answer caveats around the model's answer. When nothing but the caveat is left
 * (the model never wrote an answer), the text is kept as it is, so the gap is not hidden. */
function withoutCaveats(text: string): { text: string; caveat: boolean } {
  let out = text.replace(RUNTIME_UNKNOWN_SUFFIX, '');
  const prefix = LIMITED_EVIDENCE_PREFIX.exec(out);
  if (prefix && !/^Final synthesis was unavailable/.test(out.slice(prefix[0].length))) out = out.slice(prefix[0].length);
  out = out.trim();
  return out && out !== text.trim() ? { text: out, caveat: true } : { text, caveat: false };
}

type Loose = Record<string, unknown>;
const loose = (value: unknown): value is Loose => typeof value === 'object' && value !== null && !Array.isArray(value);
const words = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : undefined;
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
/** A site build the model reported only as its summary block, with no prose after it: the same facts in a few lines a
 * person reads. Models fill the block loosely (a file as a path or an object, extra description or notes), so every field
 * is optional here and anything unreadable is left out. Undefined when nothing readable is left. */
function websiteBuilderProse(block: Loose): string | undefined {
  const lines: string[] = [];
  const described = new Map<string, string | undefined>();
  for (const item of items(block.artifacts)) if (loose(item) && words(item.path)) described.set(words(item.path)!, words(item.description) ?? words(item.kind));
  for (const item of items(block.changedFiles)) {
    const path = words(item) ?? (loose(item) ? words(item.path) : undefined);
    if (path && !described.has(path)) described.set(path, undefined);
  }
  if (described.size) lines.push('做好的文件：', ...[...described].map(([path, what]) => `- ${path}${what ? `：${what}` : ''}`));
  const preview = loose(block.preview) ? block.preview : undefined;
  const status = preview && words(preview.status);
  const url = preview && words(preview.url);
  if (status === 'failed') lines.push('', '预览没能启动。');
  // A link carrying an access token stays in the details, like everywhere else in a readable answer.
  else if (url && (status === 'started' || status === 'ready' || !status)) lines.push('', url.search(TOKENED_LINK) >= 0 ? '预览已启动，链接在详情里。' : `预览：${url}`);
  const checks = items(block.validation).filter(loose);
  const passed = checks.filter(item => item.status === 'passed').length;
  const failed = checks.filter(item => item.status === 'failed').map(item => words(item.name) ?? words(item.claim)).filter(Boolean);
  if (failed.length) lines.push('', '没通过的检查：', ...failed.map(item => `- ${item}`));
  else if (passed) lines.push('', `检查通过 ${passed} 项。`);
  const listed = (key: string, heading: string) => {
    const texts = items(block[key]).map(item => words(item) ?? (loose(item) ? words(item.text) : undefined)).filter(Boolean);
    if (texts.length) lines.push('', heading, ...texts.map(item => `- ${item}`));
  };
  listed('blockers', '卡住的地方：');
  listed('unknowns', '还没核实：');
  const notes = words(block.notes);
  if (notes) lines.push('', notes);
  return lines.length ? lines.join('\n').trim() : undefined;
}
/** The prose for a summary block that is the whole answer, for the schemas a person can read without the block. */
function summaryProse(block: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(block); } catch { return; }
  return loose(parsed) && parsed.schemaVersion === 'website-builder/1' ? websiteBuilderProse(parsed) : undefined;
}

/** The answer a person reads, and whether the runtime marked parts of it unverified (those notes stay in the details). */
export function readableAnswer(raw: string): { text: string; caveat: boolean } {
  const { text, caveat } = withoutCaveats(raw.trim());
  let out = text.trim();
  const summary = leadingSummaryEnd(out);
  if (summary !== undefined) out = out.slice(summary).trim() || (summaryProse(out.slice(0, summary)) ?? '');
  out = out.replace(EVIDENCE_GROUP, '').replace(TOKENED_LINK, '（预览链接见详情）').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out || text.replace(TOKENED_LINK, '（预览链接见详情）').trim(), caveat };
}

/** A step that ended without an answer gets a runtime note in its place: no output after a timeout, repair or recovery
 * exhausted, or raw observations when the final synthesis failed. These openings are fixed runtime text, never a model's.
 * The limitations line quotes an error message, which can span lines, so it is matched up to the fixed sentence after it. */
const STAND_IN = /^(?:Partial answer — no output\.|Partial answer — repair exhausted for "|Partial answer — limited evidence: [\s\S]*?\.\n\nFinal synthesis was unavailable\. The following are untrusted observations)/;
/** A repair fallback that had to drop the whole prose keeps only this sentence, which the runtime may then wrap in its
 * limited-evidence line and Unknown list. The note is the entire text: an answer that merely contains it is kept. */
const PRUNED_PROSE = /^(?:Partial answer — limited evidence: [\s\S]*?\.\n\n)?Partial answer: see the retained evidence-backed structured entries\.$/;
export function isStandInAnswer(content: string): boolean {
  const text = content.trim();
  return STAND_IN.test(text) || PRUNED_PROSE.test(text.replace(RUNTIME_UNKNOWN_SUFFIX, '').trim());
}
/** Which output is the Run's answer: the last one a step actually wrote. A later step that failed leaves only a note,
 * which stays in the process view; when every output is such a note, the last one is all there is. */
export function answerArtifact<T extends { content: string }>(artifacts: readonly T[]): T | undefined {
  return [...artifacts].reverse().find(item => item.content.trim() && !isStandInAnswer(item.content)) ?? artifacts.at(-1);
}

/** What the chat shows of a Run's answer: the prose a person reads. A link carrying an access token is never shown in a
 * message, which can be copied or forwarded. */
export function readableReply(text: string): string {
  return readableAnswer(text).text;
}
