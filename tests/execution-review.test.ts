import { describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';

const pin = { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' };
type Judgment = 'clear' | 'ask' | 'omit' | 'invalid';

class Fixture implements ModelAdapter {
  readonly pin = pin;
  readonly systems: string[] = [];
  constructor(private readonly judgment: Judgment) {}
  async complete(request: ModelRequest) {
    this.systems.push(request.system);
    if (request.system.includes('Plan a real deliverable')) {
      const plan: Record<string, unknown> = { summary: 'Read the note', nodes: [{ id: 'read_note', title: 'Read', instruction: 'Read the supplied note', dependsOn: [] }] };
      if (this.judgment === 'clear') plan.approvalRequest = { needed: false, reason: '只读已有资料' };
      if (this.judgment === 'ask') plan.approvalRequest = { needed: true, reason: '会调用外部工具' };
      if (this.judgment === 'invalid') plan.approvalRequest = { needed: 'maybe' };
      return { value: plan };
    }
    return { value: { type: 'question', question: '请补充一条说明' } };
  }
}

async function plan(mode: 'required' | 'auto' | 'yolo' | undefined, judgment: Judgment) {
  const repository = new InMemoryRunRepository();
  const model = new Fixture(judgment);
  const engine = new AgentEngine(repository, model);
  const created = await engine.create({ goal: '读这张纸条', ...(mode ? { executionReview: mode } : {}) });
  const status = await engine.advance(created.id);
  return { engine, model, status, saved: await repository.get(created.id) };
}

describe('execution review', () => {
  it('keeps a missing or required gate waiting for the owner and ignores a model clearance', async () => {
    for (const mode of [undefined, 'required'] as const) {
      const { model, status, saved } = await plan(mode, 'clear');
      expect(status).toBe('needs_approval');
      expect(saved.approval).toEqual({ planHash: saved.plans[0]!.hash, planVersion: 1, approved: false });
      expect(saved.plans[0]).not.toHaveProperty('approvalRequest');
      expect(model.systems[0]).not.toContain('approvalRequest');
      expect(saved.events.some(event => event.type === 'plan.auto_approved' || event.type === 'plan.approval_requested')).toBe(false);
    }
  });

  it('continues a clear automatic judgment and still stops when the model asks, omits, or garbles it', async () => {
    const clear = await plan('auto', 'clear');
    expect(clear.status).toBe('running');
    expect(clear.saved.executionReview).toBe('auto');
    expect(clear.saved.approval).toMatchObject({ approved: true, actor: 'policy:auto', mode: 'auto', reason: '只读已有资料' });
    expect(clear.saved.plans[0]).not.toHaveProperty('approvalRequest');
    expect(clear.model.systems[0]).toContain('approvalRequest');
    expect(clear.saved.events.some(event => event.type === 'plan.auto_approved')).toBe(true);
    expect(await clear.engine.advance(clear.saved.id)).toBe('needs_input');
    expect((await clear.engine.command(clear.saved.id, 'answer', { answer: '继续' })).status).not.toBe('needs_approval');

    const asked = await plan('auto', 'ask');
    expect(asked.status).toBe('needs_approval');
    expect(asked.saved.approval).toMatchObject({ approved: false, mode: 'auto', reason: '会调用外部工具' });
    expect(asked.saved.events.some(event => event.type === 'plan.approval_requested')).toBe(true);

    for (const judgment of ['omit', 'invalid'] as const) {
      const closed = await plan('auto', judgment);
      expect(closed.status).toBe('needs_approval');
      expect(closed.saved.approval?.approved).toBe(false);
      expect(closed.saved.approval?.reason).toContain('等待批准');
    }
  });

  it('lets yolo execute without treating the model judgment as a stop', async () => {
    const run = await plan('yolo', 'ask');
    expect(run.status).toBe('running');
    expect(run.saved.approval).toMatchObject({ approved: true, actor: 'policy:yolo', mode: 'yolo' });
    expect(run.saved.approval).not.toHaveProperty('reason');
    expect(run.model.systems[0]).not.toContain('approvalRequest');
    expect(await run.engine.advance(run.saved.id)).toBe('needs_input');
    const required = await plan('required', 'omit');
    expect(run.saved.plans[0]!.hash).toBe(required.saved.plans[0]!.hash);
  });
});
