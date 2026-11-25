import { describe, expect, it } from 'vitest';
import { boundedExecutorInput, boundedObservations, EXECUTOR_PROMPT_CHARS, OBSERVATION_PROMPT_CHARS, webEvidenceDigest } from '../src/runtime/prompt-context.js';
import { digest } from '../src/runtime/engine.js';
import { decisionSchema } from '../src/runtime/contracts.js';
import { queryCsvSource } from '../src/runtime/csv-query.js';
import { jsonRead, markdownSection, sampleSource } from '../src/runtime/source-readers.js';

describe('executor context budget', () => {
  it('preserves small aggregate rows when older query results are compacted', () => {
    const result = queryCsvSource({ id: 'source.csv', title: 'data.csv', source: 'upload', hash: 'h', content: 'due\n2026-10-13\n2026-10-14\n2026-10-13' }, { groupBy: ['due'], aggregates: [{ op: 'count', as: 'count' }] });
    const observation = { tool: 'sources.csvQuery', argument: 'source.csv', result };
    const observations = [observation, { tool: 'sources.read', argument: 'other', result: { content: 'x'.repeat(5000) } }];
    const projected = boundedObservations(observations, () => ['source.csv']);
    expect(projected[0]!.result).toMatchObject({ columns: ['due', 'count'], rows: [['2026-10-13', 2], ['2026-10-14', 1]] });
    const overall = boundedExecutorInput('system', { fixed: 'x'.repeat(90_000), observations });
    expect((overall.observations as typeof observations)[0]!.result).toMatchObject({ columns: result.columns, rows: result.rows });
  });
  it('PDF3: preserves exact writes and output metadata when compacting an older pdf.fill result', () => {
    const result = { id: 'pdf_output', form: { sourceRef: 'source_pdf', fieldCount: 8 },
      output: { ref: 'pdf_output', filename: 'filled.pdf', sha256: 'a'.repeat(64), sizeBytes: 100 },
      filledFields: [{ name: 'name', value: 'Maya Chen' }, { name: 'subscribe', value: false }],
      unfilledFields: [{ name: 'caseId', readOnly: true }], extra: 'x'.repeat(14000) };
    const observations = [{ tool: 'pdf.fill', argument: 'source_pdf', result }, { tool: 'sources.read', argument: 'source_case', result: { id: 'source_case', content: 'Case facts' } }];
    const expected = { output: result.output, form: result.form, filledFields: result.filledFields, unfilledFields: result.unfilledFields };
    expect(boundedObservations(observations, () => ['pdf_output'])[0]!.result).toMatchObject(expected);
    const overall = boundedExecutorInput('system', { fixed: 'x'.repeat(89000), observations });
    expect((overall.observations as typeof observations)[0]!.result).toMatchObject(expected);
    expect(JSON.stringify(overall).length + 6).toBeLessThanOrEqual(EXECUTOR_PROMPT_CHARS);
  });
  it('preserves structured reader selectors, counts, continuation and hashes through both projections', () => {
    const source = { id: 'source-fixture', source: 'upload', hash: 'stored-hash' };
    const reads = [
      { tool: 'sources.jsonRead', result: jsonRead({ ...source, title: 'data.json', content: JSON.stringify({ text: 'x'.repeat(12000) }) }, { path: '$.text' }), fields: ['path', 'shape', 'page', 'truncated'] },
      { tool: 'sources.markdownSection', result: markdownSection({ ...source, title: 'notes.md', content: '# Root\n' + 'x'.repeat(12000) }, { heading: 'Root' }), fields: ['section', 'page', 'truncated'] },
      { tool: 'sources.sample', result: sampleSource({ ...source, title: 'notes.txt', content: ('x'.repeat(1000) + '\n').repeat(100) }), fields: ['rowCount', 'sampled', 'truncated'] },
    ];
    for (const { tool, result, fields } of reads) {
      const observations = [0, 1].map(() => ({ tool, argument: source.id, result }));
      const expected = { schemaVersion: 'context-reference/1', id: result.id, sourceContentHash: result.sourceContentHash, contentHash: digest(result),
        ...Object.fromEntries(fields.map(field => [field, (result as any)[field]])) };
      const projected = boundedObservations(observations, () => [source.id]);
      expect(projected[0]!.result).toMatchObject(expected);
      expect(projected[1]).toEqual(observations[1]);
      const overall = boundedExecutorInput('system', { fixed: 'x'.repeat(87000), observations }).observations as typeof observations;
      expect(overall[0]!.result).toMatchObject(expected);
      expect(overall[1]).toEqual(observations[1]);
    }
  });
  it('preserves query counts and source hash on compacted observations and retains the latest query', () => {
    const result = queryCsvSource({ id: 'source.csv', title: 'data.csv', source: 'upload', hash: 'source-hash', content: 'id,note\n' + Array.from({ length: 50 }, (_, i) => `${i},${'x'.repeat(120)}`).join('\n') });
    const observations = [0, 1].map(() => ({ tool: 'sources.csvQuery', argument: 'source.csv', result }));
    const expected = { schemaVersion: 'context-reference/1', id: result.id, sourceContentHash: result.sourceContentHash, matchedRowCount: 50, totalResultRows: 50, truncated: true, contentHash: digest(result) };
    const projected = boundedObservations(observations, () => ['source.csv']);
    expect(projected[0]!.result).toMatchObject(expected);
    expect(projected[1]).toEqual(observations[1]);
    const overall = boundedExecutorInput('system', { fixed: 'x'.repeat(87_000), observations }).observations as typeof observations;
    expect(overall[0]!.result).toMatchObject(expected);
    expect(overall[1]).toEqual(observations[1]);
  });
  it('retains an aggregate reference and hash when individual observation references exceed the budget', () => {
    const observations = Array.from({ length: 100 }, (_, i) => ({ tool: 'sources.read', argument: 'source.csv', result: { id: 'source.csv', content: `page ${i} ` + 'x'.repeat(3000) } }));
    const projected = boundedObservations(observations, () => ['source.csv']);
    const omitted = projected[0]!.result as { count: number; contentHash: string };
    expect(projected[0]!.tool).toBe('context.compacted');
    expect(omitted.count).toBeGreaterThan(0);
    expect(omitted.contentHash).toBe(digest(observations.slice(0, omitted.count)));
    expect(projected.at(-1)).toEqual(observations.at(-1));
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(OBSERVATION_PROMPT_CHARS);
  });
  it('compacts old large observations to references and exact hashes while retaining the latest page', () => {
    const observations = Array.from({ length: 5 }, (_, i) => ({ tool: 'sources.read', argument: 'source.csv', result: { id: 'source.csv', content: `page ${i} ` + 'x'.repeat(3000) } }));
    const projected = boundedObservations(observations, () => ['source.csv']);
    expect(projected.at(-1)).toEqual(observations.at(-1));
    expect(projected[0]!.result).toMatchObject({ reference: 'observations/0', contentHash: digest(observations[0]!.result), evidenceRefs: ['source.csv'] });
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(OBSERVATION_PROMPT_CHARS);
    expect(observations[0]!.result.content).toHaveLength(3007);
  });

  it('keeps references and large-result previews stable when JSONB reorders result keys', () => {
    const original = [{ tool: 'sources.read', argument: 'source.csv', result: { id: 'source.csv', content: 'x'.repeat(8000) } }];
    const reordered = [{ ...original[0]!, result: { content: 'x'.repeat(8000), id: 'source.csv' } }];
    expect(boundedObservations(original, () => ['source.csv'])).toEqual(boundedObservations(reordered, () => ['source.csv']));
  });

  it('retains page metadata explicitly when compacting escaped source results', () => {
    const result = { id: 'source.csv', content: '"'.repeat(8000), sourceContentHash: 'a'.repeat(64),
      page: { mode: 'rows', offset: 0, returnedRows: 1, totalRows: 2, nextRead: { argument: 'source.csv', offset: 1, limit: 20 } } };
    const observations = Array.from({ length: 3 }, () => ({ tool: 'sources.read', argument: 'source.csv', result }));
    const projected = boundedObservations(observations, () => ['source.csv']);
    expect(projected.at(-1)!.result).toMatchObject({ schemaVersion: 'context-reference/1', previewTruncated: true, page: result.page, sourceContentHash: result.sourceContentHash });
    expect(JSON.stringify(projected.at(-1)!.result).length).toBeLessThanOrEqual(6000);
    expect(projected[0]!.result).toMatchObject({ page: result.page, contentHash: digest(result) });
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(OBSERVATION_PROMPT_CHARS);
  });

  it.each([
    { mode: 'rows', offset: 0, nextRead: { argument: 'source.csv', offset: 1, limit: 20 } },
    { mode: 'characters', characterOffset: 0, nextRead: { argument: 'source.txt', characterOffset: 4000 } },
  ])('preserves source continuations and the latest page during overall input compaction: $mode', page => {
    const observations = [
      { tool: 'sources.read', argument: page.nextRead.argument, result: { content: 'old'.repeat(1100), page, sourceContentHash: 'a'.repeat(64) } },
      { tool: 'sources.read', argument: page.nextRead.argument, result: { content: 'new'.repeat(1800), page, sourceContentHash: 'a'.repeat(64) } },
    ];
    const input = { fixed: 'x'.repeat(89_000), observations };
    const projected = boundedExecutorInput('system', input);
    expect(JSON.stringify(projected).length + 6).toBeLessThanOrEqual(EXECUTOR_PROMPT_CHARS);
    expect((projected.observations as typeof observations)[0]).toMatchObject({ tool: 'sources.read', argument: page.nextRead.argument,
      result: { schemaVersion: 'context-reference/1', page, sourceContentHash: 'a'.repeat(64), contentHash: digest(observations[0]!.result) } });
    expect((projected.observations as typeof observations).at(-1)).toEqual(observations.at(-1));
    expect(input.observations[0]!.result.content).toHaveLength(3300);
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

  it('keeps every web search citable after older results are compacted', () => {
    // A search observation as the engine stores it: the tool's structured output plus its receipt.
    const search = (n: number) => ({ tool: 'web-search', argument: JSON.stringify({ input: `query ${n}` }), result: {
      output: { schemaVersion: 'toolkit.web-search.v1', query: `query ${n}`, depth: 'basic', usage: { credits: 1 },
        results: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, title: `Title ${n}-${i}`, url: `https://news.example/${n}/${i}`,
          snippet: `Snippet ${n}-${i} ` + 'x'.repeat(600), publishedAt: '2026-11-25' })) },
      outputRefs: [`toolkit-receipt:p${n}`], receiptId: `receipt_${n}` } });
    const observations = Array.from({ length: 5 }, (_, n) => search(n));
    const projected = boundedObservations(observations, () => []);
    expect(projected).toHaveLength(5);
    expect(JSON.stringify(projected).length).toBeLessThanOrEqual(OBSERVATION_PROMPT_CHARS);
    for (const [n, observation] of projected.entries()) {
      const result = observation.result as any;
      expect(result.schemaVersion).toBe('context-reference/1');
      expect(result.receiptId).toBe(`receipt_${n}`);
      expect(result.webResults.query).toBe(`query ${n}`);
      expect(result.webResults.totalResults).toBe(10);
      expect(result.webResults.results).toHaveLength(8);
      expect(result.webResults.results[0]).toEqual({ rank: 1, title: `Title ${n}-0`, url: `https://news.example/${n}/0`, snippet: (`Snippet ${n}-0 ` + 'x'.repeat(600)).slice(0, 300), publishedAt: '2026-11-25' });
    }
    // The executor-wide projection keeps the digests too when the prompt is over budget, here
    // because of a large dependency that it can shrink instead.
    const input = { fixed: 'x'.repeat(60_000), observations: projected, dependencies: [{ id: 'artifact_1', taskId: 'scan', content: 'y'.repeat(40_000), evidenceRefs: [] }] };
    expect(JSON.stringify(input).length).toBeGreaterThan(EXECUTOR_PROMPT_CHARS);
    const overall = boundedExecutorInput('system', input);
    expect(JSON.stringify(overall).length + 6).toBeLessThanOrEqual(EXECUTOR_PROMPT_CHARS);
    expect((overall.dependencies as any[])[0].schemaVersion).toBe('context-reference/1');
    expect((overall.observations as any[]).every((observation, n) => observation.result.webResults?.results[0]?.url === `https://news.example/${n}/0`)).toBe(true);
  });

  it('keeps web digests while other evidence can shrink, and drops the oldest only as a last resort', () => {
    const search = (n: number) => ({ tool: 'web-search', argument: `query ${n}`, result: { output: { query: `query ${n}`,
      results: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, title: `T${n}-${i}`, url: `https://news.example/${n}/${i}`, snippet: 's'.repeat(600) })) }, receiptId: `receipt_${n}` } });
    // Raw (not yet projected) observations: the second pass must still recognize and keep their digests.
    const observations = Array.from({ length: 5 }, (_, n) => search(n));
    const kept = boundedExecutorInput('system', { fixed: 'x'.repeat(70_000), observations }).observations as any[];
    expect(kept.some(observation => observation.result.schemaVersion === 'context-reference/1')).toBe(true);
    // Each search is either untouched or compacted to its digest; none is a bare hash.
    expect(kept.every((observation, n) => (observation.result.webResults ?? observation.result.output)?.results[0]?.url === `https://news.example/${n}/0`)).toBe(true);
    // Nothing else left to shrink: the oldest digests go first, the call still fits, and the newest stays citable.
    const tight = boundedExecutorInput('system', { fixed: 'x'.repeat(88_000), observations: boundedObservations(observations, () => []) });
    expect(JSON.stringify(tight).length + 6).toBeLessThanOrEqual(EXECUTOR_PROMPT_CHARS);
    const result = (tight.observations as any[]).map(observation => observation.result);
    expect(result[0]).toMatchObject({ schemaVersion: 'context-reference/1', receiptId: 'receipt_0' });
    expect(result[0].webResults).toBeUndefined();
    expect(result.at(-1).webResults.results[0].url).toBe('https://news.example/4/0');
  });

  it('digests a fetched page to its link, title and a bounded excerpt', () => {
    const page = { schemaVersion: 'toolkit.web-fetch.v1', url: 'https://a.example/p', finalUrl: 'https://a.example/p', title: 'Pricing', text: 't'.repeat(5000), markdown: 'm'.repeat(6000), truncated: false };
    expect(webEvidenceDigest({ output: page, receiptId: 'r' })).toEqual({ webPage: { url: page.url, finalUrl: page.finalUrl, title: 'Pricing', excerpt: 't'.repeat(2000), excerptTruncated: true } });
    expect(webEvidenceDigest({ output: { text: 'no link' } })).toBeUndefined();
    expect(webEvidenceDigest({ content: 'source page' })).toBeUndefined();
  });

  it('gives the newest large search its digest without a raw preview, and leaves source reads to their own metadata', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, title: `T${i}`, url: `https://news.example/${i}`, snippet: 's'.repeat(600) }));
    const latest = boundedObservations([{ tool: 'web-search', argument: 'q', result: { output: { query: 'q', results }, receiptId: 'r' } }], () => []).at(-1)!.result as any;
    expect(latest.webResults.results[0].url).toBe('https://news.example/0');
    expect(latest.preview).toBeUndefined();
    // An uploaded JSON shaped like a search export is still a source read: it keeps its page and continuation.
    const page = { mode: 'characters', characterOffset: 0, nextRead: { argument: 'source.json', characterOffset: 4000 } };
    const read = { tool: 'sources.jsonRead', argument: 'source.json', result: { id: 'source.json', sourceContentHash: 'a'.repeat(64), page, results, truncated: true } };
    const projected = boundedObservations([read, { tool: 'sources.read', argument: 'other', result: { content: 'x' } }], () => ['source.json'])[0]!.result as any;
    expect(projected).toMatchObject({ id: 'source.json', page, sourceContentHash: 'a'.repeat(64) });
    expect(projected.webResults).toBeUndefined();
    // An observation stored without a tool name is still projected, not a crash.
    const untagged = [{ argument: 'x', result: { content: 'y'.repeat(3000) } }, { tool: 'sources.read', argument: 'z', result: { content: 'z' } }] as any;
    expect(() => boundedObservations(untagged, () => [])).not.toThrow();
    expect(() => boundedExecutorInput('system', { fixed: 'x'.repeat(94_000), observations: untagged })).not.toThrow();
  });

  it('rejects an oversized fixed core before invoking a provider', () => {
    expect(() => boundedExecutorInput('s', { goal: 'x'.repeat(EXECUTOR_PROMPT_CHARS) })).toThrow('Executor context exceeds');
  });

  it.each([{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { characterOffset: -1 }])('rejects invalid source pagination %j', page => {
    expect(() => decisionSchema.parse({ type: 'tool', tool: 'sources.read', argument: 'source.csv', ...page })).toThrow();
  });
});
