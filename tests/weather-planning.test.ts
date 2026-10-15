import { afterEach, expect, it, vi } from 'vitest';
import { AgentEngine } from '../src/runtime/engine.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => vi.restoreAllMocks());

it.each(['What is the Singapore weather forecast tomorrow?', '查询北京明天的天气和气温'])('declines unavailable weather visibly before approval: %s', async goal => {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) {
      expect(request.system).toContain('Never plan to retrieve or invent weather');
      return { value: { summary: 'Weather', nodes: [{ id: 'weather', title: 'Weather', instruction: 'Fetch weather', dependsOn: [] }] } };
    }
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Explicit unsupported weather notice', issues: [] } };
    // Even an attempted unavailable capability becomes a clear partial notice.
    return { value: { type: 'capability', toolId: 'weather-api', toolVersion: '1', input: {}, purpose: 'Fetch live forecast' } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete });
  const created = await engine.create({ goal });
  expect(await engine.advance(created.id)).toBe('needs_approval');
  const planned = await repository.get(created.id);
  expect(planned.plans[0]!.summary).toContain('Real-time weather and forecasts are not supported');
  expect(planned.plans[0]!.summary).toContain('climate norms');
  expect(planned.plans[0]!.summary).toContain('official meteorological forecast');
  expect(planned.events).toContainEqual(expect.objectContaining({ type: 'input.unsupported', data: expect.objectContaining({ phase: 'planning' }) }));
  expect(complete).toHaveBeenCalledTimes(1);
  await engine.command(created.id, 'approve', { planHash: planned.plans[0]!.hash, planVersion: 1 });
  for (let i = 0; i < 5; i++) if (await engine.advance(created.id) === 'succeeded') break;
  const run = await repository.get(created.id);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.artifacts[0]).toMatchObject({ partial: true });
  expect(run.artifacts[0]!.content).toContain('official meteorological forecast');
  expect(run.pendingTool).toBeUndefined();
  expect(run.question).toBeUndefined();
});
