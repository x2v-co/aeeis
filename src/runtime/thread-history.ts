import { createHash } from 'node:crypto';
import type { AgentRun } from './contracts.js';
import type { RunRepository } from './repository.js';
import type { Ownership } from '../security/principal.js';
import { isOwnedBy } from '../security/principal.js';
import { ThreadConflict } from './threads.js';

export const DEFAULT_THREAD_HISTORY_BYTES = 32 * 1024;
export const MAX_THREAD_HISTORY_BYTES = 64 * 1024;
const MAX_ANCESTORS = 20;
const MAX_ARTIFACTS = 8;
const MAX_EXCERPT_BYTES = 8 * 1024;
const exclusions = ['rawModelCalls', 'credentials', 'environments', 'toolPayloads', 'sourcePayloads', 'approvals', 'permissions'];
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

/** Fetch only the selected ancestry. Parent-first selection favors recent evidence;
 * persisted entries are chronological. This schema deliberately selects prose,
 * never complete model, source, tool or delegation records. */
export async function buildThreadHistory(repository: RunRepository, threadId: string, parent: AgentRun | undefined, scope: Ownership, privacy: AgentRun['privacy'], budgetBytes: number): Promise<ThreadHistory> {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0 || budgetBytes > MAX_THREAD_HISTORY_BYTES) throw new RangeError('Invalid thread context byte budget');
  const snapshot: ThreadHistory = {
    policyVersion: 'aeeis-thread-history/1', threadId, ...(parent ? { parentRunId: parent.id } : {}),
    budgetBytes, actualBytes: 0, hash: '0'.repeat(64), exclusions: [...exclusions],
    visitedAncestors: 0, omitted: { excerpts: 0, artifacts: 0, ancestorContinuations: 0 }, truncated: 0, entries: [],
  };
  if (measure(snapshot) > budgetBytes) throw new RangeError('Thread context budget is too small for the history envelope');
  const seen = new Set<string>();
  let current = parent;
  let exhausted = false;
  while (current && snapshot.visitedAncestors < MAX_ANCESTORS && !exhausted) {
    if (seen.has(current.id) || current.threadId !== threadId || current.threadSequence === undefined
      || (parent && current.threadSequence > parent.threadSequence!)) throw new ThreadConflict('Invalid thread ancestry');
    seen.add(current.id);
    if (!isOwnedBy(current, scope)) throw new ThreadConflict('Thread history must belong to the same owner and tenant');
    assertHistoryPrivacy(current, privacy);
    snapshot.visitedAncestors++;
    const entry: ThreadHistoryEntry = { runId: current.id, revision: current.revision, threadSequence: current.threadSequence, classification: current.privacy ?? 'internal', excerpts: [] };
    // Reserve small counter growth before filling the envelope to its boundary.
    const selectionBudget = budgetBytes - 64;
    snapshot.entries.unshift(entry);
    if (measure(snapshot) > selectionBudget) {
      snapshot.entries.shift(); exhausted = true;
      snapshot.omitted.excerpts += 1 + (current.plans.length ? 1 : 0) + (current.review ? 1 : 0) + current.answers.length;
      snapshot.omitted.artifacts += current.artifacts.length;
      snapshot.omitted.ancestorContinuations++;
      break;
    }
    const candidates: Array<{ kind: ThreadHistoryExcerpt['kind']; ref: string; text: string; hash?: string }> = [
      { kind: 'goal', ref: `${current.id}#goal`, text: current.goal },
    ];
    const plan = current.plans.at(-1);
    if (plan) candidates.push({ kind: 'plan', ref: `${current.id}#plan:${plan.version}`, text: plan.summary });
    if (current.review) candidates.push({ kind: 'review', ref: `${current.id}#review`, text: current.review.summary });
    // Final output excerpts precede potentially numerous question/answer pairs.
    const taskIds = new Set<string>();
    const artifacts: AgentRun['artifacts'] = [];
    for (let index = current.artifacts.length - 1; index >= 0 && artifacts.length < MAX_ARTIFACTS; index--) {
      const artifact = current.artifacts[index]!;
      if (taskIds.has(artifact.taskId)) continue;
      taskIds.add(artifact.taskId); artifacts.push(artifact);
    }
    snapshot.omitted.artifacts += current.artifacts.length - artifacts.length;
    for (const artifact of artifacts.reverse()) candidates.push({ kind: 'artifact', ref: artifact.id, text: artifact.content, hash: artifact.hash });
    // Append lazily so a large answer history cannot expand the candidate list.
    const total = candidates.length + current.answers.length;
    for (let index = 0; index < total; index++) {
      const answer = current.answers[index - candidates.length];
      const candidate = candidates[index] ?? { kind: 'answer' as const, ref: `${current.id}#answer:${index - candidates.length}`, text: `${answer!.question}\n${answer!.answer}` };
      const excerpt: ThreadHistoryExcerpt = { kind: candidate.kind, ref: candidate.ref, hash: candidate.hash ?? hash(candidate.text), text: prefix(candidate.text, MAX_EXCERPT_BYTES), truncated: Buffer.byteLength(candidate.text, 'utf8') > MAX_EXCERPT_BYTES };
      entry.excerpts.push(excerpt);
      if (measure(snapshot) > selectionBudget) {
        excerpt.truncated = true;
        let low = 0, high = Buffer.byteLength(excerpt.text, 'utf8');
        const original = excerpt.text;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          excerpt.text = prefix(original, mid);
          if (measure(snapshot) <= selectionBudget) low = mid; else high = mid - 1;
        }
        excerpt.text = prefix(original, low);
        if (!excerpt.text || measure(snapshot) > selectionBudget) entry.excerpts.pop();
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
    const canFitAncestor = measure(snapshot) <= selectionBudget;
    snapshot.entries.shift();
    if (!canFitAncestor) { snapshot.omitted.ancestorContinuations++; break; }
    const previousSequence = current.threadSequence;
    current = await repository.get(current.parentRunId, scope);
    if (current.threadSequence === undefined || current.threadSequence >= previousSequence) throw new ThreadConflict('Invalid thread ancestry order');
  }
  if (measure(snapshot) > budgetBytes) throw new RangeError('Thread context budget is too small for the history envelope');
  snapshot.hash = threadHistoryHash(snapshot);
  return snapshot;
}
