import { createHash } from 'node:crypto';
import type { Step } from './contracts.js';
import { isSourceReadTool, isStructuredSourceTool } from './source-tools.js';

/** Includes system and serialized input, measured before sending or reserving billing. */
export const EXECUTOR_PROMPT_CHARS = 96_000;
export const OBSERVATION_PROMPT_CHARS = 10_000;
export const LATEST_OBSERVATION_RESULT_CHARS = 6000;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
// JSONB may reorder keys. References and previews must survive reconciliation.
const serialized = (value: unknown) => JSON.stringify(canonical(value)) ?? 'null';
const size = (value: unknown) => serialized(value).length;
function compact(value: unknown, reference: string, evidenceRefs: string[] = []) {
  const content = serialized(value);
  return { schemaVersion: 'context-reference/1', reference,
    contentHash: createHash('sha256').update(content).digest('hex'), totalChars: content.length, evidenceRefs,
    instructions: 'Payload omitted from this prompt; the full result is retained in the Run. A reference or hash alone does not support claims about omitted details.' };
}

function sourceObservationMetadata(observation: Step['observations'][number]) {
  const result = observation.result as Record<string, unknown> | null;
  if (observation.tool === 'sources.csvQuery' && result && typeof result === 'object') {
    return { id: result.id, sourceContentHash: result.sourceContentHash,
      matchedRowCount: result.matchedRowCount, totalResultRows: result.totalResultRows, truncated: result.truncated };
  }
  if (isStructuredSourceTool(observation.tool) && result && typeof result === 'object') {
    return { id: result.id, sourceContentHash: result.sourceContentHash,
      ...Object.fromEntries(['page', 'path', 'section', 'shape', 'rowCount', 'sampled', 'truncated', 'totalHeadings', 'totalEntries', 'supported'].filter(key => result[key] !== undefined).map(key => [key, result[key]])) };
  }
  // Continuations are structured protocol data, independent of the evidence preview.
  return observation.tool === 'sources.read' && result && typeof result === 'object' && result.page
    ? { page: result.page, ...(typeof result.sourceContentHash === 'string' ? { sourceContentHash: result.sourceContentHash } : {}) } : {};
}

/** Keep the newest bounded result and compact older large results without changing durable observations. */
export function boundedObservations(observations: Step['observations'], refs: (value: unknown) => string[], budget = OBSERVATION_PROMPT_CHARS): Step['observations'] {
  const omittedReference = (omitted: Step['observations']) => ({ tool: 'context.compacted', argument: 'observations',
    result: { ...compact(omitted, 'observations/omitted'), count: omitted.length } });
  // Reserve an aggregate reference so a long history cannot silently disappear.
  let remaining = budget - 2 - size(omittedReference(observations)) - 1;
  const output: Step['observations'] = [];
  for (let index = observations.length - 1; index >= 0; index--) {
    const observation = observations[index]!;
    let projected = observation;
    if (size(observation.result) > (index === observations.length - 1 ? LATEST_OBSERVATION_RESULT_CHARS : 1000) || size(observation) + 1 > remaining) {
      const projection = { ...compact(observation.result, `observations/${index}`, refs(observation.result)),
        ...sourceObservationMetadata(observation),
        ...(index === observations.length - 1 && size(observation.result) > LATEST_OBSERVATION_RESULT_CHARS ? { preview: serialized(observation.result).slice(0, 4000), previewTruncated: true } : {}) };
      // The preview is itself JSON-escaped when the observation enters the prompt.
      while (projection.preview?.length && (size(projection) > LATEST_OBSERVATION_RESULT_CHARS || size({ ...observation, result: projection }) + 1 > remaining)) {
        projection.preview = projection.preview.slice(0, Math.floor(projection.preview.length / 2));
      }
      projected = { ...observation, result: projection };
    }
    if (size(projected) + 1 > remaining) {
      const omitted = omittedReference(observations.slice(0, index + 1));
      if (size(omitted) + size(output) + 1 <= budget) output.unshift(omitted);
      break;
    }
    output.unshift(projected); remaining -= size(projected) + 1;
  }
  return output;
}

/** Preserve authorization/protocol fields. Reduce optional evidence payloads, then reject an oversized fixed core. */
export function boundedExecutorInput(system: string, input: Record<string, unknown>): Record<string, unknown> {
  const output = { ...input };
  for (const key of ['dependencies', 'observations', 'presentedSources', 'toolReceipts', 'answers']) {
    if (system.length + size(output) <= EXECUTOR_PROMPT_CHARS) break;
    const items = output[key];
    if (!Array.isArray(items)) continue;
    const projected = [...items]; output[key] = projected;
    const ordered = items.map((value, index) => ({ index, size: size(value) })).sort((a, b) => b.size - a.size);
    for (const { index } of ordered) {
      if (system.length + size(output) <= EXECUTOR_PROMPT_CHARS) break;
      const item = items[index] as Record<string, unknown>;
      const reference = typeof item.id === 'string' ? item.id : `${key}/${index}`;
      if (key === 'observations' && isSourceReadTool(item.tool)) {
        // Preserve the newest bounded page through the overall executor projection too.
        if (index === items.length - 1 && size(item.result) <= LATEST_OBSERVATION_RESULT_CHARS) continue;
        projected[index] = { ...item, result: { ...compact(item.result, reference),
          ...sourceObservationMetadata(item as Step['observations'][number]) } };
        continue;
      }
      projected[index] = { ...compact(item, reference), ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(key === 'dependencies' ? { preview: serialized(item).slice(0, 2000), previewTruncated: true } : {}),
        ...(typeof item.taskId === 'string' ? { taskId: item.taskId } : {}), ...(typeof item.title === 'string' ? { title: item.title } : {}),
        ...(typeof item.receiptId === 'string' ? { receiptId: item.receiptId } : {}), ...(Array.isArray(item.outputRefs) ? { outputRefs: item.outputRefs } : {}),
        ...(Array.isArray(item.evidenceRefs) ? { evidenceRefs: item.evidenceRefs } : {}) };
    }
  }
  if (system.length + size(output) > EXECUTOR_PROMPT_CHARS) throw new Error('Executor context exceeds the 96000 character budget; reduce the goal, tool catalog or fixed context');
  return output;
}
