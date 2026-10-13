import { describe, expect, it } from 'vitest';
import { csvNumber, queryCsvSource, CsvQueryInputError } from '../src/runtime/csv-query.js';
import { materialContentHash, parseCsv } from '../src/runtime/materials.js';
import type { Source } from '../src/runtime/contracts.js';

const source = (content: string, overrides: Partial<Source> = {}): Source => ({
  id: 'source.csv', title: 'tasks.csv', source: 'upload', content, hash: 'stored-source-hash', ...overrides,
});
const csv = source('id,team,status,amount,owner\n1,A,open,"1,200.50",Alice\n2,A,closed,300,Bob\n3,B,open,invalid,Alice\n4,B,open,,\n5,A,closed,-100,Alice\n6,B,open, 50 , Carol ');

describe('CSV query parsing', () => {
  it('reuses the parser for BOM, CRLF, commas, escaped quotes, quoted newlines and blank records', () => {
    const content = '\uFEFFid,note,amount\r\n1,"one, two\r\nthree ""quotes""","1,234.50"\r\n\r\n2,"",-2\r\n';
    expect(parseCsv(content)).toEqual([['id', 'note', 'amount'], ['1', 'one, two\r\nthree "quotes"', '1,234.50'], ['2', '', '-2']]);
    const result = queryCsvSource(source(content), { select: ['note', 'amount'] });
    expect(result.rows).toEqual([['one, two\r\nthree "quotes"', '1,234.50'], ['', '-2']]);
    expect(result).toMatchObject({ matchedRowCount: 2, returnedRows: 2, truncated: false, sourceContentHash: materialContentHash(content), hash: 'stored-source-hash' });
  });

  it.each([
    ['1,234,567.89', 1234567.89], ['-1,200', -1200], ['+1 234.5', 1234.5], ['1\u00a0234', 1234],
    ['1\u202f234', 1234], ["1'234", 1234], ['.25', .25], ['-2.5e3', -2500], ['1,000e2', 100000], [' 0 ', 0],
  ])('parses finite numbers with thousands separators: %s', (value, expected) => {
    expect(csvNumber(String(value))).toBe(expected);
  });

  it.each(['', ' ', '1,2', '12,34.5', '0x10', 'Infinity', 'NaN', '1e999', '123abc', '$1,200', '1.234,56'])('rejects non-numeric cells: %s', value => {
    expect(csvNumber(value)).toBeUndefined();
  });

  it('reports malformed row widths and treats missing cells as empty', () => {
    const result = queryCsvSource(source('id,amount\n1\n2,3,extra\n3,'), { aggregates: [{ op: 'count', as: 'rows' }, { op: 'count', column: 'amount', as: 'filled' }] });
    expect(result).toMatchObject({ matchedRowCount: 3, malformedRowCount: 2, rows: [[3, 1]] });
  });
});

describe('CSV query filters and sorting', () => {
  it.each([
    [{ column: 'status', op: 'eq', value: 'closed' }, ['2', '5']],
    [{ column: 'status', op: 'ne', value: 'closed' }, ['1', '3', '4', '6']],
    [{ column: 'amount', op: 'eq', value: 1200.5 }, ['1']],
    [{ column: 'amount', op: 'ne', value: 1200.5 }, ['2', '3', '4', '5', '6']],
    [{ column: 'amount', op: 'gt', value: 50 }, ['1', '2']],
    [{ column: 'amount', op: 'gte', value: '1,200.50' }, ['1']],
    [{ column: 'amount', op: 'lt', value: 50 }, ['5']],
    [{ column: 'amount', op: 'lte', value: 50 }, ['5', '6']],
    [{ column: 'owner', op: 'contains', value: 'lic' }, ['1', '3', '5']],
    [{ column: 'owner', op: 'contains', value: 'alice' }, []],
    [{ column: 'id', op: 'in', value: [1, '6'] }, ['1', '6']],
    [{ column: 'owner', op: 'isEmpty' }, ['4']],
  ])('evaluates filter %j', (filter, ids) => {
    expect(queryCsvSource(csv, { select: ['id'], filters: [filter] }).rows).toEqual(ids.map(id => [id]));
  });

  it('combines filters with AND and sorts on unselected columns before limiting', () => {
    const result = queryCsvSource(csv, { select: ['id', 'owner'], filters: [{ column: 'team', op: 'eq', value: 'A' }, { column: 'amount', op: 'gte', value: 0 }], orderBy: [{ column: 'amount', direction: 'desc' }], limit: 1 });
    expect(result).toMatchObject({ columns: ['id', 'owner'], rows: [['1', 'Alice']], matchedRowCount: 2, totalResultRows: 2, returnedRows: 1, truncated: true });
  });

  it('sorts numerically, then text, then empty with stable ties and multiple sort columns', () => {
    const data = source('id,rank,label\na,10,b\nb,2,b\nc,2,a\nd,invalid,a\ne,,a\nf,2,a');
    expect(queryCsvSource(data, { select: ['id'], orderBy: [{ column: 'rank' }, { column: 'label' }] }).rows).toEqual([['c'], ['f'], ['b'], ['a'], ['d'], ['e']]);
    expect(queryCsvSource(data, { select: ['id'], orderBy: [{ column: 'rank', direction: 'desc' }] }).rows).toEqual([['e'], ['d'], ['a'], ['b'], ['c'], ['f']]);
  });
});

describe('CSV query grouping and aggregation', () => {
  it('aggregates every matched row, skips invalid/empty numbers and reports non-numeric counts once per column', () => {
    const result = queryCsvSource(csv, { groupBy: ['team'], aggregates: [
      { op: 'count', as: 'count' }, { op: 'count', column: 'owner', as: 'owners' },
      { op: 'sum', column: 'amount', as: 'sum' }, { op: 'avg', column: 'amount', as: 'avg' },
      { op: 'min', column: 'amount', as: 'min' }, { op: 'max', column: 'amount', as: 'max' },
      { op: 'countDistinct', column: 'owner', as: 'distinct' },
    ], orderBy: [{ column: 'sum', direction: 'desc' }], limit: 1 });
    expect(result.columns).toEqual(['team', 'count', 'owners', 'sum', 'avg', 'min', 'max', 'distinct']);
    expect(result.rows).toEqual([['A', 3, 3, 1400.5, 1400.5 / 3, -100, 1200.5, 2]]);
    expect(result).toMatchObject({ matchedRowCount: 6, totalResultRows: 2, nonNumericCounts: { amount: 1 }, truncated: true });
    const all = queryCsvSource(csv, { aggregates: [{ op: 'sum', column: 'amount', as: 'total' }] });
    expect(all.rows).toEqual([[1450.5]]);
  });

  it('filters before grouping on multiple columns and selects aggregate aliases', () => {
    const result = queryCsvSource(csv, { filters: [{ column: 'status', op: 'eq', value: 'open' }], groupBy: ['team', 'status'], aggregates: [{ op: 'countDistinct', column: 'owner', as: 'owners' }], select: ['owners', 'team'], orderBy: [{ column: 'team', direction: 'desc' }] });
    expect(result).toMatchObject({ columns: ['owners', 'team'], rows: [[2, 'B'], [1, 'A']], matchedRowCount: 4, totalResultRows: 2 });
  });

  it('supports groupBy without aggregates and collision-free composite keys', () => {
    const data = source('first,second\n"a,b",c\na,"b,c"\n"a,b",c');
    expect(queryCsvSource(data, { groupBy: ['first', 'second'] }).rows).toEqual([['a,b', 'c'], ['a', 'b,c']]);
  });

  it('returns zero counts and null numeric aggregates for no matches and no valid numbers', () => {
    const aggregates = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'].map(op => ({ op, column: 'amount', as: op }));
    expect(queryCsvSource(csv, { filters: [{ column: 'id', op: 'eq', value: 'missing' }], aggregates })).toMatchObject({ matchedRowCount: 0, rows: [[0, 0, null, null, null, null]], nonNumericCounts: { amount: 0 }, truncated: false });
    expect(queryCsvSource(csv, { filters: [{ column: 'id', op: 'in', value: ['3', '4'] }], aggregates })).toMatchObject({ rows: [[1, 1, null, null, null, null]], nonNumericCounts: { amount: 1 } });
    expect(queryCsvSource(source('amount'), { groupBy: ['amount'], aggregates: [{ op: 'count', as: 'rows' }] }).rows).toEqual([]);
  });

  it('handles prototype-like column and alias names as data', () => {
    const result = queryCsvSource(source('__proto__,constructor\nx,bad\nx,2'), { groupBy: ['__proto__'], aggregates: [{ op: 'sum', column: 'constructor', as: 'toString' }] });
    expect(result.rows).toEqual([['x', 2]]);
    expect(result.nonNumericCounts).toEqual({ constructor: 1 });
  });

  it('rejects arithmetic overflow instead of serializing it as null', () => {
    expect(() => queryCsvSource(source('value\n1e308\n1e308'), { aggregates: [{ op: 'sum', column: 'value', as: 'total' }] })).toThrow('overflowed');
  });
});

describe('CSV query result budget', () => {
  it('defaults to 50 rows, accepts 200, and counts matches beyond the limit', () => {
    const data = source('id\n' + Array.from({ length: 250 }, (_, i) => i).join('\n'));
    expect(queryCsvSource(data)).toMatchObject({ returnedRows: 50, matchedRowCount: 250, totalResultRows: 250, truncated: true, limit: 50 });
    expect(queryCsvSource(data, { limit: 200 })).toMatchObject({ returnedRows: 200, matchedRowCount: 250, truncated: true });
  });

  it('bounds the complete serialized result including escaping, query and source metadata', () => {
    const value = '"\n\\🙂'.repeat(40);
    const encoded = '"' + value.replaceAll('"', '""') + '"';
    const data = source('id,note\n' + Array.from({ length: 200 }, (_, i) => `${i},${encoded}`).join('\n'));
    const result = queryCsvSource(data, { limit: 200 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
    expect(result).toMatchObject({ matchedRowCount: 200, totalResultRows: 200, truncated: true, sourceContentHash: materialContentHash(data.content) });
    expect(result.returnedRows).toBeGreaterThan(0);
    expect(result.returnedRows).toBeLessThan(200);
    expect(result.rows.every(row => row[1] === value)).toBe(true);
  });

  it('withholds an oversized cell without shortening it or losing the matched count', () => {
    const result = queryCsvSource(source('note\n' + 'x'.repeat(10000)));
    expect(result).toMatchObject({ rows: [], matchedRowCount: 1, totalResultRows: 1, returnedRows: 0, truncated: true });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
  });

  it('bounds grouped output and computes statistics before output truncation', () => {
    const data = source('team,value\n' + Array.from({ length: 200 }, (_, i) => `${'x'.repeat(100)}${i},bad`).join('\n'));
    const result = queryCsvSource(data, { groupBy: ['team'], aggregates: [{ op: 'sum', column: 'value', as: 'total' }], limit: 200 });
    expect(result).toMatchObject({ matchedRowCount: 200, totalResultRows: 200, nonNumericCounts: { value: 200 }, truncated: true });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);
  });

  it('rejects metadata that cannot fit even with zero result rows', () => {
    expect(() => queryCsvSource(source('id\n1', { id: 'x'.repeat(6000) }))).toThrow('metadata exceeds');
    const names = Array.from({ length: 100 }, (_, i) => 'x'.repeat(100) + i);
    expect(() => queryCsvSource(source(names.join(',')))).toThrow('select fewer');
  });
});

describe('strict CSV query validation', () => {
  it.each([
    [null, 'Invalid CSV query arguments'], [[], 'Invalid CSV query arguments'], [{ extra: true }, 'Unrecognized key'],
    [{ limit: 0 }, 'limit'], [{ limit: 201 }, 'limit'], [{ limit: 1.5 }, 'limit'], [{ limit: '50' }, 'limit'],
    
    [{ select: ['id', 'id'] }, 'duplicate'], [{ select: ['missing'] }, 'select: unknown column'],
    [{ groupBy: ['missing'] }, 'groupBy: unknown column'], [{ groupBy: ['team', 'team'] }, 'duplicate'],
    [{ filters: [{ column: 'missing', op: 'eq', value: 1 }] }, 'filters: unknown column'],
    [{ filters: [{ column: 'amount', op: 'gt', value: 'text' }] }, 'requires a finite numeric value'],
    [{ filters: [{ column: 'id', op: 'eq' }] }, 'value'],
    [{ filters: [{ column: 'id', op: 'in', value: [] }] }, 'value'],
    [{ filters: [{ column: 'id', op: 'isEmpty', value: true }] }, 'Unrecognized key'],
    [{ filters: [{ column: 'id', op: 'regex', value: '.*' }] }, 'op'],
    [{ aggregates: [{ op: 'sum', as: 'total' }] }, 'column'],
    [{ aggregates: [{ op: 'count', column: 'missing', as: 'total' }] }, 'aggregates: unknown column'],
    [{ aggregates: [{ op: 'count' }] }, 'as'],
    [{ aggregates: [{ op: 'count', as: 'total' }, { op: 'count', as: 'total' }] }, 'duplicate'],
    [{ groupBy: ['team'], aggregates: [{ op: 'count', as: 'team' }] }, 'duplicate'],
    [{ groupBy: ['team'], select: ['owner'] }, 'select: unknown column'],
    [{ aggregates: [{ op: 'count', as: 'rows' }], orderBy: [{ column: 'amount' }] }, 'orderBy: unknown column'],
    [{ orderBy: [{ column: 'id', direction: 'sideways' }] }, 'direction'],
    [{ orderBy: [{ column: 'id', extra: 1 }] }, 'Unrecognized key'],
    [{ orderBy: [{ column: 'id' }, { column: 'id' }] }, 'duplicate'],
  ])('rejects invalid options %j with a clear error', (options, message) => {
    expect(() => queryCsvSource(csv, options)).toThrow(String(message));
  });

  it('rejects non-CSV sources, empty headers, blank names and duplicate header names', () => {
    expect(() => queryCsvSource(source('notes', { title: 'notes.txt' }))).toThrow('requires a CSV source');
    for (const content of ['', '\uFEFF', ',amount\n1,2', 'id, \n1,2']) expect(() => queryCsvSource(source(content))).toThrow('non-empty header');
    expect(() => queryCsvSource(source('id,id\n1,2'))).toThrow('header contains duplicate');
  });
});

describe('csvQuery ISO date comparisons', () => {
  it('compares ISO dates chronologically and skips non-date cells', () => {
    const result = queryCsvSource(source('id,due\n1,2026-10-01\n2,2026-11-15\n3,\n4,tbd\n5,2026-10-13T08:00:00Z'), { filters: [{ column: 'due', op: 'lt', value: '2026-10-14' }], select: ['id'] });
    expect(result.rows.map(row => row[0] ?? (row as unknown as Record<string, unknown>).id)).toEqual(['1', '5']);
  });
  it('throws a recoverable input error for non-numeric, non-date operands', () => {
    expect(() => queryCsvSource(source('id,due\n1,2026-10-01'), { filters: [{ column: 'due', op: 'lt', value: 'next week' }] })).toThrow(CsvQueryInputError);
  });
});
