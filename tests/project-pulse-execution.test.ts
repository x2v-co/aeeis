import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ProjectPulseArtifact } from '../src/runtime/contracts.js';
import { materialContentHash } from '../src/runtime/materials.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const plan = { summary: 'Pulse', nodes: [{ id: 'pulse', title: 'Project Pulse', instruction: 'Summarize project evidence', dependsOn: [] }] };
const pulse = (ref: string): ProjectPulseArtifact => ({ schemaVersion: 'project-pulse/1', progress: [{ text: 'Migration is blocked.', evidenceRefs: [ref] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] });
const finish = (ref: string) => ({ type: 'finish', title: 'Project Pulse', content: 'Migration is blocked.', evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse(ref) });

async function setup(output: (ref: string, input: Record<string, unknown>) => unknown, options: { maxModelCalls?: number } = {}, uploads?: Array<{ title: string; source: string; content: string }>) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-pulse-execution-'));
  const repository = new FileRunRepository(directory); await repository.init();
  cleanup.push(async () => { await repository.close(); await rm(directory, { recursive: true, force: true }); });
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: plan, usage: { inputTokens: 10, outputTokens: 5 } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Verified', issues: [] }, usage: { inputTokens: 10, outputTokens: 5 } };
    const input = request.input as Record<string, unknown> & { sourceCatalog: Array<{ id: string }>; observations: unknown[] };
    const ref = input.sourceCatalog[0]!.id;
    if (!uploads && !input.observations.length) return { value: { type: 'tool', tool: 'sources.read', argument: ref }, usage: { inputTokens: 10, outputTokens: 5 } };
    return { value: output(ref, input), usage: { inputTokens: 10, outputTokens: 5 } };
  });
  const model: ModelAdapter = { pin: { model: 'ark-shape-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete };
  const engine = new AgentEngine(repository, model);
  const app = buildApp({ repository, engine, dispatcher: { notify: async () => {}, close: async () => {} } }); cleanup.push(async () => { await app.close(); });
  // This is the payload produced by the workbench's runOptions(), including
  // each supported upload format. All are source text, never model instructions.
  const materials = uploads ?? [
    { title: '用户提供的项目资料', source: 'user-input', content: 'Migration is blocked.' },
    ...['txt', 'md', 'csv', 'json'].map(extension => ({ title: `brief.${extension}`, source: `browser-file:brief.${extension}`, content: extension === 'json' ? '{"status":"blocked"}' : 'Migration is blocked.' })),
  ];
  const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Project Pulse', builtinSkill: 'project-pulse/1', materials, ...options } });
  expect(response.statusCode).toBe(202);
  const run = await repository.get(response.json<{ id: string }>().id);
  expect(run.context.sources.map(source => ({ title: source.title, source: source.source, content: source.content }))).toEqual(materials);
  expect(await engine.advance(run.id)).toBe('needs_approval');
  const proposed = await repository.get(run.id);
  await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash });
  expect(await engine.advance(run.id)).toBe('running'); // read the source
  return { engine, repository, model, complete, run };
}

async function completeRun(engine: AgentEngine, repository: FileRunRepository, id: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const status = await engine.advance(id);
    if (status === 'succeeded' || status === 'failed') break;
  }
  return repository.get(id);
}

describe('Project Pulse finish output', () => {
  it('delivers the whole uploaded CSV to the executor and accepts without a source read', async () => {
    const rows = ['id,task,status,owner', ...Array.from({ length: 160 }, (_, i) => `${i},Migration task ${i},blocked,Owner ${i}`)];
    const csv = rows.join('\n');
    expect(csv.length).toBeGreaterThan(1200);
    const { engine, repository, run } = await setup((ref, input) => {
      const presented = (input.presentedSources as Array<Record<string, unknown>>)[0]!;
      expect(presented).toMatchObject({ id: ref, format: 'csv', truncated: false, totalChars: csv.length, totalRows: rows.length, presentedRows: rows.length });
      expect(presented.content).toContain(rows[0]);
      expect(presented.content).toContain(rows.at(-1));
      expect(presented.content).toContain(csv);
      return finish(ref);
    }, {}, [{ title: 'tasks.csv', source: 'browser-file:tasks.csv', content: csv }]);
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.review?.verdict).toBe('accepted');
    expect(completed.steps[0]?.observations).toHaveLength(0);
  });

  it('uses CSV-aware source search with a hash of the exact excerpt', async () => {
    const rows = ['id,task,status', ...Array.from({ length: 160 }, (_, i) => `${i},${i === 155 ? 'needle' : 'Migration task ' + i},blocked`)];
    const { engine, repository, run } = await setup((ref, input) => {
      const observations = input.observations as Array<{ result: Array<{ excerpt: string; contentHash: string; format: string; truncated: boolean }> }>;
      if (!observations.length) return { type: 'tool', tool: 'sources.search', argument: 'needle' };
      const result = observations[0]!.result[0]!;
      expect(result).toMatchObject({ format: 'csv', truncated: true });
      const text = result.excerpt.split('\n').slice(1, -1).join('\n');
      expect(text.startsWith(rows[0]! + '\n')).toBe(true);
      expect(text).toContain(rows[156]);
      expect(result.contentHash).toBe(materialContentHash(text));
      expect(result.excerpt).toContain(`hash="${result.contentHash}"`);
      return finish(ref);
    }, {}, [{ title: 'tasks.csv', source: 'browser-file:tasks.csv', content: rows.join('\n') }]);
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
  });

  it.each(['structured-string', 'structuredData', 'structured_data', 'data', 'answer', 'whole-json-string'] as const)('preserves and validates %s from workbench materials', async shape => {
    const { engine, repository, complete, run } = await setup(ref => {
      const value = finish(ref);
      if (shape === 'whole-json-string') return JSON.stringify(value);
      if (shape === 'structured-string') return { ...value, structured: JSON.stringify(value.structured) };
      if (shape === 'answer') { const { content, ...fields } = value; return { ...fields, answer: content }; }
      const { structured, ...fields } = value;
      return { ...fields, [shape]: JSON.stringify(structured) };
    });
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.artifacts[0]?.structured).toEqual(pulse(run.context.sources[0]!.id));
    expect(completed.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(0);
    const request = complete.mock.calls.find(([request]) => request.system.includes('Execute the current task'))![0];
    expect(request.system).toContain('top-level finish.structured');
    expect(request.input).toMatchObject({ expectedArtifactType: 'project-pulse/1' });
  });

  it('repairs missing structured output once across restart and accounts for both model calls', async () => {
    const { engine, repository, model, complete, run } = await setup((ref, input) => input.finishRepair ? finish(ref) : { ...finish(ref), structured: undefined });
    expect(await engine.advance(run.id)).toBe('running');
    const repairing = await repository.get(run.id);
    expect(repairing.artifacts).toHaveLength(0);
    expect(repairing.steps[0]?.finishRepair?.reason).toContain('finish.structured');
    const restarted = new AgentEngine(repository, model);
    const completed = await completeRun(restarted, repository, run.id);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.calls.filter(call => call.phase === 'executor')).toHaveLength(3);
    expect(completed.modelUsage?.tokens).toBe(75);
    const repair = complete.mock.calls.find(([request]) => (request.input as Record<string, unknown>).finishRepair)![0];
    expect(repair.system).toContain('Return only a complete finish decision');
  });

  it.each(['missing', 'invalid-json', 'invalid-schema', 'wrong-contract'] as const)('fails actionably after one repair of %s, without an artifact', async shape => {
    const { engine, repository, run } = await setup(ref => ({ ...finish(ref), structured: shape === 'missing' ? undefined : shape === 'invalid-json' ? '{invalid' : shape === 'invalid-schema' ? { ...pulse(ref), progress: [{ text: 'Unsupported', evidenceRefs: [] }] } : { schemaVersion: 'website-builder/1' } }));
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('Model artifact repair failed');
    expect(completed.error).toContain('finish.structured');
    expect(completed.events.filter(event => event.type === 'artifact.repair_requested')).toHaveLength(1);
    expect(completed.artifacts).toHaveLength(0);
  });

  it('does not permit a tool decision during finish repair', async () => {
    const { engine, repository, run } = await setup((ref, input) => input.finishRepair ? { type: 'capability', toolId: 'shell', toolVersion: '1', input: {}, purpose: 'Escape repair' } : { ...finish(ref), structured: undefined });
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.error).toContain('repair must return a finish decision');
    expect(completed.pendingTool).toBeUndefined();
    expect(completed.toolReceipts).toHaveLength(0);
  });

  it('obeys the model call limit before issuing a repair request', async () => {
    const { engine, repository, complete, run } = await setup(ref => ({ ...finish(ref), structured: undefined }), { maxModelCalls: 3 });
    const completed = await completeRun(engine, repository, run.id);
    expect(completed.status).toBe('failed');
    expect(completed.error).toMatch(/budget|limit/i);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(completed.artifacts).toHaveLength(0);
  });
});
