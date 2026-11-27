// Eval guide-r79-chifeng (2026-11-18/19, deepseek-v4.1-flash): a sourceless travel guide was planned as 5–7 section tasks
// plus a synthesis task and took ~650s. The planner is told one task writes the deliverable, the writer depends on every
// other task, and a Run without sources is one task.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const pin = { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' };

async function plannerSystem(request: Record<string, unknown>): Promise<string> {
  for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  const systems: string[] = [];
  const model: ModelAdapter = { pin, complete: async (call: ModelRequest) => {
    systems.push(call.system);
    return { value: { summary: 'Guide', nodes: [{ id: 'guide', title: 'Guide', instruction: 'Write the guide.', dependsOn: [] }] } };
  } };
  const engine = new AgentEngine(new InMemoryRunRepository(), { model });
  const run = await engine.create(request as never);
  await engine.advance(run.id);
  expect(systems).toHaveLength(1);
  return systems[0]!;
}
const guide = { goal: '给我一份8月去赤峰草原的3天两晚，自驾游的攻略。人员：一家人：老人1位，夫妻1对，3岁男孩' };
const notes = { goal: 'Summarize the notes', materials: [{ title: 'notes.md', source: 'notes.md', content: '# Notes\n- Login shipped' }] };

describe('planning who writes the deliverable', () => {
  it('asks a sourceless Run for one task that writes the whole deliverable', async () => {
    const system = await plannerSystem(guide);
    expect(system).toContain('One task writes the deliverable. Do not split it into tasks that each write a section');
    expect(system).toContain('the task that writes the deliverable must depend on all the others');
    expect(system).toContain('There are no sources to analyse. Unless the goal needs a tool, plan exactly one task');
  });

  it('keeps the one-writer rule but not the one-task rule when the Run has sources', async () => {
    const system = await plannerSystem(notes);
    expect(system).toContain('One task writes the deliverable.');
    expect(system).not.toContain('There are no sources to analyse');
  });

  it('leaves a Project Pulse with its own one-deliverable rule', async () => {
    const system = await plannerSystem({ ...notes, builtinSkill: 'project-pulse/1' });
    expect(system).toContain('A Project Pulse is one deliverable');
    expect(system).not.toContain('One task writes the deliverable.');
  });
});
