import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelPin } from '../src/runtime/contracts.js';
import type { ToolGateway, ToolInvocation, ToolResult } from '../src/integrations.js';

// Reproduces run_95ec9b8c (sg, 2026-10-15 14:20 SGT): a deploy restarted the
// API while a web-fetch was pending; boot recovery marked it `unknown` and the
// run stayed stuck behind "reconcile the provider before retrying".
const pin: ModelPin = { model: 'fixture-model', endpoint: 'http://127.0.0.1:9999/chat/completions', promptVersion: 'fixture/1' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function repository() { const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-interrupt-'))); await repo.init(); return repo; }

class FetchModel implements ModelAdapter {
  readonly pin = pin;
  constructor(private readonly toolId: string) {}
  async complete(request: ModelRequest) {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Fetch a page', nodes: [{ id: 'search_route_attractions', title: 'Fetch', instruction: 'Fetch the page and report', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'ok', issues: [] } };
    const input = request.input as { observations: unknown[] };
    if (input.observations.length === 0) return { value: { type: 'capability', toolId: this.toolId, toolVersion: '1', input: { input: 'https://example.com/' }, purpose: 'Fetch' } };
    return { value: { type: 'finish', title: 'Report', content: 'Fetched page content.', evidenceRefs: ['tool-output-1'] } };
  }
}
class Gateway implements ToolGateway {
  invokes = 0; reconciles = 0;
  block?: { started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> };
  constructor(private readonly toolId: string, private readonly capabilities = ['execute']) {}
  async listTools() { return [{ id: this.toolId, version: '1', capabilities: this.capabilities, inputSchema: {}, outputSchema: {} }]; }
  async invoke(request: ToolInvocation): Promise<ToolResult> {
    this.invokes++;
    const block = this.block; this.block = undefined;
    if (block) { block.started.resolve(); await block.release.promise; }
    const at = new Date().toISOString();
    return { status: 'completed', output: { text: 'page' }, outputRefs: ['tool-output-1'], receipt: {
      schemaVersion: 'receipt/1', receiptId: `receipt_00000000-0000-0000-0000-00000000000${this.invokes}`, provider: 'toolkit_new', operation: request.toolId,
      requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: ['tool-output-1'], capabilitiesUsed: this.capabilities, startedAt: at, completedAt: at, status: 'completed' } };
  }
  async reconcile(): Promise<ToolResult> { this.reconciles++; throw new Error('provider has no record of this request'); }
}

async function approvedRunWithPendingTool(toolId: string, capabilities?: string[]) {
  const repo = await repository();
  const tools = new Gateway(toolId, capabilities);
  const first = new AgentEngine(repo, { model: new FetchModel(toolId), tools });
  const run = await first.create({ goal: '赤峰 3 天 2 晚自驾攻略', allowedTools: [`${toolId}@1`] });
  expect(await first.advance(run.id)).toBe('needs_approval');
  const plan = (await repo.get(run.id)).plans[0]!;
  await first.command(run.id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  await first.advance(run.id); // executor model call queues pendingTool
  expect((await repo.get(run.id)).pendingTool?.toolId).toBe(toolId);
  return { repo, tools, first, run };
}

async function finish(engine: AgentEngine, id: string) {
  for (let i = 0; i < 12; i++) { const status = await engine.advance(id); if (['succeeded', 'failed', 'unknown'].includes(status)) return status; }
  return 'running';
}

describe('restart during a tool call (run_95ec9b8c)', () => {
  it('re-issues an interrupted read-only web-fetch after restart instead of stranding the run', async () => {
    const { repo, tools, first, run } = await approvedRunWithPendingTool('web-fetch');
    const block = { started: deferred<void>(), release: deferred<void>() }; tools.block = block;
    const inFlight = first.advance(run.id);
    await block.started.promise;
    const rebooted = new AgentEngine(repo, { model: new FetchModel('web-fetch'), tools });
    await rebooted.recover();
    let current = await repo.get(run.id);
    expect(current.events.some(e => e.type === 'tool.interrupted')).toBe(true);
    expect(current.events.some(e => e.type === 'tool.auto_retry_scheduled')).toBe(true);
    expect(current.status).toBe('running');
    // The killed process's late result is fenced out.
    block.release.resolve();
    await inFlight.catch(() => undefined);
    expect((await repo.get(run.id)).status).toBe('running');
    await expect(finish(rebooted, run.id)).resolves.toBe('succeeded');
    current = await repo.get(run.id);
    expect(tools.reconciles).toBe(0);
    expect(current.toolReceipts.every(r => r.status === 'completed')).toBe(true);
    await repo.close();
  });

  it('heals a run already stranded in unknown by an earlier deploy on the next boot', async () => {
    const { repo, tools, first, run } = await approvedRunWithPendingTool('web-fetch');
    const release = deferred<void>(); const started = deferred<void>();
    tools.block = { started, release };
    const inFlight = first.advance(run.id).catch(() => undefined);
    await started.promise;
    // Simulate the pre-fix recovery that persisted status=unknown (production state).
    await repo.mutate(run.id, current => {
      current.toolReceipts ??= [];
      const receiptId = 'receipt_76ad70ea-aa19-4f32-8315-cf4700033ef8';
      current.toolReceipts.push({ schemaVersion: 'receipt/1', receiptId, provider: 'aeeis-recovery', operation: 'web-fetch', requestHash: 'b'.repeat(64), inputRefs: ['search_route_attractions'], outputRefs: [], capabilitiesUsed: [], startedAt: current.pendingTool!.requestedAt, completedAt: new Date().toISOString(), status: 'unknown', errorCode: 'worker_interrupted' });
      const { executionToken: _t, ...rest } = current.pendingTool!;
      current.pendingTool = { ...rest, receiptId };
      current.status = 'unknown'; current.resumeStatus = 'running'; current.error = 'External tool execution was interrupted; reconcile the provider before retrying.';
    });
    release.resolve(); await inFlight;
    const rebooted = new AgentEngine(repo, { model: new FetchModel('web-fetch'), tools });
    await rebooted.recover();
    expect((await repo.get(run.id)).status).toBe('running');
    await expect(finish(rebooted, run.id)).resolves.toBe('succeeded');
    expect(tools.reconciles).toBe(0);
    await repo.close();
  });

  it('keeps side-effecting tools stopped for an owner decision', async () => {
    const { repo, tools, first, run } = await approvedRunWithPendingTool('fixture.write', ['write']);
    const block = { started: deferred<void>(), release: deferred<void>() }; tools.block = block;
    const inFlight = first.advance(run.id).catch(() => undefined);
    await block.started.promise;
    await new AgentEngine(repo, { model: new FetchModel('fixture.write'), tools }).recover();
    const current = await repo.get(run.id);
    expect(current.status).toBe('unknown');
    expect(current.events.some(e => e.type === 'tool.auto_retry_scheduled')).toBe(false);
    block.release.resolve(); await inFlight;
    expect((await repo.get(run.id)).status).toBe('unknown');
    await repo.close();
  });

  it('does not mark a queued, never-claimed tool as interrupted', async () => {
    const { repo, tools, run } = await approvedRunWithPendingTool('fixture.write', ['write']);
    const rebooted = new AgentEngine(repo, { model: new FetchModel('fixture.write'), tools });
    await rebooted.recover();
    const current = await repo.get(run.id);
    expect(current.status).toBe('running');
    expect(current.events.some(e => e.type === 'tool.interrupted')).toBe(false);
    await expect(finish(rebooted, run.id)).resolves.toBe('succeeded');
    expect(tools.invokes).toBe(1);
    await repo.close();
  });

  it('drains in-flight work on shutdown and starts no new step', async () => {
    const { repo, tools, first, run } = await approvedRunWithPendingTool('web-fetch');
    const block = { started: deferred<void>(), release: deferred<void>() }; tools.block = block;
    const inFlight = first.advance(run.id);
    await block.started.promise;
    const drained = first.drain(5_000);
    block.release.resolve();
    expect(await drained).toBe(true);
    await inFlight;
    const before = (await repo.get(run.id)).revision;
    await first.advance(run.id);
    expect((await repo.get(run.id)).revision).toBe(before);
    expect((await repo.get(run.id)).toolReceipts.at(-1)?.status).toBe('completed');
    await repo.close();
  });
});
