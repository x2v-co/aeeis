/** Clean text lists without treating punctuation-free bullet labels as truncation. */
export function normalizeArtifactLists(structured: Record<string, unknown>): { duplicates: number; truncated: number } {
  let duplicates = 0, truncated = 0;
  const keyFor = (text: string) => text.normalize('NFKC').trim().replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ').toLocaleLowerCase().replace(/[.!?。！？]+$/u, '').trim();
  const incomplete = (text: string) => /(?:\.{3}|…|[,;:，；：—-])\s*$/u.test(text)
    || /\b(?:and|or|but|because|due to|due|with|without|for|from|to|of|the|including|such as|which|will|would|should|must)\s*$/i.test(text)
    || /\b(?:a|an)\s*$/.test(text) && text.split(/\s+/).length >= 4
    || /(?:由于|因为|以及|并且|但是|包括|例如|从而|以便)\s*$/u.test(text);
  for (const section of ['progress', 'completedChanges', 'blockers', 'risks', 'decisions', 'nextActions', 'unknowns']) {
    const list = structured[section];
    if (!Array.isArray(list)) continue;
    const seen = new Map<string, Record<string, unknown>>();
    const texts = list.flatMap(item => item && typeof item === 'object' && typeof item.text === 'string' ? [item.text.trim()] : []);
    structured[section] = list.filter(item => {
      if (!item || typeof item !== 'object' || typeof item.text !== 'string') return true;
      // Per-field PDF unknowns are part of a completeness contract, rather than
      // ordinary report lists: identical reasons for different fields are valid.
      if (typeof item.field === 'string') return true;
      // Runtime-derived entries are split from prose at sentence/clause marks
      // (e.g. a trailing "；"); they are not model-truncated items.
      const derived = (item as { derived?: unknown }).derived === true;
      const text = item.text.trim(), key = keyFor(text);
      // Also detect a cut-off word when an intact version is present. A shorter
      // complete bullet at a word boundary remains valid.
      const cutWord = !/[.!?。！？]$/u.test(text) && key.length >= 16
        && /[a-z]{4,}$/i.test(key)
        && texts.some(other => { const full = keyFor(other); return full.startsWith(key) && /^[a-z]{3,}\b/i.test(full.slice(key.length)); });
      if (text && !derived && (incomplete(text) || cutWord)) { truncated++; return false; }
      const previous = seen.get(key);
      if (previous) {
        if (Array.isArray(previous.evidenceRefs) && Array.isArray(item.evidenceRefs)) previous.evidenceRefs = [...new Set([...previous.evidenceRefs, ...item.evidenceRefs])];
        duplicates++;
        return false;
      }
      seen.set(key, item);
      return true;
    });
  }
  return { duplicates, truncated };
}
