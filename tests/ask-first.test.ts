// Eval ask-r79-input (live, deepseek-v4.1-flash, 2026-11-17): "缺什么就先问我" was planned as gap audit + drafted
// questions + placeholder template, and the Run succeeded (partial) without asking. When the goal asks to be asked,
// the planner and executor are told that missing required details mean a question, not a drafted deliverable.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import type { AgentRun } from '../src/runtime/contracts.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const isPlanner = (request: ModelRequest) => request.system.includes('Plan a real deliverable');
const isReviewer = (request: ModelRequest) => request.system.includes('Independently review');
const quote = '客户报价需求\n- 产品：A 型号或 B 型号（客户尚未确定）\n- 数量：待客户确认\n- 交付城市：未提供';

function recordingModel() {
  const seen: { phase: string; system: string }[] = [];
  const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
    const phase = isPlanner(request) ? 'planner' : isReviewer(request) ? 'reviewer' : 'executor';
    seen.push({ phase, system: request.system });
    if (phase === 'planner') return { value: { summary: 'Confirm the quote details', nodes: [{ id: 'confirm', title: '确认报价要素', instruction: '核对型号、数量和交付城市，缺失则询问用户。', dependsOn: [] }] } };
    if (phase === 'reviewer') return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    return { value: { type: 'question', question: '请确认型号（A 或 B）、数量和交付城市。', missing: ['model', 'quantity', 'delivery city'] } };
  } };
  return { model, seen };
}

async function drive(goal: string): Promise<{ run: AgentRun; seen: { phase: string; system: string }[] }> {
  for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  const repository = new InMemoryRunRepository();
  const { model, seen } = recordingModel();
  const engine = new AgentEngine(repository, { model });
  const created = await engine.create({ goal, maxModelCalls: 8, materials: [{ title: 'quote-request.txt', source: 'quote-request.txt', content: quote }] } as never);
  await engine.advance(created.id);
  const plan = (await repository.get(created.id)).plans[0]!;
  await engine.command(created.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  for (let i = 0; i < 20; i++) {
    const current = await repository.get(created.id);
    if (['succeeded', 'failed', 'cancelled', 'unknown', 'needs_input'].includes(current.status)) break;
    await engine.advance(created.id);
  }
  return { run: await repository.get(created.id), seen };
}

describe('a goal that asks to be asked first', () => {
  it('tells the planner and executor to ask about missing details, and the Run waits for the answer', async () => {
    const { run, seen } = await drive('根据资料给这位客户出一份最终报价单，必须写明确定的型号、数量和交付城市；缺什么就先问我。');
    const planner = seen.find(call => call.phase === 'planner')!, executor = seen.find(call => call.phase === 'executor')!;
    expect(planner.system).toContain('The user asked to be asked about missing details');
    expect(planner.system).toContain('Do not plan tasks that draft questions');
    expect(executor.system).toContain('return {"type":"question"} naming each one in missing');
    expect(run.status).toBe('needs_input');
    expect(run.question?.missing).toEqual(['model', 'quantity', 'delivery city']);
  });

  it('leaves other goals without the ask-first guidance', async () => {
    const { seen } = await drive('根据资料给这位客户出一份最终报价单，写明型号、数量和交付城市。');
    for (const call of seen) expect(call.system).not.toContain('The user asked to be asked about missing details');
  });
});
