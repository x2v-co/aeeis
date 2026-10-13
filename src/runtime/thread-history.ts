import { createHash } from 'node:crypto';
import type { AgentRun } from './contracts.js';
import type { RunRepository } from './repository.js';
import type { Ownership } from '../security/principal.js';
import { isOwnedBy, principalAudience } from '../security/principal.js';
import { ThreadConflict } from './threads.js';
import { capDebugField, redactRunData } from './run-debug.js';
import { MAX_RENDERED_THREAD_HISTORY_CHARS, renderThreadHistoryInput } from './thread-context.js';

export const DEFAULT_THREAD_HISTORY_BYTES = 12 * 1024;
export const MAX_THREAD_HISTORY_BYTES = 64 * 1024;
const MAX_ANCESTORS = 20;
const MAX_ARTIFACTS = 8;
const MAX_EXCERPT_BYTES = 2 * 1024;
const exclusions = ['rawModelCalls', 'credentials', 'environments', 'toolPayloads', 'sourcePayloads', 'approvals', 'permissions', 'isolatedEvidence'];
export interface ThreadHistoryExcerpt {
  kind: 'goal' | 'plan' | 'review' | 'answer' | 'artifact';
  ref: string;
  hash: string;
  text: string;
  truncated: boolean;
}
export interface ThreadHistoryEntry {
  runId: string;
  revision: number;
  threadSequence: number;
  classification: AgentRun['privacy'];
  excerpts: ThreadHistoryExcerpt[];
}
export interface ThreadHistoryAccess {
  goalId: string;
  memoryManifestId?: string;
}
export interface ThreadHistory {
  policyVersion: 'aeeis-thread-history/1';
  threadId: string;
  parentRunId?: string;
  budgetBytes: number;
  actualBytes: number;
  hash: string;
  exclusions: string[];
  visitedAncestors: number;
  /** Unvisited ancestry is counted as one omitted continuation, without fetching it. */
  /** Artifact omissions also include superseded outputs. Excerpt omissions count
   * eligible fields skipped for space. Continuations are not total unseen runs. */
  omitted: { excerpts: number; artifacts: number; ancestorContinuations: number };
  truncated: number;
  entries: ThreadHistoryEntry[];
  /** Transitive access requirements survive excerpt/ancestor omission. Missing
   * only on older snapshots, whose ancestry must be recovered before reuse. */
  accessProvenance?: ThreadHistoryAccess[];
}
function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
export function threadHistoryHash(snapshot: ThreadHistory): string {
  const { hash: _hash, ...payload } = snapshot;
  return hash(JSON.stringify(payload));
}
/** Count the entire serialized envelope, including the byte count and hash. */
function measure(snapshot: ThreadHistory): number {
  snapshot.actualBytes = 0;
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (bytes === snapshot.actualBytes) return bytes;
    snapshot.actualBytes = bytes;
  }
}
function fits(snapshot: ThreadHistory, budgetBytes: number, renderedBudget = MAX_RENDERED_THREAD_HISTORY_CHARS): boolean {
  return measure(snapshot) <= budgetBytes && JSON.stringify(renderThreadHistoryInput(snapshot)).length <= renderedBudget;
}
function prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  let end = Math.min(bytes, buffer.length);
  while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
const classificationRank = { public: 0, internal: 1, confidential: 2, private: 3 };
export function assertHistoryPrivacy(run: AgentRun, privacy: AgentRun['privacy']): void {
  if (classificationRank[run.privacy ?? 'internal'] > classificationRank[privacy])
    throw new ThreadConflict('Thread history classification exceeds the requested Run privacy');
}
export function assertThreadHistoryUnchanged(before: ThreadHistory | undefined, after: ThreadHistory | undefined): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new ThreadConflict('Thread history snapshot is immutable');
}

function mergeAccess(target: ThreadHistoryAccess[], additions: ThreadHistoryAccess[]): void {
  for (const access of additions) {
    if (!target.some(item => item.goalId === access.goalId && item.memoryManifestId === access.memoryManifestId)) target.push({ ...access });
  }
}

/** New snapshots carry their complete access requirements without more reads.
 * For legacy snapshots, recover them along ancestry independently of excerpt
 * budgets and the excerpt ancestor limit; incomplete provenance fails closed. */
export async function threadHistoryAccessProvenance(repository: RunRepository, run: AgentRun, scope: Ownership): Promise<ThreadHistoryAccess[]> {
  const access: ThreadHistoryAccess[] = [], seen = new Set<string>();
  let current = run;
  for (;;) {
    if (seen.has(current.id)) throw new ThreadConflict('Invalid thread ancestry');
    seen.add(current.id);
    if (!isOwnedBy(current, scope)) throw new ThreadConflict('Thread history must belong to the same owner and tenant');
    if (current.goalId) mergeAccess(access, [{ goalId: current.goalId, ...(current.context.memoryManifestId ? { memoryManifestId: current.context.memoryManifestId } : {}) }]);
    const history = current.context.threadHistory;
    if (history?.accessProvenance !== undefined) { mergeAccess(access, history.accessProvenance); break; }
    if (!history || !current.parentRunId) break;
    const ancestor = await repository.get(current.parentRunId, scope);
    if (ancestor.threadId !== current.threadId || ancestor.threadSequence === undefined || current.threadSequence === undefined || ancestor.threadSequence >= current.threadSequence)
      throw new ThreadConflict('Invalid thread ancestry order');
    current = ancestor;
  }
  return access;
}

/** Summaries may derive from any source in the run; redaction cannot downgrade
 * their classification. Reusing a snapshot never admits a new recipient. */
function historyClassification(run: AgentRun, scope: Ownership, privacy: AgentRun['privacy']): AgentRun['privacy'] {
  const audience = principalAudience({ id: scope.owner, tenantId: scope.tenantId });
  // Older owner-only contexts used bare owner IDs. Ownership was checked first.
  if (!run.context.audience.includes(audience) && !run.context.audience.includes(scope.owner))
    throw new ThreadConflict('Thread history audience does not include its owner');
  let classification = run.privacy ?? 'internal';
  for (const candidate of [...run.context.sources.map(source => source.classification ?? classification), ...(run.context.threadHistory?.entries.map(entry => entry.classification) ?? [])]) {
    if (classificationRank[candidate] > classificationRank[classification]) classification = candidate;
  }
  assertHistoryPrivacy({ ...run, privacy: classification }, privacy);
  return classification;
}

/** Isolated external outputs remain unavailable even when an artifact cites
 * them indirectly through another artifact. */
function isolatedEvidence(run: AgentRun): Set<string> {
  const refs = new Set((run.toolReceipts ?? []).filter(receipt => receipt.authorization?.decision === 'isolated').flatMap(receipt => [receipt.receiptId, ...receipt.outputRefs]));
  for (const outcome of run.delegationOutcomes ?? []) if (outcome.disposition === 'isolated') {
    refs.add(outcome.receiptRef);
    const result = outcome.result as { artifacts?: unknown } | undefined;
    if (Array.isArray(result?.artifacts)) for (const artifact of result.artifacts) {
      if (artifact && typeof artifact === 'object') {
        if (typeof artifact.id === 'string') refs.add(artifact.id);
        if (typeof artifact.ref === 'string') refs.add(artifact.ref);
      }
    }
  }
  let changed: boolean;
  do {
    changed = false;
    for (const source of run.context.sources) if (!refs.has(source.id) && source.origin && refs.has(source.origin.ref)) { refs.add(source.id); changed = true; }
    for (const artifact of run.artifacts) if (!refs.has(artifact.id) && artifact.evidenceRefs.some(ref => refs.has(ref))) { refs.add(artifact.id); changed = true; }
  } while (changed);
  return refs;
}

/** Fetch only the selected ancestry. Parent-first selection favors recent evidence;
 * persisted entries are chronological. This schema deliberately selects prose,
 * never complete model, source, tool or delegation records. */
export async function buildThreadHistory(repository: RunRepository, threadId: string, parent: AgentRun | undefined, scope: Ownership, privacy: AgentRun['privacy'], budgetBytes: number, authorize?: (run: AgentRun, access: ThreadHistoryAccess[]) => Promise<void>): Promise<ThreadHistory> {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0 || budgetBytes > MAX_THREAD_HISTORY_BYTES) throw new RangeError('Invalid thread context byte budget');
  const snapshot: ThreadHistory = {
    policyVersion: 'aeeis-thread-history/1', threadId, ...(parent ? { parentRunId: parent.id } : {}),
    budgetBytes, actualBytes: 0, hash: '0'.repeat(64), exclusions: [...exclusions],
    visitedAncestors: 0, omitted: { excerpts: 0, artifacts: 0, ancestorContinuations: 0 }, truncated: 0, entries: [], accessProvenance: [],
  };
  if (!fits(snapshot, budgetBytes)) throw new RangeError('Thread context budget is too small for the history envelope');
  const seen = new Set<string>();
  let current = parent;
  let exhausted = false;
  while (current && snapshot.visitedAncestors < MAX_ANCESTORS && !exhausted) {
    if (seen.has(current.id) || current.threadId !== threadId || current.threadSequence === undefined
      || (parent && current.threadSequence > parent.threadSequence!)) throw new ThreadConflict('Invalid thread ancestry');
    seen.add(current.id);
    if (!isOwnedBy(current, scope)) throw new ThreadConflict('Thread history must belong to the same owner and tenant');
    const classification = historyClassification(current, scope, privacy);
    const access = await threadHistoryAccessProvenance(repository, current, scope);
    await authorize?.(current, access);
    mergeAccess(snapshot.accessProvenance!, access);
    snapshot.visitedAncestors++;
    const entry: ThreadHistoryEntry = { runId: current.id, revision: current.revision, threadSequence: current.threadSequence, classification, excerpts: [] };
    // Reserve small counter growth before filling the envelope to its boundary.
    const selectionBudget = budgetBytes - 64;
    const fitsSelection = () => fits(snapshot, selectionBudget, MAX_RENDERED_THREAD_HISTORY_CHARS - 64);
    snapshot.entries.unshift(entry);
    if (!fitsSelection()) {
      snapshot.entries.shift(); exhausted = true;
      snapshot.omitted.excerpts += 1 + (current.plans.length ? 1 : 0) + (current.review ? 1 : 0) + current.answers.length;
      snapshot.omitted.artifacts += current.artifacts.length;
      snapshot.omitted.ancestorContinuations++;
      break;
    }
    const candidates: Array<{ kind: ThreadHistoryExcerpt['kind']; ref: string; text: string; hash?: string }> = [
      { kind: 'goal', ref: `${current.id}#goal`, text: current.goal },
    ];
    const isolated = isolatedEvidence(current);
    // Plan/review summaries can repeat withheld artifacts; do not reintroduce
    // their prose through a summary even when the artifact itself is excluded.
    const isolatedArtifacts = current.artifacts.some(artifact => isolated.has(artifact.id));
    const plan = current.plans.at(-1);
    if (plan && !isolatedArtifacts) candidates.push({ kind: 'plan', ref: `${current.id}#plan:${plan.version}`, text: plan.summary });
    else if (plan) snapshot.omitted.excerpts++;
    if (current.review && !isolatedArtifacts) candidates.push({ kind: 'review', ref: `${current.id}#review`, text: current.review.summary });
    else if (current.review) snapshot.omitted.excerpts++;
    // Final output excerpts precede potentially numerous question/answer pairs.
    const taskIds = new Set<string>();
    const artifacts: AgentRun['artifacts'] = [];
    for (let index = current.artifacts.length - 1; index >= 0 && artifacts.length < MAX_ARTIFACTS; index--) {
      const artifact = current.artifacts[index]!;
      if (taskIds.has(artifact.taskId)) continue;
      taskIds.add(artifact.taskId);
      if (!isolated.has(artifact.id)) artifacts.push(artifact);
    }
    snapshot.omitted.artifacts += current.artifacts.length - artifacts.length;
    for (const artifact of artifacts.reverse()) candidates.push({ kind: 'artifact', ref: artifact.id, text: artifact.content, hash: artifact.hash });
    // Append lazily so a large answer history cannot expand the candidate list.
    const total = candidates.length + current.answers.length;
    for (let index = 0; index < total; index++) {
      const answer = current.answers[index - candidates.length];
      const candidate = candidates[index] ?? { kind: 'answer' as const, ref: `${current.id}#answer:${index - candidates.length}`, text: `${answer!.question}\n${answer!.answer}` };
      // Keep the ancestor's credential sources available while scrubbing copied
      // prose, then apply the history's own truncation and envelope budget.
      const text = redactRunData({ text: candidate.text, sourceValue: current }, { capFields: false }).text;
      const capped = capDebugField(text);
      const marker = '\n…[truncated]';
      const excerptText = Buffer.byteLength(capped, 'utf8') > MAX_EXCERPT_BYTES
        ? prefix(capped, MAX_EXCERPT_BYTES - Buffer.byteLength(marker, 'utf8')) + marker : capped;
      const excerpt: ThreadHistoryExcerpt = { kind: candidate.kind, ref: candidate.ref, hash: candidate.hash ?? hash(text), text: excerptText, truncated: excerptText !== text };
      entry.excerpts.push(excerpt);
      if (!fitsSelection()) {
        excerpt.truncated = true;
        let low = 0, high = Buffer.byteLength(excerpt.text, 'utf8');
        const original = excerpt.text;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          excerpt.text = prefix(original, mid);
          if (fitsSelection()) low = mid; else high = mid - 1;
        }
        excerpt.text = prefix(original, low);
        if (!excerpt.text || !fitsSelection()) entry.excerpts.pop();
        if (!entry.excerpts.includes(excerpt)) snapshot.omitted.excerpts++;
        else snapshot.truncated++;
        snapshot.omitted.excerpts += total - index - 1;
        snapshot.omitted.artifacts += candidates.slice(index + (entry.excerpts.includes(excerpt) ? 1 : 0)).filter(item => item.kind === 'artifact').length;
        exhausted = true;
        break;
      }
      if (excerpt.truncated) snapshot.truncated++;
    }
    if (!current.parentRunId) { current = undefined; break; }
    if (exhausted || snapshot.visitedAncestors === MAX_ANCESTORS) { snapshot.omitted.ancestorContinuations++; break; }
    // Do not fetch another aggregate if even its smallest provenance envelope
    // cannot fit. Its ID is already present on the current authorized ancestor.
    snapshot.entries.unshift({ runId: current.parentRunId, revision: 0, threadSequence: 1, classification: 'public', excerpts: [] });
    const canFitAncestor = fitsSelection();
    snapshot.entries.shift();
    if (!canFitAncestor) { snapshot.omitted.ancestorContinuations++; break; }
    const previousSequence = current.threadSequence;
    current = await repository.get(current.parentRunId, scope);
    if (current.threadSequence === undefined || current.threadSequence >= previousSequence) throw new ThreadConflict('Invalid thread ancestry order');
  }
  if (!fits(snapshot, budgetBytes)) throw new RangeError('Thread context budget is too small for the history envelope');
  snapshot.hash = threadHistoryHash(snapshot);
  return snapshot;
}
