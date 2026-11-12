/** What a person reads of a Run's answer, in the chat and at the top of a finished task: the answer itself.
 * The Run keeps the full text with its evidence IDs, runtime caveats and summary blocks; those stay one click away.
 * Pure string code, shared by the server and the page. */

/** The runtime's own list of what a partial Run left unverified, appended once the Run is delivered. Never model text. */
export const RUNTIME_UNKNOWN_SUFFIX = /\n\nUnknown:\n- Remaining work:[\s\S]*$/;
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

/** The answer a person reads, and whether the runtime marked parts of it unverified (those notes stay in the details). */
export function readableAnswer(raw: string): { text: string; caveat: boolean } {
  const { text, caveat } = withoutCaveats(raw.trim());
  let out = text.trim();
  const summary = leadingSummaryEnd(out);
  if (summary !== undefined) out = out.slice(summary);
  out = out.replace(EVIDENCE_GROUP, '').replace(TOKENED_LINK, '（预览链接见详情）').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out || text.replace(TOKENED_LINK, '（预览链接见详情）').trim(), caveat };
}

/** What the chat shows of a Run's answer: the prose a person reads. A link carrying an access token is never shown in a
 * message, which can be copied or forwarded. */
export function readableReply(text: string): string {
  return readableAnswer(text).text;
}
