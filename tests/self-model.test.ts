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

it.each(['dag', 'direct'] as const)('tells every model call of a %s Run, through execution and review, which model it uses', async planning => {
  const repository = new InMemoryRunRepository();
  const systems: string[] = [];
  const complete = vi.fn(async (request: ModelRequest) => {
    systems.push(request.system);
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Answer', nodes: [{ id: 'answer', title: 'Answer', instruction: 'Say which model you use', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Answered', issues: [] } };
    return { value: { type: 'finish', title: 'Model', content: 'I run on deepseek-v4.1-flash.', evidenceRefs: [] } };
  });
  const engine = new AgentEngine(repository, { pin, complete });
  const created = await engine.create({ goal: '你现在用的是什么模型？', planning, executionReview: 'auto' });
  let status = '';
  for (let i = 0; i < 8 && status !== 'succeeded'; i++) {
    status = await engine.advance(created.id);
    const run = await repository.get(created.id);
    if (status === 'needs_approval') await engine.command(created.id, 'approve', { planHash: run.plans.at(-1)!.hash, planVersion: run.plans.at(-1)!.version });
  }
  const run = await repository.get(created.id);
  expect(run.status, run.error).toBe('succeeded');
  expect(run.selfModelNoteVersion).toBe(1);
  // Execution and review both ran, and every call carried the note.
  expect(run.calls.map(call => call.phase)).toEqual(expect.arrayContaining(['executor', 'reviewer']));
  expect(systems.length).toBe(run.calls.length);
  for (const system of systems) expect(system).toContain(selfModelNote(pin));
});

it('tells the Bot its model in a discussion reply too', async () => {
  const systems: string[] = [];
  const engine = new AgentEngine(new InMemoryRunRepository(), { pin, complete: async (request: ModelRequest) => { systems.push(request.system); return { value: { reply: '我用的是 deepseek-v4.1-flash。' } }; } });
  await engine.completeForBot({ system: '只讨论，不执行', input: { message: '你用的什么模型' }, idempotencyKey: 'bot-reply:evt_1' }, { owner: 'owner', tenantId: 'local' });
  expect(systems).toEqual([`只讨论，不执行${selfModelNote(pin)}`]);
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
