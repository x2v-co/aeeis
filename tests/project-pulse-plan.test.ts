// Eval baseline 2026-11-18 (deepseek-v4.1-flash): a Project Pulse over a 60–200 row CSV was planned as 4–5 tasks, each
// task without dependents wrote a full pulse (1–3 minutes of output each), and three CSV cases timed out. The planner is
// told a pulse is one deliverable written by one task.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };
const csv = 'id,task,status,owner,deadline\n1,Fix login,blocked,,2026-11-01\n2,Write docs,done,Ann,2026-11-05\n3,Ship v2,open,Bo,2026-12-01';

async function plannerSystem(builtinSkill?: string): Promise<string> {
  for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  const systems: string[] = [];
  const model: ModelAdapter = { pin, complete: async (request: ModelRequest) => {
    systems.push(request.system);
    return { value: { summary: 'Pulse', nodes: [{ id: 'pulse', title: 'Project Pulse', instruction: 'Query the CSV and write the pulse.', dependsOn: [] }] } };
  } };
  const engine = new AgentEngine(new InMemoryRunRepository(), { model });
  const run = await engine.create({ goal: '根据资料生成项目进展、阻塞、风险和下一步。', ...(builtinSkill ? { builtinSkill } : {}),
    materials: [{ title: 'tasks.csv', source: 'tasks.csv', content: csv }] } as never);
  await engine.advance(run.id);
  expect(systems).toHaveLength(1);
  return systems[0]!;
}

describe('planning a Project Pulse', () => {
  it('asks for one task that writes the whole pulse', async () => {
    const system = await plannerSystem('project-pulse/1');
    expect(system).toContain('A Project Pulse is one deliverable. Plan exactly one task');
    expect(system).toContain('make the second depend on the first so only it writes the pulse');
  });

  it('leaves other Runs without the one-task rule', async () => {
    expect(await plannerSystem()).not.toContain('A Project Pulse is one deliverable');
  });
});
