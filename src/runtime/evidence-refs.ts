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
  if (observed.has(base)) return base;
  // r78 lt: a malformed JSON string can leave closing punctuation glued to an exact id ("source_…]}],").
  const token = /^[A-Za-z]+_[A-Za-z0-9-]+/.exec(canonical)?.[0];
  if (token && token !== canonical && observed.has(token)) return token;
  // r78 md: a one- or two-character typo in a long generated id. Map only when exactly one known identity is that
  // close and it was received, so a sibling or isolated id can never be reached through a near miss.
  const near = nearMissRef(token ?? canonical, known);
  return near && observed.has(near) ? near : canonical;
}

function nearMissRef(ref: string, known: Set<string>): string | undefined {
  const prefix = /^[A-Za-z]+_/.exec(ref)?.[0];
  if (!prefix || ref.length < prefix.length + 16) return undefined;
  const matches = [...known].filter(id => id.startsWith(prefix) && Math.abs(id.length - ref.length) <= 2 && editDistanceWithin(id, ref, 2));
  return matches.length === 1 ? matches[0] : undefined;
}

function editDistanceWithin(a: string, b: string, max: number): boolean {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]!);
    }
    if (best > max) return false;
    previous = row;
  }
  return previous[b.length]! <= max;
}

/** Shape of an evidence identity or scoped citation; anything else in an evidenceRefs list is formatting noise. */
export const evidenceIdShape = /^[A-Za-z][A-Za-z0-9]*[_:][A-Za-z0-9_.:#=/@-]+$/;

