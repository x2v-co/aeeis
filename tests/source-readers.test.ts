import { describe, expect, it } from 'vitest';
import { decisionSchema } from '../src/runtime/contracts.js';
import type { Source } from '../src/runtime/contracts.js';
import { materialContentHash, presentedMaterialExcerpts } from '../src/runtime/materials.js';
import { jsonRead, jsonSummary, markdownOutline, markdownSection, pdfRead, sampleSource, readStructuredSource } from '../src/runtime/source-readers.js';
import { structuredSourceTools } from '../src/runtime/source-tools.js';

const source = (title: string, content: string, extra: Partial<Source> = {}): Source => ({ id: 'source-fixture', title, content, source: 'upload', hash: 'stored-hash', ...extra });
const numbered = Array.from({ length: 100 }, (_, i) => `${i}: line "with quotes" 🙂`);

describe('hybrid source sampling', () => {
  it('samples head, evenly spaced interior records and tail with exact counts and indices', () => {
    const result = sampleSource(source('notes.txt', numbered.join('\r\n') + '\r\n'));
    expect(result).toMatchObject({ rowCount: 100, returnedRows: 7, omittedRows: 93, sampled: true, truncated: true });
    expect(result.samples.map(sample => sample.rowIndex)).toEqual([0, 1, 26, 50, 74, 98, 99]);
    expect(result.samples.map(sample => sample.region)).toEqual(['head', 'head', 'middle', 'middle', 'middle', 'tail', 'tail']);
    expect(result.samples.map(sample => sample.content)).toEqual([0, 1, 26, 50, 74, 98, 99].map(i => numbered[i]));
  });

  it('counts CSV logical records, keeps BOM/CRLF/escaped quotes and excludes the header', () => {
    const content = '\uFEFFid,note\r\n' + Array.from({ length: 100 }, (_, i) => `${i},"first\r\nsecond ""quote"""`).join('\r\n') + '\r\n\r\n';
    const result = sampleSource(source('notes.csv', content));
    expect(result).toMatchObject({ mode: 'rows', rowCount: 100, header: 'id,note', headerTruncated: false });
    expect(result.samples.at(-1)).toMatchObject({ rowIndex: 99, content: '99,"first\r\nsecond ""quote"""', truncated: false });
    expect(result.sourceContentHash).toBe(materialContentHash(content));
  });

  it('does not duplicate short sources and distinguishes exhaustive from sampled output', () => {
    const result = sampleSource(source('notes.txt', 'one\n\ntwo\n'));
    expect(result).toMatchObject({ rowCount: 3, returnedRows: 3, omittedRows: 0, sampled: false, truncated: false });
    expect(result.samples.map(sample => sample.content)).toEqual(['one', '', 'two']);
    expect(sampleSource(source('empty.txt', ''))).toMatchObject({ rowCount: 0, samples: [], sampled: false });
    expect(sampleSource(source('empty.csv', 'id\n'))).toMatchObject({ rowCount: 0, header: 'id', samples: [] });
  });

  it('preserves every sample region under escaping and oversized record/header bounds', () => {
    const content = '"\\🙂'.repeat(10000);
    for (const title of ['notes.txt', 'notes.csv']) {
      const data = source(title, ['header'.repeat(1000), ...Array.from({ length: 100 }, () => content.replaceAll('"', '""'))].join('\n'));
      const result = sampleSource(data, { maxChars: 3000 });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(3000);
      expect(result.samples).toHaveLength(7);
      expect(result.samples.every(sample => sample.truncated)).toBe(true);
      expect(result.samples.every(sample => !/[\uD800-\uDBFF]$/.test(sample.content))).toBe(true);
      expect(result.sampled).toBe(true);
    }
    expect(() => sampleSource(source('notes.txt', 'text', { id: 'x'.repeat(6000) }))).toThrow('metadata exceeds');
  });

  it('adds hybrid samples and counts to large text previews within a shared presentation budget', () => {
    const sources = [source('tiny.txt', 'hello'), source('notes.txt', numbered.join('\n').repeat(20))];
    const excerpts = presentedMaterialExcerpts(sources, [], 2500);
    expect(excerpts[0]).toMatchObject({ content: 'hello', truncated: false });
    expect(excerpts[1]).toMatchObject({ sampled: true, representation: 'hybrid-sample', truncated: true });
    const sample = JSON.parse(excerpts[1]!.content);
    expect(sample.samples.at(-1).region).toBe('tail');
    expect(excerpts.reduce((sum, excerpt) => sum + excerpt.content.length, 0)).toBeLessThanOrEqual(2500);
    expect(presentedMaterialExcerpts([sources[1]!], [], 40)[0]!.content).toContain('Sampled');
  });
});

describe('Markdown structured readers', () => {
  const markdown = source('guide.md', 'Introduction\r\n\r\n# Root\r\nBody\r\n\r\n## Child\r\nNested\r\n\r\n```md\r\n# Not a heading\r\n```\r\n\r\n### Deep\r\nDeeper\r\n\r\nSibling\r\n-------\r\nOther\r\n\r\n# Root\r\nSecond\r\n');
  it('builds a headings tree including setext headings and excludes code headings', () => {
    const result = markdownOutline(markdown);
    expect(result).toMatchObject({ totalHeadings: 5, returnedHeadings: 5, truncated: false });
    expect(result.outline.map(heading => heading.heading)).toEqual(['Root', 'Root']);
    expect(result.outline[0]!.children.map(heading => heading.heading)).toEqual(['Child', 'Sibling']);
    expect(result.outline[0]!.children[0]!.children[0]).toMatchObject({ heading: 'Deep', level: 3, parentId: 'heading-2' });
  });
  it('reads a heading section with children and stops before a peer or ancestor', () => {
    const result = markdownSection(markdown, { heading: 'Child' });
    expect(result.content).toMatch(/^## Child\n/);
    expect(result.content).toContain('### Deep\nDeeper');
    expect(result.content).not.toContain('Sibling\n');
    expect(result.contentHash).toBe(materialContentHash(result.content));
    expect(result.sourceContentHash).toBe(materialContentHash(markdown.content));
    expect(markdownSection(markdown, { heading: 'Root', occurrence: 2 }).content).toBe('# Root\nSecond\n');
    expect(markdownSection(markdown, { heading: 'heading-5' }).content).toBe('# Root\nSecond\n');
    expect(() => markdownSection(markdown, { heading: 'missing' })).toThrow('heading not found');
  });
  it('pages outlines with stable parent IDs and explicit continuation', () => {
    const first = markdownOutline(markdown, { limit: 2 });
    expect(first).toMatchObject({ returnedHeadings: 2, truncated: true });
    const next = markdownOutline(markdown, first.page.nextRead && { offset: first.page.nextRead.offset, limit: 2 });
    expect(next.outline[0]).toMatchObject({ heading: 'Deep', parentId: 'heading-2' });
    expect(next.outline[1]).toMatchObject({ heading: 'Sibling', parentId: 'heading-1' });
    const large = source('wide.md', Array.from({ length: 200 }, (_, i) => `# Heading ${i} ${'x'.repeat(60)}\ntext\n`).join(''));
    expect(JSON.stringify(markdownOutline(large)).length).toBeLessThanOrEqual(6000);
    expect(() => markdownOutline(source('huge.md', '# ' + 'x'.repeat(7000)))).toThrow('heading exceeds');
    expect(markdownOutline(source('none.md', 'No headings')).outline).toEqual([]);
  });
  it('reassembles bounded sections after escaping and Unicode-safe continuations', () => {
    const content = '# Large\n' + '"\\🙂'.repeat(4000) + '\n## Nested\nend\n';
    const data = source('large.md', content);
    let received = '', query: any = { heading: 'Large', maxChars: 1800 };
    for (;;) {
      const result = markdownSection(data, query);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1800);
      received += result.content;
      if (!result.page.nextRead) break;
      query = result.page.nextRead;
      delete query.argument;
    }
    expect(received).toBe(content);
  });
});

describe('JSON structured readers', () => {
  const data = source('data.json', '\uFEFF{"items":[{"a.b":{"value":42}},{"value":null}],"__proto__":{"ok":true},"text":"hello"}');
  it('reports top-level keys/types and array or scalar shape without exposing values', () => {
    const result = jsonSummary(data);
    expect(result).toMatchObject({ shape: { type: 'object', keyCount: 3 }, totalEntries: 3, returnedEntries: 3 });
    expect(result.entries).toEqual([{ key: 'items', type: 'array', length: 2 }, { key: '__proto__', type: 'object', keyCount: 1 }, { key: 'text', type: 'string', length: 5 }]);
    expect(jsonSummary(data, { path: '$.items' })).toMatchObject({ shape: { type: 'array', length: 2 }, entries: [{ key: '0', type: 'object', keyCount: 1 }, { key: '1', type: 'object', keyCount: 1 }] });
    expect(jsonSummary(source('data.json', 'null'))).toMatchObject({ shape: { type: 'null' }, entries: [] });
    expect(JSON.stringify(result)).not.toContain('hello');
  });
  it('reads dot keys, array indices, bracket keys and own prototype-like keys', () => {
    expect(jsonRead(data, { path: '$.items[0]["a.b"].value' })).toMatchObject({ value: 42, representation: 'json-value', truncated: false });
    expect(jsonRead(data, { path: '$.__proto__.ok' })).toMatchObject({ value: true });
    expect(jsonRead(data, { path: '$.items[1].value' })).toMatchObject({ value: null });
    expect(() => jsonRead(data, { path: '$.constructor' })).toThrow('path not found');
    expect(jsonRead(source('data.json', '{"quote\\\"key":false}'), { path: '$["quote\\\"key"]' })).toMatchObject({ value: false });
  });
  it.each(['$.items[*]', '$..value', '$.items[0:1]', '$.items[-1]', '$.items[99999999999999999999]', '$.items[01]', '$.items[process.exit()]', 'items', '$["bad\nkey"]'])('rejects unsupported path syntax: %s', path => {
    expect(() => jsonRead(data, { path })).toThrow(/JSON path/);
  });
  it('distinguishes invalid JSON from missing paths and rejects scalar/array property traversal', () => {
    expect(() => jsonRead(source('data.json', '{broken'))).toThrow('Invalid JSON source');
    for (const path of ['$.items[99]', '$.text.length', '$.items.length', '$.items[0][0]', '$.missing']) expect(() => jsonRead(data, { path })).toThrow('path not found');
  });
  it('bounds shape pagination without shortening keys and preserves late keys', () => {
    const content = JSON.stringify(Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['key-' + i + 'x'.repeat(100), i])));
    const data = source('wide.json', content);
    let query: any = { limit: 200 }, keys: string[] = [];
    for (;;) {
      const result = jsonSummary(data, query);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
      keys.push(...result.entries.map(entry => entry.key));
      if (!result.page.nextRead) break;
      const { argument: _argument, ...next } = result.page.nextRead; query = next;
    }
    expect(keys).toEqual(Object.keys(JSON.parse(content)));
    expect(() => jsonSummary(source('wide.json', JSON.stringify({ ['x'.repeat(7000)]: 1 })))).toThrow('key exceeds');
  });
  it('returns bounded JSON fragments that reconstruct the exact selected value', () => {
    const value = { text: '"\\🙂'.repeat(3000), count: 1 }, data = source('large.json', JSON.stringify({ value }));
    let query: any = { path: '$.value', maxChars: 1800 }, received = '';
    for (;;) {
      const result = jsonRead(data, query);
      expect(result.representation).toBe('json-fragment');
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1800);
      expect('content' in result).toBe(true);
      if (!('content' in result)) throw new Error('Expected fragment');
      received += result.content;
      if (!result.page.nextRead) break;
      const { argument: _argument, ...next } = result.page.nextRead; query = next;
    }
    expect(JSON.parse(received)).toEqual(value);
    expect(() => jsonRead(data, { path: '$.value', characterOffset: 999999 })).toThrow('exceeds');
    expect(() => jsonRead(source('data.json', '"🙂"'), { characterOffset: 2 })).toThrow('surrogate pair');
  });
});

describe('source reader validation and unsupported PDF', () => {
  it('returns a clear bounded unsupported PDF message with a page range', () => {
    const result = pdfRead(source('report.pdf', '%PDF-1.7 bytes'), { startPage: 2, endPage: 4 });
    expect(result).toMatchObject({ supported: false, startPage: 2, endPage: 4 });
    expect(result.message).toContain('PDF text extraction is unsupported');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
    expect(() => pdfRead(source('report.pdf', 'pdf'), { startPage: 3, endPage: 2 })).toThrow('ascending');
    expect(pdfRead(source('report.pdf', 'pdf'), { endPage: 21 })).toMatchObject({ startPage: 1, endPage: 20, page: { nextRead: { startPage: 21, endPage: 21 } } });
    expect(pdfRead(source('report.pdf', 'pdf'), { startPage: 2, endPage: 12 }, 4)).toMatchObject({ startPage: 2, endPage: 5, page: { nextRead: { startPage: 6, endPage: 12 } } });
  });
  it.each(structuredSourceTools)('rejects extra fields and invalid size bounds for %s', tool => {
    for (const fields of [{ extra: true }, { maxChars: 6001 }, { maxChars: 0 }, { maxChars: 2.5 }]) expect(() => decisionSchema.parse({ type: 'tool', tool, argument: 'id', ...(tool === 'sources.markdownSection' ? { heading: 'Root' } : {}), ...fields })).toThrow();
    expect(() => readStructuredSource(tool, source('notes.txt', 'text'), { unexpected: true })).toThrow('Invalid source reader arguments');
  });
  it('rejects the wrong format and invalid options', () => {
    expect(() => sampleSource(source('data.json', '{}'))).toThrow('CSV or text');
    expect(() => markdownOutline(source('notes.txt', 'text'))).toThrow('requires a markdown');
    expect(() => jsonRead(source('notes.txt', 'text'))).toThrow('requires a json');
    expect(() => pdfRead(source('notes.txt', 'text'))).toThrow('requires a pdf');
    for (const options of [{ headRows: 0 }, { middleSamples: 0 }, { tailRows: 21 }]) expect(() => sampleSource(source('notes.txt', 'text'), options)).toThrow('Invalid source reader arguments');
  });
});
