import { expect, it, vi } from 'vitest';
import { AgentEngine, selfModelNote } from '../src/runtime/engine.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import type { ModelRequest } from '../src/runtime/model.js';

const pin = { model: 'deepseek-v4.1-flash', endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions', promptVersion: 'test' };

it('names the model and its provider, never the endpoint path', () => {
  const note = selfModelNote(pin);
  expect(note).toContain('"deepseek-v4.1-flash" from "opencode.ai"');
  expect(note).not.toContain('/inference/go');
  expect(selfModelNote({ ...pin, provider: 'ark' })).toContain('from "ark"');
  expect(selfModelNote({ model: 'm', endpoint: 'not a url' })).toBe(`\n\nYou run on the model "m". When the user asks which model you are or use, say this plainly; do not name or guess any other model.`);
});

it('tells the planner and every later model call which model the Run uses', async () => {
  const repository = new InMemoryRunRepository();
  const systems: string[] = [];
  const complete = vi.fn(async (request: ModelRequest) => {
    systems.push(request.system);
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Answer', nodes: [{ id: 'answer', title: 'Answer', instruction: 'Say which model you use', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Answered', issues: [] } };
    return { value: { type: 'final', output: { answer: 'I run on deepseek-v4.1-flash.' } } };
  });
  const engine = new AgentEngine(repository, { pin, complete });
  const created = await engine.create({ goal: '你现在用的是什么模型？' });
  await engine.advance(created.id);
  expect(systems.length).toBeGreaterThan(0);
  for (const system of systems) expect(system).toContain(selfModelNote(pin));
  expect((await repository.get(created.id)).selfModelNoteVersion).toBe(1);
});

it('leaves the prompts of a Run created before the note unchanged, so its requests rebuild exactly', async () => {
  const repository = new InMemoryRunRepository();
  const systems: string[] = [];
  const complete = vi.fn(async (request: ModelRequest) => {
    systems.push(request.system);
    return { value: { summary: 'Answer', nodes: [{ id: 'answer', title: 'Answer', instruction: 'Answer', dependsOn: [] }] } };
  });
  const engine = new AgentEngine(repository, { pin, complete });
  const created = await engine.create({ goal: 'Older Run' });
  await repository.mutate(created.id, run => { delete run.selfModelNoteVersion; });
  await engine.advance(created.id);
  expect(systems.length).toBeGreaterThan(0);
  for (const system of systems) expect(system).not.toContain('You run on the model');
});
