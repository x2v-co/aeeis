import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpModelAdapter } from '../src/runtime/model.js';
import { normalizeFinishOutput } from '../src/runtime/engine.js';
import { decisionSchema } from '../src/runtime/contracts.js';
import { queryCsvSource } from '../src/runtime/csv-query.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const adapter = (maxAttempts: number) => new HttpModelAdapter('https://example.com/v1', 'm', 'secret', undefined, 180_000, undefined, false, undefined, { stream: false, maxAttempts, retryBaseMs: 0, retryMaxMs: 1 });

describe('connect-phase retry', () => {
  it('gives UND_ERR_CONNECT_TIMEOUT one extra backoff retry after maxAttempts', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValueOnce(connectTimeout()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetch);
    await expect(adapter(1).complete({ system: 's', input: {}, idempotencyKey: 'k' })).resolves.toMatchObject({ value: { ok: true } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(errors.mock.calls[0]![0]))).toMatchObject({ retryDecision: 'connect-retry', connectPhase: true, willRetry: true });
  });
  it('stops after the single extra connect retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValue(connectTimeout());
    vi.stubGlobal('fetch', fetch);
    await expect(adapter(1).complete({ system: 's', input: {}, idempotencyKey: 'k' })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('finish wrapper normalization', () => {
  it('lifts artifact.structured and finish fields out of a wrapper', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const structured = { schemaVersion: 'project-pulse/1', summary: 'x' };
    const out = normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', evidenceRefs: ['s1'], artifact: { structured } }) as Record<string, unknown>;
    expect(out.structured).toEqual(structured);
    expect(out.artifactType).toBe('project-pulse/1');
    expect(out).not.toHaveProperty('artifact');
    expect(decisionSchema.parse(out)).toMatchObject({ type: 'finish', artifactType: 'project-pulse/1' });
  });
  it('treats a wrapper that is itself the artifact as structured, and lifts missing content', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeFinishOutput({ type: 'finish', title: 'T', artifact: { content: 'C', evidenceRefs: [] } }) as Record<string, unknown>;
    expect(out).toMatchObject({ content: 'C', evidenceRefs: [] });
    const pulse = normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', artifact: { schemaVersion: 'project-pulse/1' } }) as Record<string, unknown>;
    expect(pulse.structured).toEqual({ schemaVersion: 'project-pulse/1' });
  });
  it('leaves unrelated wrappers and non-finish decisions alone', () => {
    const tool = { type: 'tool', tool: 'sources.read', argument: 'a', artifact: { structured: {} } };
    expect(normalizeFinishOutput(tool)).toEqual(tool);
    expect(normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', result: { note: 1 } })).toHaveProperty('result');
  });
});

describe('csv date filter log', () => {
  it('records whether an ISO date filter took effect', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    queryCsvSource({ id: 's.csv', title: 't.csv', source: 'upload', hash: 'h', content: 'id,due\n1,2026-10-01\n2,2026-12-01\n3,tbd' }, { filters: [{ column: 'due', op: 'lt', value: '2026-11-01' }] });
    const log = JSON.parse(String(info.mock.calls.find(call => String(call[0]).includes('aeeis-csv-date-filter/1'))![0]));
    expect(log.filters[0]).toEqual({ column: 'due', op: 'lt', passed: 1, rejected: 1, nonDateCells: 1, effective: true });
  });
});
