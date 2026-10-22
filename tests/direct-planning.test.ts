import { describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { directApprovalReason, planningDecision } from '../src/runtime/planning-shape.js';

const pin = { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' };

class Fixture implements ModelAdapter {
  readonly pin = pin;
  readonly systems: string[] = [];
  async complete(request: ModelRequest) {
    this.systems.push(request.system);
    if (request.system.includes('Plan a real deliverable')) {
      return { value: { summary: 'Read the note', nodes: [{ id: 'read_note', title: 'Read', instruction: 'Read the supplied note', dependsOn: [] }] } };
    }
    return { value: { type: 'question', question: '请补充一条说明' } };
  }
}

function engine() {
  const repository = new InMemoryRunRepository();
  const model = new Fixture();
  return { repository, model, engine: new AgentEngine(repository, model) };
}

describe('direct planning', () => {
  it('classifies one read-only deliverable separately from tools, live data and external effects', () => {
    expect(planningDecision({ goal: '读这张纸条' })).toEqual({ shape: 'direct', reason: 'read_only' });
    expect(planningDecision({ goal: '读这张纸条', allowedTools: ['read'] }).reason).toBe('tools');
    expect(planningDecision({ goal: '读这张纸条', allowedAgents: ['agent.research'] }).reason).toBe('agents');
    expect(planningDecision({ goal: '读这张纸条', externalBudget: { calls: 1 } }).reason).toBe('budget');
    expect(planningDecision({ goal: '读这张纸条', builtinSkill: 'project-pulse/1' }).reason).toBe('skill');
    expect(planningDecision({ goal: '今天天气怎么样' }).reason).toBe('live_data');
    expect(planningDecision({ goal: '给客户发邮件' }).reason).toBe('external_effect');
    expect(planningDecision({ goal: '读', taskExecution: { domainPlanId: 'plan', taskId: 'task' } }).reason).toBe('domain_task');
    expect(planningDecision({ goal: '读'.repeat(4001) }).reason).toBe('length');
  });

  it('writes one hashed step without a planner call and still honors the review gate', async () => {
    const required = engine();
    const created = await required.engine.create({ goal: '读这张纸条', planning: 'direct', executionReview: 'required' });
    expect(await required.engine.advance(created.id)).toBe('needs_approval');
    const saved = await required.repository.get(created.id);
    expect(required.model.systems).toEqual([]);
    expect(saved.planning).toBe('direct');
    expect(saved.plans[0]).toMatchObject({ version: 1, summary: '直接执行：读这张纸条', nodes: [{ id: 'deliver', title: '读这张纸条', instruction: '读这张纸条', dependsOn: [] }], author: { type: 'policy', actor: 'policy:direct' } });
    expect(saved.plans[0]).not.toHaveProperty('approvalRequest');
    expect(saved.approval).toEqual({ planHash: saved.plans[0]!.hash, planVersion: 1, approved: false });
    expect(saved.events.some(event => event.type === 'plan.proposed' && event.data.source === 'direct')).toBe(true);
    expect(saved.events.some(event => event.type === 'model.started' || event.type === 'plan.auto_approved')).toBe(false);

    const cleared = engine();
    const auto = await cleared.engine.create({ goal: '读这张纸条', planning: 'direct', executionReview: 'auto' });
    expect(await cleared.engine.advance(auto.id)).toBe('running');
    const autoSaved = await cleared.repository.get(auto.id);
    expect(cleared.model.systems).toEqual([]);
    expect(autoSaved.approval).toMatchObject({ approved: true, actor: 'policy:direct', mode: 'auto', reason: directApprovalReason });
    expect(autoSaved.plans[0]!.hash).toBe(saved.plans[0]!.hash);
    expect(await cleared.engine.advance(auto.id)).toBe('needs_input');
    expect(cleared.model.systems[0]).not.toContain('Plan a real deliverable');

    const yolo = engine();
    const yoloRun = await yolo.engine.create({ goal: '读这张纸条', planning: 'direct', executionReview: 'yolo' });
    expect(await yolo.engine.advance(yoloRun.id)).toBe('running');
    const yoloSaved = await yolo.repository.get(yoloRun.id);
    expect(yoloSaved.approval).toMatchObject({ approved: true, actor: 'policy:yolo', mode: 'yolo' });
    expect(yoloSaved.approval).not.toHaveProperty('reason');
    expect(yoloSaved.plans[0]!.hash).toBe(saved.plans[0]!.hash);
  });

  it('keeps an omitted or explicit task graph on the planner', async () => {
    for (const planning of [undefined, 'dag'] as const) {
      const run = engine();
      const created = await run.engine.create({ goal: '读这张纸条', ...(planning ? { planning } : {}) });
      expect(await run.engine.advance(created.id)).toBe('needs_approval');
      const saved = await run.repository.get(created.id);
      expect(run.model.systems[0]).toContain('Plan a real deliverable');
      expect(saved.plans[0]!.author).toMatchObject({ type: 'model' });
      expect(saved.plans[0]!.nodes[0]!.id).toBe('read_note');
      expect(saved.planning).toBe(planning);
    }
  });

  it('refuses direct admission when the request cannot stay a single read-only step', async () => {
    const run = engine();
    const rejected = [
      { goal: '读这张纸条', planning: 'direct', allowedTools: ['read'] },
      { goal: '读这张纸条', planning: 'direct', allowedAgents: ['agent.research'] },
      { goal: '读这张纸条', planning: 'direct', externalBudget: { calls: 1 } },
      { goal: '读这张纸条', planning: 'direct', builtinSkill: 'project-pulse/1' },
      { goal: '今天天气怎么样', planning: 'direct' },
      { goal: '给客户发邮件', planning: 'direct' },
      { goal: '读'.repeat(4001), planning: 'direct' },
      { goal: '读', planning: 'direct', taskExecution: { domainPlanId: 'plan', taskId: 'task' } },
    ];
    for (const request of rejected) await expect(run.engine.create(request)).rejects.toThrow(RangeError);
    const admitted = await run.engine.create({ goal: '读'.repeat(4000), planning: 'direct' });
    expect(admitted.planning).toBe('direct');
    expect(admitted.plans).toEqual([]);
  });

  it('uses the planner when a direct plan is revised', async () => {
    const run = engine();
    const created = await run.engine.create({ goal: '读这张纸条', planning: 'direct' });
    expect(await run.engine.advance(created.id)).toBe('needs_approval');
    await run.engine.command(created.id, 'revise-plan', { planVersion: 1, feedback: '拆成两步' });
    expect(await run.engine.advance(created.id)).toBe('needs_approval');
    const saved = await run.repository.get(created.id);
    expect(saved.planning).toBe('direct');
    expect(saved.plans).toHaveLength(2);
    expect(saved.plans[1]!.author).toMatchObject({ type: 'model' });
    expect(saved.plans[1]!.nodes[0]!.id).toBe('read_note');
    expect(run.model.systems).toHaveLength(1);
    expect(run.model.systems[0]).toContain('Plan a real deliverable');
  });
});
