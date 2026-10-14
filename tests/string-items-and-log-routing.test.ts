import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { decisionSchema, projectPulseArtifactSchema, websiteBuilderArtifactSchema } from '../src/runtime/contracts.js';
import { normalizeFinishOutput } from '../src/runtime/engine.js';

const empty = { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };

describe('string text-item coercion (run_66ff0195)', () => {
  it('wraps string unknowns/blockers/risks as {text,evidenceRefs} using finish refs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', evidenceRefs: ['source_a'],
      structured: { ...empty, unknowns: ['owner of row 7?', 'Q3 date', ' ', 'scope'], blockers: ['推断：x'], risks: ['r'] } }) as Record<string, any>;
    expect(out.structured.unknowns).toEqual([
      { text: 'owner of row 7?', evidenceRefs: ['source_a'] }, { text: 'Q3 date', evidenceRefs: ['source_a'] }, { text: 'scope', evidenceRefs: ['source_a'] }]);
    expect(projectPulseArtifactSchema.parse(out.structured).blockers[0]).toEqual({ text: '推断：x', evidenceRefs: ['source_a'] });
    expect(decisionSchema.parse(out)).toMatchObject({ type: 'finish' });
    expect(warn.mock.calls.map(call => String(call[0])).some(line => line.includes('"shape":"string-items"'))).toBe(true);
  });
  it('falls back to refs from other items when the finish has none; leaves objects alone', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const progress = [{ text: 'p', evidenceRefs: ['source_b'] }];
    const out = normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', evidenceRefs: [], structured: { ...empty, progress, unknowns: ['u'] } }) as Record<string, any>;
    expect(out.structured.progress).toEqual(progress);
    expect(out.structured.unknowns).toEqual([{ text: 'u', evidenceRefs: ['source_b'] }]);
  });
  it('handles website-builder blockers/unknowns', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', evidenceRefs: ['receipt_1'],
      structured: { schemaVersion: 'website-builder/1', changedFiles: [], validation: [], artifacts: [], blockers: ['b'], unknowns: ['u'] } }) as Record<string, any>;
    expect(websiteBuilderArtifactSchema.parse(out.structured).unknowns).toEqual([{ text: 'u', evidenceRefs: ['receipt_1'] }]);
  });
});

describe('protocol log routing', () => {
  it('the Temporal worker only proxies to the API over HTTP; engine/csvQuery protocol logs live in the api container', () => {
    const worker = readFileSync(new URL('../src/temporal/worker.ts', import.meta.url), 'utf8');
    const activity = readFileSync(new URL('../src/temporal/activity.ts', import.meta.url), 'utf8');
    for (const source of [worker, activity]) expect(source).not.toMatch(/runtime\/(engine|csv-query)/);
    expect(activity).toContain('/internal/runs/');
  });
  it('protocol logs are single-line JSON written via console (stdout/stderr → docker json-file)', async () => {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push(String(line)); });
    normalizeFinishOutput({ type: 'finish', title: 'T', content: 'C', evidenceRefs: ['s'], structured: { ...empty, unknowns: ['u'] } });
    warn.mockRestore();
    const parsed = lines.map(line => JSON.parse(line));
    expect(parsed.some(entry => entry.protocol === 'aeeis-finish-normalized/1')).toBe(true);
    expect(lines.every(line => !line.includes('\n'))).toBe(true);
  });
});
