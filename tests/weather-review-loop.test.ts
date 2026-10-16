import { expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelRequest } from '../src/runtime/model.js';

it.each([false, true])('run_3a6cfd65: terminates an unsupported forecast without review revisions (historical review=%s)', async historical => {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Weather', nodes: [{ id: 'weather', title: 'Weather', instruction: 'Explain the capability limit', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'needs_revision', summary: 'Provide today’s weather', issues: ['Missing actual forecast data'] } };
    return { value: { type: 'finish', title: 'Weather capability limit', content: '无法核验北京今天的天气或未来三天预报；当前没有天气数据来源。请查询官方气象部门的预报。', evidenceRefs: [] } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const run = await engine.create({ goal: '北京今天天气和未来三天预报' });
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  await engine.advance(run.id);
  await engine.advance(run.id);
  if (historical) await repository.mutate(run.id, current => {
    current.review = { verdict: 'needs_revision', summary: 'Missing weather data', issues: ['Provide the forecast'] };
    current.events.push({ id: 'old-revision', type: 'review.revision_requested', at: run.createdAt, data: {} });
  });
  expect(await engine.advance(run.id)).toBe('failed');
  const finished = await repository.get(run.id);
  expect(finished.error).toContain('Capability limit (live_weather)');
  expect(finished.partial).toBe(true);
  expect(finished.artifacts[0]?.content).toContain('无法核验');
  expect(finished.artifacts[0]?.limitations?.join(' ')).toContain('no weather source');
  expect(finished.events.filter(event => event.type === 'run.capability_limited')).toHaveLength(1);
  expect(finished.events.filter(event => event.type === 'review.revision_requested')).toHaveLength(historical ? 1 : 0);
  const count = complete.mock.calls.length;
  for (let i = 0; i < 5; i++) expect(await engine.advance(run.id)).toBe('failed');
  expect(complete).toHaveBeenCalledTimes(count);
  expect(finished.calls.some(call => call.phase === 'reviewer')).toBe(false);
});

it('retains normal independent review when weather evidence is supplied', async () => {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Observed weather', nodes: [{ id: 'weather', title: 'Weather', instruction: 'Summarize observation', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Matches the supplied weather observation' } };
    return { value: { type: 'finish', title: 'Weather', content: 'Beijing: 20 C.', evidenceRefs: [(request.input as any).sourceCatalog[0].id] } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const run = await engine.create({ goal: 'Report Beijing weather', materials: [{ title: 'Weather observation', content: 'Beijing: 20 C.', source: 'upload' }] });
  await engine.advance(run.id);
  const plan = (await repository.get(run.id)).plans[0]!;
  await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 5; i++) await engine.advance(run.id);
  const finished = await repository.get(run.id);
  expect(finished.status, finished.error).toBe('succeeded');
  expect(finished.review?.verdict).toBe('accepted');
  expect(finished.events.some(event => event.type === 'run.capability_limited')).toBe(false);
});
