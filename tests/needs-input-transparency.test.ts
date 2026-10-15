import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository, type RunRepository } from '../src/runtime/repository.js';
import { explainRun } from '../src/runtime/explanation.js';
import { inputQuestion, runInputRequest } from '../src/runtime/input-requests.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => vi.restoreAllMocks());

async function questionRun(repository: RunRepository, options: { source?: boolean; capability?: 'tool' | 'agent'; pulse?: boolean; finalOnly?: boolean; goal?: string; question?: string; missing?: string[] } = {}) {
  const requests: ModelRequest[] = [];
  const question = options.question ?? '请提供天气数据来源或允许访问天气数据的工具。';
  const engine = new AgentEngine(repository, {
    pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' },
    complete: async request => {
      requests.push(request);
      if (request.system.includes('Plan a real deliverable')) return { value: { summary: '天气统计', nodes: [{ id: 'weather', title: '天气统计', instruction: '统计本周天气', dependsOn: [] }] } };
      if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Explicitly limited to unavailable data', issues: [] } };
      return { value: { type: 'question', question, ...(options.missing ? { missing: options.missing } : {}) } };
    },
  });
  const created = await engine.create({ goal: options.goal ?? '统计北京本周天气', ...(options.pulse ? { builtinSkill: 'project-pulse/1' } : {}), ...(options.source ? { materials: [{ title: '天气说明', content: '本周天气资料尚未核验', source: 'upload' }] } : {}) });
  // Model the frozen catalogs without invoking an external provider.
  if (options.capability) await repository.mutate(created.id, current => {
    if (options.capability === 'tool') current.approvedTools = [{ id: 'weather', version: '1', capabilities: ['read'] }];
    else current.approvedAgents = [{ agentId: 'agent.weather', name: 'Weather', cardVersion: '1', cardDigest: 'a'.repeat(64), capabilities: [], inputSchemas: [], outputSchemas: [], privacy: { dataRetention: 'none', regions: ['local'] }, pricing: { unit: 'run' } }];
  });
  await engine.advance(created.id);
  await engine.command(created.id, 'approve', { planHash: (await repository.get(created.id)).plans[0]!.hash, planVersion: (await repository.get(created.id)).plans[0]!.version });
  if (options.finalOnly) await repository.mutate(created.id, current => { current.steps[0]!.limitReason = 'Node model iteration limit reached'; });
  await engine.advance(created.id);
  return { engine, id: created.id, requests, question };
}

describe('input requests and unavailable live data', () => {
  it.each([false, true])('run_b4cdd88e: finishes weather without sources/capabilities as explicitly partial (pulse=%s)', async pulse => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repository = new InMemoryRunRepository();
    const { engine, id, requests, question } = await questionRun(repository, { pulse });
    for (let attempt = 0; attempt < 4; attempt++) if (['succeeded', 'failed'].includes(await engine.advance(id))) break;
    const run = await repository.get(id);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.partial).toBe(true);
    expect(run.limitations).toEqual(expect.arrayContaining([`No data source or capability available: ${question}`, expect.stringContaining('Real-time weather and forecasts are not supported')]));
    expect(run.question).toBeUndefined();
    expect(run.artifacts[0]).toMatchObject({ partial: true, limitations: expect.arrayContaining([`No data source or capability available: ${question}`]) });
    expect(run.artifacts[0]?.content).toContain('数据来源');
    expect(run.artifacts[0]?.content).toContain('无法核验');
    expect(run.steps[0]?.limitReason).toContain('No data source or capability available');
    expect(run.events).toContainEqual(expect.objectContaining({ type: 'input.unavailable_partial', data: expect.objectContaining({ taskId: 'weather', question, missing: ['source', 'capability'] }) }));
    expect(run.events.some(event => event.type === 'input.requested')).toBe(false);
    expect(run.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
    const executor = requests.find(request => request.system.includes('Execute the current task'))!;
    expect(executor.input).toMatchObject({ capabilityCatalog: { tools: [], agents: [] }, presentedSources: [] });
    expect(requests.filter(request => request.system.includes('Execute the current task'))).toHaveLength(1);
    expect(requests.find(request => request.system.includes('Independently review'))?.input).toMatchObject({ partial: true });
    if (pulse) expect(run.artifacts[0]?.structured).toMatchObject({ schemaVersion: 'project-pulse/1', unknowns: [] });
    const app = buildApp({ repository, engine, dispatcher: { notify: async () => {}, close: async () => {} } });
    try {
      expect((await app.inject({ url: `/api/runs/${id}` })).json().limitations).toEqual(run.limitations);
      const cloned = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: run.goal, materials: run.context.sources.map(({ title, source, content }) => ({ title, source, content })), ...(run.builtinSkill ? { builtinSkill: run.builtinSkill } : {}) } });
      expect(cloned.statusCode, cloned.body).toBe(202);
      expect((await repository.get(cloned.json().id)).context.sources).toEqual([]);
    } finally { await app.close(); }
  });

  it.each(['fallback', 'repository'] as const)('lists a durable source-backed question in both summary APIs (%s paging)', async paging => {
    const directory = paging === 'repository' ? await mkdtemp(join(tmpdir(), 'aeeis-input-request-')) : undefined;
    const repository = directory ? new FileRunRepository(directory) : new InMemoryRunRepository();
    if (repository instanceof FileRunRepository) await repository.init();
    const app = buildApp({ repository });
    try {
      const { id, question } = await questionRun(repository, { source: true, question: '请允许使用天气数据接口。' });
      const run = await repository.get(id);
      expect(run.status).toBe('needs_input');
      expect(run.partial).not.toBe(true);
      expect(run.question).toEqual({ taskId: 'weather', text: question, kind: 'missing_capability', missing: ['capability'] });
      const expected = { taskId: 'weather', question, kind: 'missing_capability', missing: ['capability'] };
      const list = await app.inject({ url: '/api/runs' });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([expect.objectContaining({ id, status: 'needs_input', inputRequest: expected })]);
      const page = await app.inject({ url: '/api/runs/page?limit=10' });
      expect(page.statusCode).toBe(200);
      expect(page.json().items).toEqual([expect.objectContaining({ id, inputRequest: expected })]);
      expect((await app.inject({ url: `/api/runs/${id}` })).json()).toMatchObject({ id, inputRequest: expected });
      expect(explainRun(run).attention.blockers[0]?.detail).toBe(`${question} (kind=missing_capability; missing=capability)`);
      await repository.mutate(id, current => { current.status = 'running'; });
      expect((await app.inject({ url: '/api/runs' })).json()[0]).not.toHaveProperty('inputRequest');
      expect((await app.inject({ url: '/api/runs/page?limit=10' })).json().items[0]).not.toHaveProperty('inputRequest');
      expect((await app.inject({ url: `/api/runs/${id}` })).json()).not.toHaveProperty('inputRequest');
    } finally {
      await app.close();
      if (repository instanceof FileRunRepository) await repository.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['tool', 'agent'] as const)('keeps a live-data question pending when an external %s is available', async capability => {
    const repository = new InMemoryRunRepository();
    const { id, question } = await questionRun(repository, { capability });
    const run = await repository.get(id);
    expect(run.status, run.error).toBe('needs_input');
    expect(run.question).toEqual({ taskId: 'weather', text: question, kind: 'missing_source', missing: ['source'] });
    expect(run.events.some(event => event.type === 'input.unavailable_partial')).toBe(false);
  });

  it('converts an unavailable weather question on the final executor call to a partial finish', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repository = new InMemoryRunRepository();
    const { engine, id, requests } = await questionRun(repository, { finalOnly: true });
    expect((requests.find(request => request.system.includes('Execute the current task'))!.input as any).executionBudget.finalOnly).toBe(true);
    for (let attempt = 0; attempt < 4; attempt++) if (['succeeded', 'failed'].includes(await engine.advance(id))) break;
    expect(await repository.get(id)).toMatchObject({ status: 'succeeded', partial: true, artifacts: [{ limitations: expect.arrayContaining([expect.stringContaining('No data source or capability available')]) }] });
  });

  it('keeps ordinary intent clarifications pending with or without sources', async () => {
    const repository = new InMemoryRunRepository();
    const { id } = await questionRun(repository, { goal: '写一段介绍', question: '介绍的目标读者是谁？' });
    const run = await repository.get(id);
    expect(run.status).toBe('needs_input');
    expect(run.question).toMatchObject({ kind: 'clarification', missing: ['target audience'] });
    expect(inputQuestion(run, 'external', '确认范围', true)).toMatchObject({ kind: 'external_clarification', missing: ['source', 'capability'] });
  });

  it.each(['请提供型号、数量和交付城市。', 'Please provide the model, quantity and delivery city.'])('classifies concrete missing purchase facts and returns them in detail and list: %s', async question => {
    const repository = new InMemoryRunRepository();
    const { id } = await questionRun(repository, { source: true, goal: 'Prepare a purchase order', question });
    const app = buildApp({ repository });
    try {
      const expected = { taskId: 'weather', question, kind: 'clarification', missing: ['model', 'quantity', 'delivery city'] };
      expect((await app.inject({ url: '/api/runs' })).json()[0].inputRequest).toEqual(expected);
      expect((await app.inject({ url: `/api/runs/${id}` })).json().inputRequest).toEqual(expected);
      await repository.mutate(id, current => { current.question!.kind = 'missing_capability'; current.question!.missing = ['capability']; });
      expect((await app.inject({ url: '/api/runs' })).json()[0].inputRequest).toEqual(expected);
      expect((await app.inject({ url: `/api/runs/${id}` })).json().inputRequest).toEqual(expected);
    } finally { await app.close(); }
  });

  it('preserves model-specified concrete missing facts beyond the known field names', async () => {
    const repository = new InMemoryRunRepository();
    const { id } = await questionRun(repository, { source: true, question: 'Who should receive the invoice?', missing: ['invoice recipient'] });
    expect(runInputRequest(await repository.get(id))).toMatchObject({ kind: 'clarification', missing: ['invoice recipient'] });
  });

  it('derives metadata for questions persisted before the optional fields existed', async () => {
    const repository = new InMemoryRunRepository();
    const { id, question } = await questionRun(repository, { goal: '整理项目资料' });
    await repository.mutate(id, current => { current.question = { taskId: 'weather', text: question }; });
    expect(runInputRequest(await repository.get(id))).toEqual({ taskId: 'weather', question, kind: 'missing_source', missing: ['source', 'capability'] });
  });
});
