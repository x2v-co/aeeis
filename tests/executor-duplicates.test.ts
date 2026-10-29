import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelOutcomeUnknown, type ModelRequest } from '../src/runtime/model.js';
import type { ToolGateway } from '../src/integrations.js';

describe('executor capability reuse', () => {
  it.each([false, true])('reuses completed receipts across restart, scoped to one node (failed final synthesis: %s)', async failFinal => {
    const repository = new InMemoryRunRepository();
    const invoke = vi.fn<ToolGateway['invoke']>(async request => ({ status: 'completed',
      output: { title: 'Official travel guidance', url: 'https://chifeng.gov.cn/travel', excerpt: 'Family routes and opening hours' },
      outputRefs: ['web_page'], receipt: {
        schemaVersion: 'receipt/1', receiptId: `receipt_00000000-0000-0000-0000-${String(invoke.mock.calls.length).padStart(12, '0')}`, provider: 'toolkit_new', operation: request.toolId,
        requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: ['web_page'], capabilitiesUsed: ['execute'],
        startedAt: new Date().toISOString(), status: 'completed', cost: { money: 0.1, currency: 'USD' },
      } }));
    const tools: ToolGateway = { listTools: async () => [{ id: 'web-fetch', version: '1', capabilities: ['execute'], inputSchema: {}, outputSchema: {} }], invoke };
    const complete = vi.fn(async (request: ModelRequest) => {
      const input = request.input as any;
      if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Research routes', nodes: [
        { id: 'research', title: 'Research routes', instruction: 'Fetch travel guidance', dependsOn: [] },
        { id: 'report', title: 'Report routes', instruction: 'Check the route again and summarize', dependsOn: ['research'] },
      ] } };
      if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Received evidence retained' } };
      if (input.executionBudget.finalOnly) {
        if (failFinal && input.task.id === 'research') throw new ModelOutcomeUnknown('Provider timed out');
        if (failFinal) expect(input.dependencies[0]).toMatchObject({ partial: true });
        return { value: { type: 'finish', title: 'Route guidance', content: 'The official page provides family route guidance; opening hours need confirmation.', evidenceRefs: [input.observations[0].result.receiptId] } };
      }
      const count = input.observations.length;
      return { value: { type: 'capability', toolId: 'web-fetch', toolVersion: '1', purpose: count === 1 ? 'Read the same source again' : 'Research routes',
        input: count === 1 ? { options: { b: 2, a: 1 }, url: 'https://chifeng.gov.cn/travel', pages: [1, 2] }
          : { pages: count === 2 ? [2, 1] : [1, 2], url: 'https://chifeng.gov.cn/travel', options: { a: 1, b: 2 } } } };
    });
    const model = { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete };
    const restart = () => new AgentEngine(repository, { model, tools, executionLimits: { maxNodeIterations: 4 } });
    let engine = restart();
    const run = await engine.create({ goal: 'Research family routes', allowedTools: ['web-fetch'], actionPolicy: { allow: ['web-fetch'] } });
    await engine.advance(run.id);
    const plan = (await repository.get(run.id)).plans[0]!;
    await engine.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
    await engine.advance(run.id); // Request and complete the first fetch before restart.
    await engine.advance(run.id);
    engine = restart();
    for (let i = 0; i < 30; i++) {
      const status = await engine.advance(run.id);
      if (['succeeded', 'failed', 'unknown'].includes(status)) break;
    }
    const finished = await repository.get(run.id);
    expect(finished.status, finished.error).toBe('succeeded');
    expect(invoke).toHaveBeenCalledTimes(4); // Two distinct inputs per node.
    expect(finished.toolReceipts).toHaveLength(4);
    expect(finished.externalUsage).toMatchObject({ calls: 4, moneyUsd: 0.4 });
    expect(finished.events.filter(event => event.type === 'tool.duplicate')).toHaveLength(2);
    for (const step of finished.steps) {
      expect(step.observations[1]!.result).toMatchObject({ duplicateOf: (step.observations[0]!.result as any).receiptId });
      expect(step.status).toBe('succeeded');
    }
    if (failFinal) {
      const artifact = finished.artifacts[0]!;
      expect(artifact.partial).toBe(true);
      expect(artifact.limitations).toContain('Node model iteration limit reached');
      for (const text of ['Official travel guidance', 'https://chifeng.gov.cn/travel', 'Family routes and opening hours']) expect(artifact.content).toContain(text);
      expect(artifact.evidenceRefs).toEqual(expect.arrayContaining([finished.toolReceipts[0]!.receiptId, finished.toolReceipts[1]!.receiptId, 'web_page']));
      expect(finished.calls.filter(call => call.state === 'unknown')).toHaveLength(1);
    }
  });
});
