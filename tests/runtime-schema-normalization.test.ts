import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { MAX_DEBUG_FIELD_BYTES } from '../src/runtime/run-debug.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plan = { summary: 'Report', nodes: [{ id: 'report', title: 'Report', instruction: 'Summarize supplied evidence', dependsOn: [] }] };
const fence = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```';

async function runModel(options: { planner?: unknown; plannerResponses?: unknown[]; plannerRawOutput?: string; materialContent?: string; restartBeforeRepair?: boolean; modelBudget?: { tokens: number }; executor?: (ref: string) => unknown; reviewer?: unknown; skill?: 'project-pulse/1' | 'website-builder/1' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-schema-'));
  const repository = new FileRunRepository(directory); await repository.init();
  cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const requests: ModelRequest[] = [];
  let plannerCalls = 0;
  const model: ModelAdapter = {
    pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' },
    complete: async request => {
      requests.push(request);
      const input = request.input as { sourceCatalog: Array<{ id: string }> };
      const value = request.system.includes('Plan a real deliverable') ? options.plannerResponses?.[plannerCalls++] ?? options.planner ?? plan
        : request.system.includes('Independently review') ? options.reviewer ?? { verdict: 'accepted', summary: 'Verified' }
        : options.executor?.(input.sourceCatalog[0]!.id) ?? { type: 'finish', title: 'Report', content: 'Evidence supports the report.', evidenceRefs: [input.sourceCatalog[0]!.id] };
      return { value, rawOutput: plannerCalls === 1 && options.plannerRawOutput !== undefined ? options.plannerRawOutput : typeof value === 'string' ? value : JSON.stringify(value), usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  let engine = new AgentEngine(repository, model);
  const run = await engine.create({ goal: 'Report', builtinSkill: options.skill, ...(options.modelBudget ? { modelBudget: options.modelBudget } : {}), materials: [{ title: 'Brief', source: 'upload', content: options.materialContent ?? 'Evidence supports the report.' }] });
  let proposed = await engine.advance(run.id);
  if (proposed === 'planning') {
    if (options.restartBeforeRepair) {
      await repository.close(); await repository.init();
      engine = new AgentEngine(repository, model);
    }
    proposed = await engine.advance(run.id);
  }
  if (proposed === 'needs_approval') {
    await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
    for (let i = 0; i < 8; i++) if (['succeeded', 'failed'].includes(await engine.advance(run.id))) break;
  }
  return { run: await repository.get(run.id), repository, requests };
}

describe('model schema normalization', () => {
  it('accepts a >2KB CSV plan with nodes.4.instruction missing without a model retry', async () => {
    const csv = 'owner,status\n' + 'Alice,completed\n'.repeat(160);
    expect(Buffer.byteLength(csv)).toBeGreaterThan(2048);
    const nodes = Array.from({ length: 5 }, (_, index) => ({ id: `task_${index}`, title: `Task ${index}`, dependsOn: [] }));
    const { run, requests } = await runModel({ materialContent: csv, planner: { summary: 'CSV report', nodes } });
    expect(run.status, run.error).toBe('succeeded');
    expect(run.plans[0]?.nodes[4]?.instruction).toBe('Task 4');
    expect(requests.filter(request => request.system.includes('Plan a real deliverable'))).toHaveLength(1);
  });

  it.each(['plan', 'result', 'output', 'data', 'response'])('extracts a %s wrapper surrounded by Markdown and prose', async wrapper => {
    const { run } = await runModel({ materialContent: '# Brief\n\nEvidence supports the report.',
      planner: 'Here is the plan:\n\n' + fence({ [wrapper]: plan }) + '\n\nPlease review it.' });
    expect(run.status, run.error).toBe('succeeded');
  });

  it('repairs missing summary/nodes once with raw output and Zod errors, including after restart', async () => {
    const raw = '# Proposed plan\n\n1. Read the supplied Markdown.\n2. Write a report.';
    const { run, requests } = await runModel({ materialContent: '# Markdown brief', plannerResponses: [raw, plan], restartBeforeRepair: true });
    expect(run.status, run.error).toBe('succeeded');
    const planner = requests.filter(request => request.system.includes('Plan a real deliverable'));
    expect(planner).toHaveLength(2);
    expect(planner[1]?.system).toContain('Return corrected JSON only');
    expect(planner[1]?.input).toMatchObject({ plannerRepair: { rawOutput: raw, validationError: expect.stringContaining('invalid_type') } });
    expect(planner[1]?.idempotencyKey).not.toBe(planner[0]?.idempotencyKey);
    expect(run.calls.filter(call => call.phase === 'planner')).toHaveLength(2);
    expect(run.calls[0]?.validationErrors?.length).toBeGreaterThan(0);
    expect(run.calls.filter(call => call.phase === 'planner').every(call => call.usage?.inputTokens === 10)).toBe(true);
    expect(run.plannerRepair).toBeUndefined();
  });

  it('enforces the billable model budget before a planner repair', async () => {
    const { run, requests } = await runModel({ plannerResponses: [{ summary: 'Missing nodes' }, plan], modelBudget: { tokens: 15 } });
    expect(run.status).toBe('failed');
    expect(run.error).toContain('token budget exhausted');
    expect(run.calls).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(run.calls[0]?.validationErrors?.[0]?.path).toBe('nodes');
    expect(run.calls[0]?.rawOutput).toBe('{"summary":"Missing nodes"}');
  });

  it.each(['object', 'prose', 'fenced'] as const)('redacts credential keys and copied values before repairing %s output after restart', async format => {
    const credentials = { session_id: 'opaque-session-value', token: 'opaque-token-value', secret: 'opaque-secret-value', password: 'opaque-password-value', api_key: 'opaque-key-value' };
    const values = [...Object.values(credentials), 'bearer-credential-value', 'sk-proj-abcdefgh12345678'];
    const invalid = { summary: `Keep this safe summary. ${Object.values(credentials).join(' ')} Bearer ${values.at(-2)} ${values.at(-1)}`, ...credentials };
    const raw = `Here is the response:\n${format === 'fenced' ? fence(invalid) : JSON.stringify(invalid)}\n${'😀'.repeat(6000)}`;
    const { run, requests } = await runModel({ plannerResponses: [format === 'object' ? invalid : raw, plan], restartBeforeRepair: true });
    expect(run.status, run.error).toBe('succeeded');
    const repair = (requests.filter(request => request.system.includes('Plan a real deliverable'))[1]!.input as { plannerRepair: { rawOutput: string; validationError: string } }).plannerRepair;
    const prompt = JSON.stringify(repair);
    for (const value of values) {
      expect(prompt).not.toContain(value);
      expect(run.calls[0]!.rawOutput).not.toContain(value);
    }
    expect(repair.rawOutput).toContain('Keep this safe summary.');
    expect(repair.rawOutput).toContain('[REDACTED]');
    expect(Buffer.byteLength(repair.rawOutput)).toBeLessThanOrEqual(MAX_DEBUG_FIELD_BYTES);
    expect(Buffer.byteLength(repair.validationError)).toBeLessThanOrEqual(MAX_DEBUG_FIELD_BYTES);
    if (format !== 'object') expect(repair.rawOutput).toContain('[truncated]');
  });

  it('uses credentials in the extracted object to scrub the separate raw text', async () => {
    const invalid = { summary: 'Safe summary', session_id: 'opaque-session-from-object', api_key: 'opaque-key-from-object' };
    const { run, requests } = await runModel({ plannerResponses: [invalid, plan], plannerRawOutput: `Safe summary with copied values ${invalid.session_id} ${invalid.api_key}`, restartBeforeRepair: true });
    expect(run.status, run.error).toBe('succeeded');
    const repair = (requests[1]!.input as { plannerRepair: { rawOutput: string } }).plannerRepair;
    expect(repair.rawOutput).toBe('Safe summary with copied values [REDACTED] [REDACTED]');
    expect(run.calls[0]!.rawOutput).toBe(repair.rawOutput);
  });

  it('collects escaped credentials beyond the truncation boundary before scrubbing copied summary values', async () => {
    const credentials = { session_id: 'session-"quoted"-value', api_key: 'key-with-\\slash-value' };
    const invalid = { summary: `Safe summary ${Object.values(credentials).join(' ')}`, padding: 'x'.repeat(MAX_DEBUG_FIELD_BYTES * 2), ...credentials };
    const raw = `Here is the response: ${JSON.stringify(invalid)}`;
    const { run, requests } = await runModel({ plannerResponses: [raw, plan], restartBeforeRepair: true });
    expect(run.status, run.error).toBe('succeeded');
    const repair = (requests[1]!.input as { plannerRepair: { rawOutput: string } }).plannerRepair;
    for (const value of Object.values(credentials)) {
      expect(repair.rawOutput).not.toContain(value);
      expect(repair.rawOutput).not.toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(repair.rawOutput).toContain('Safe summary [REDACTED] [REDACTED]');
    expect(repair.rawOutput).toContain('[truncated]');
    expect(Buffer.byteLength(repair.rawOutput)).toBeLessThanOrEqual(MAX_DEBUG_FIELD_BYTES);
  });

  it('redacts and caps existing durable repair data before sending it to the model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-existing-repair-'));
    const repository = new FileRunRepository(directory); await repository.init();
    cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
    const requests: ModelRequest[] = [];
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete: async request => { requests.push(request); return { value: plan }; } };
    const engine = new AgentEngine(repository, model);
    const run = await engine.create({ goal: 'Report' });
    await repository.mutate(run.id, current => {
      current.status = 'planning';
      current.plannerRepair = { rawOutput: 'Previous output: {"session_id":"historical-session","summary":"historical-session"}\n' + '😀'.repeat(6000), validationError: 'api_key=historical-key\n' + '😀'.repeat(6000) };
    });
    expect(await engine.advance(run.id)).toBe('needs_approval');
    const repair = (requests[0]!.input as { plannerRepair: { rawOutput: string; validationError: string } }).plannerRepair;
    expect(JSON.stringify(repair)).not.toContain('historical-session');
    expect(JSON.stringify(repair)).not.toContain('historical-key');
    for (const value of Object.values(repair)) expect(Buffer.byteLength(value)).toBeLessThanOrEqual(MAX_DEBUG_FIELD_BYTES);
  });
  it.each(['project-pulse/1', 'website-builder/1'] as const)('strips extras and unwraps fenced decisions and %s artifacts', async skill => {
    const { run } = await runModel({
      skill, planner: fence({ plan: JSON.stringify({ ...plan, finishDecision: {} }) }),
      executor: ref => fence({ decision: {
        type: 'finish', title: 'Report', content: 'Evidence supports the report.', evidenceRefs: [ref], extra: 'metadata',
        structured: fence({ artifact: skill === 'project-pulse/1' ? {
          schemaVersion: skill, progress: [{ text: 'Evidence supports the report.', evidenceRefs: [ref], confidence: 1 }],
          completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [], extra: true,
        } : { schemaVersion: skill, changedFiles: [], validation: [{ name: 'Evidence check', status: 'passed', evidenceRefs: [ref], extra: true }], artifacts: [], blockers: [], unknowns: [], extra: true } }),
      } }),
      reviewer: fence({ review: JSON.stringify({ verdict: 'APPROVED', summary: 'Verified', extra: 'metadata' }) }),
    });
    expect(run.status, run.error).toBe('succeeded');
    expect(run.artifacts[0]?.structured).not.toHaveProperty('extra');
    expect(run.review).toEqual({ verdict: 'accepted', summary: 'Verified', issues: [] });
  });

  it('normalizes revision verdict and a single issue without accepting the run', async () => {
    const { run } = await runModel({ reviewer: { decision: { verdict: 'Needs Revision', summary: 'Incomplete', issues: 'Missing requirement', extra: true } } });
    expect(run.status).toBe('failed');
    expect(run.review).toEqual({ verdict: 'needs_revision', summary: 'Incomplete', issues: ['Missing requirement'] });
  });

  it.each(['planner', 'reviewer'] as const)('durably stores raw output and validation errors for a %s schema failure', async phase => {
    const bad = phase === 'planner' ? fence({ plan: { summary: 'Invalid wrapped plan' } }) : fence({ review: { verdict: 'accepted or needs_revision', summary: 'Ambiguous review' } });
    const { run, repository } = await runModel(phase === 'planner' ? { planner: bad } : { reviewer: bad });
    expect(run.status).toBe('failed');
    await repository.close(); await repository.init();
    const call = (await repository.get(run.id)).calls.find(call => call.phase === phase)!;
    expect(call.rawOutput).toBe(bad);
    expect(call.validationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ path: phase === 'planner' ? 'nodes' : 'verdict' })]));
    if (phase === 'planner') {
      const calls = (await repository.get(run.id)).calls.filter(call => call.phase === 'planner');
      expect(calls).toHaveLength(2);
      expect(calls.every(call => call.rawOutput === bad && call.validationErrors?.some(issue => issue.path === 'nodes'))).toBe(true);
    }
  });

  it.each(['project-pulse/1', 'website-builder/1'] as const)('still requires all %s sections and evidence citations', async skill => {
    const { run } = await runModel({ skill, executor: ref => ({ type: 'finish', title: 'Report', content: 'Report', evidenceRefs: [ref], artifactType: skill,
      structured: { schemaVersion: skill, progress: [{ text: 'Claim', evidenceRefs: [] }], validation: [{ name: 'Check', status: 'passed', evidenceRefs: [] }], extra: true },
    }) });
    expect(run.status).toBe('failed');
    expect(run.artifacts).toHaveLength(0);
    expect(run.calls.filter(call => call.phase === 'executor').every(call => call.rawOutput && call.validationErrors?.length)).toBe(true);
  });
});
