/** Resolve formatting variants only against known identities. Preserve exact
 * denied IDs and reject ambiguous case variants instead of granting access. */
export function canonicalEvidenceRef(ref: string, allowed: Set<string>, known = allowed): string {
  const trimmed = ref.trim().replace(/^`([^`]+)`$/, '$1');
  const resolve = (candidate: string): string | undefined => {
    if (known.has(candidate)) return candidate;
    const matches = [...known].filter(id => id.toLowerCase() === candidate.toLowerCase());
    return matches.length === 1 && allowed.has(matches[0]!) ? matches[0] : undefined;
  };
  return resolve(trimmed) ?? resolve(trimmed.replace(/^(?:source|artifact|receipt):\s*/i, '')) ?? trimmed;
}

/** Resolve scoped citations only to identities the task actually received. */
export function baseEvidenceRef(ref: string, observed: Set<string>, known = observed): string {
  const canonical = canonicalEvidenceRef(ref, observed, known);
  if (known.has(canonical)) return canonical;
  const base = canonicalEvidenceRef(canonical.replace(/^(?:source|artifact|receipt):\s*/i, '').split(/[#:@\s]|\/rows?|\[/)[0]!, observed, known);
  return observed.has(base) ? base : canonical;
}

