import { describe, expect, it } from 'vitest';
import { boundedExecutorInput, boundedObservations, EXECUTOR_PROMPT_CHARS } from '../src/runtime/prompt-context.js';
import { digest } from '../src/runtime/engine.js';
import { decisionSchema } from '../src/runtime/contracts.js';

describe('executor context budget', () => {
  it('retains an aggregate reference and hash when individual observation references exceed the budget', () => {
    const observations = Array.from({ length: 100 }, (_, i) => ({ tool: 'sources.read', argument: 'source.csv', result: { id: 'source.csv', content: `page ${i} ` + 'x'.repeat(3000) } }));
    const projected = boundedObservations(observations, () => ['source.csv']);
    const omitted = projected[0]!.result as { count: number; contentHash: string };
    expect(projected[0]!.tool).toBe('context.compacted');
    expect(omitted.count).toBeGreaterThan(0);
    expect(omitted.contentHash).toBe(digest(observations.slice(0, omitted.count)));
    expect(projected.at(-1)).toEqual(observations.at(-1));
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(10_000);
  });
  it('compacts old large observations to references and exact hashes while retaining the latest page', () => {
    const observations = Array.from({ length: 5 }, (_, i) => ({ tool: 'sources.read', argument: 'source.csv', result: { id: 'source.csv', content: `page ${i} ` + 'x'.repeat(3000) } }));
    const projected = boundedObservations(observations, () => ['source.csv']);
    expect(projected.at(-1)).toEqual(observations.at(-1));
    expect(projected[0]!.result).toMatchObject({ reference: 'observations/0', contentHash: digest(observations[0]!.result), evidenceRefs: ['source.csv'] });
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(10_000);
    expect(observations[0]!.result.content).toHaveLength(3007);
  });

  it('keeps references and large-result previews stable when JSONB reorders result keys', () => {
    const original = [{ tool: 'sources.read', argument: 'source.csv', result: { id: 'source.csv', content: 'x'.repeat(8000) } }];
    const reordered = [{ ...original[0]!, result: { content: 'x'.repeat(8000), id: 'source.csv' } }];
    expect(boundedObservations(original, () => ['source.csv'])).toEqual(boundedObservations(reordered, () => ['source.csv']));
  });

  it('enforces a total budget across dependencies, observations, sources and receipts without changing authorization', () => {
    const input = { task: { id: 'pulse' }, allowedTools: [{ id: 'approved' }], availableEvidenceRefs: ['artifact_1', 'source.csv'],
      dependencies: [{ id: 'artifact_1', taskId: 'inspect', title: 'Analysis', content: 'x'.repeat(80_000), evidenceRefs: ['source.csv'] }],
      observations: [{ tool: 'sources.read', result: 'x'.repeat(80_000) }], presentedSources: [{ id: 'source.csv', content: 'x'.repeat(80_000) }], toolReceipts: [{ receiptId: 'receipt_1', output: 'x'.repeat(80_000) }] };
    const projected = boundedExecutorInput('system', input);
    expect(JSON.stringify(projected).length + 6).toBeLessThanOrEqual(EXECUTOR_PROMPT_CHARS);
    expect(projected.allowedTools).toEqual(input.allowedTools);
    expect((projected.dependencies as any[])[0]).toMatchObject({ id: 'artifact_1', taskId: 'inspect', evidenceRefs: ['source.csv'], schemaVersion: 'context-reference/1' });
    expect((projected.dependencies as any[])[0].preview.length).toBeLessThanOrEqual(2000);
    expect(input.dependencies[0]!.content).toHaveLength(80_000);
  });

  it('rejects an oversized fixed core before invoking a provider', () => {
    expect(() => boundedExecutorInput('s', { goal: 'x'.repeat(EXECUTOR_PROMPT_CHARS) })).toThrow('Executor context exceeds');
  });

  it.each([{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { characterOffset: -1 }])('rejects invalid source pagination %j', page => {
    expect(() => decisionSchema.parse({ type: 'tool', tool: 'sources.read', argument: 'source.csv', ...page })).toThrow();
  });
});
