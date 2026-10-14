import type { Step } from './contracts.js';
import { projectPulseArtifactSchema } from './contracts.js';

export const repairMaxTokens = 4096;
export const repairMaxBytes = 64 * 1024;
export const repairTimeoutMs = 180_000;
export interface FinishProblem { path: string; code: string; message: string }
export type FinishRepair = NonNullable<Step['finishRepair']>;

const parts = (path: string) => path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

/** Copy only failed fields. All other fields, identities and array members stay frozen. */
export function mergeFinishRepair(repair: FinishRepair, output: unknown): unknown {
  const merged = structuredClone(repair.candidate);
  if (!record(merged) || !record(output)) return merged;
  for (const problem of repair.problems ?? []) {
    const path = parts(problem.path);
    if (!['content', 'evidenceRefs', 'structured', 'title', 'limitations'].includes(path[0] ?? '') || path.includes('schemaVersion')) continue;
    let target: unknown = merged, source: unknown = output;
    for (const key of path.slice(0, -1)) {
      if (!record(target) || !record(source)) { source = undefined; break; }
      target = target[key]; source = source[key];
    }
    const key = path.at(-1)!;
    if (record(target) && record(source) && Object.hasOwn(source, key)) {
      // A root structured repair must still preserve the original schema identity.
      const replacement = structuredClone(source[key]);
      if (key === 'structured' && record(replacement) && record(target[key])) replacement.schemaVersion = target[key].schemaVersion;
      target[key] = replacement;
    }
  }
  return merged;
}

export function repairIsWorse(original: FinishProblem[], repaired: FinishProblem[]): boolean {
  const types = new Set(original.map(problem => problem.code));
  return repaired.length > original.length || repaired.some(problem => !types.has(problem.code));
}

/** Remove invalid claims from the pre-repair artifact while retaining valid evidence. */
export function pruneFailedFields(candidate: unknown, problems: FinishProblem[]): unknown {
  const result = structuredClone(candidate);
  if (!record(result)) return result;
  const removals = new Map<unknown[], Set<number>>();
  for (const problem of problems) {
    const path = parts(problem.path);
    if (path[0] === 'content') { result.content = 'Partial answer: see the retained evidence-backed structured entries.'; continue; }
    let target: unknown = result;
    for (const key of path) {
      if (Array.isArray(target) && /^\d+$/.test(key)) {
        const indices = removals.get(target) ?? new Set<number>();
        indices.add(Number(key)); removals.set(target, indices); break;
      }
      if (!record(target)) break;
      target = target[key];
    }
  }
  for (const [array, indices] of removals) for (const index of [...indices].sort((a, b) => b - a)) array.splice(index, 1);
  if (result.artifactType === 'project-pulse/1') {
    const input = record(result.structured) ? result.structured : {};
    const structured: Record<string, unknown> = { schemaVersion: 'project-pulse/1' };
    for (const key of ['progress', 'completedChanges', 'blockers', 'risks', 'decisions', 'owners', 'deadlines', 'nextActions', 'unknowns'] as const) {
      const schema = projectPulseArtifactSchema.shape[key];
      structured[key] = Array.isArray(input[key]) ? input[key].filter(item => schema.element.safeParse(item).success).slice(0, 30) : [];
    }
    result.structured = structured;
  }
  return result;
}
