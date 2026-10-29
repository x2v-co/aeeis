import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import type { Receipt, ToolGateway, ToolResult } from '../src/integrations.js';
import { boundedExecutorInput, boundedObservations } from '../src/runtime/prompt-context.js';

const resources: Array<{ directory: string; repo: FileRunRepository }> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const { directory, repo } of resources.splice(0)) { await repo.close(); await rm(directory, { recursive: true, force: true }); }
});

async function setup(options: { output?: unknown; errorCode?: string; failuresPerTask?: number; tasks?: number; status?: ToolResult['status']; cost?: Receipt['cost']; budget?: { moneyUsd: number } } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-recoverable-tools-'));
  const repo = new FileRunRepository(directory); await repo.init(); resources.push({ directory, repo });
  const requests: ModelRequest[] = [];
  let toolCalls = 0;
  const tools: ToolGateway = {
    listTools: async () => [{ id: 'web-fetch', version: '1', capabilities: ['execute'], inputSchema: {}, outputSchema: {} }],
    invoke: async request => {
      toolCalls++;
      const status = options.status ?? 'failed';
      return { status, output: options.output ?? { error: '网页抓取失败（HTTP 403）' }, receipt: {
        schemaVersion: 'receipt/1', receiptId: `receipt_${randomUUID()}`, provider: 'toolkit_new', operation: request.toolId,
        requestHash: 'a'.repeat(64), inputRefs: [request.taskId], outputRefs: [], capabilitiesUsed: ['execute'],
        startedAt: new Date().toISOString(), status, ...(options.errorCode ? { errorCode: options.errorCode } : {}),
        ...(options.cost ? { cost: options.cost } : {}),
      } };
    },
    reconcile: async (_request, receipt) => ({ status: 'failed', output: options.output ?? { error: '网页抓取失败（HTTP 403）' }, receipt: { ...receipt, status: 'failed' } }),
  };
  const model: ModelAdapter = {
    pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
    complete: async request => {
      requests.push(request);
      if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Research available sources',
        nodes: Array.from({ length: options.tasks ?? 1 }, (_, i) => ({ id: `work_${i}`, title: 'Research', instruction: 'Fetch a source or report limitations', dependsOn: [] })) } };
      if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Limitations reported', issues: [] } };
      const input = request.input as { observations: unknown[] };
      return { value: input.observations.length < (options.failuresPerTask ?? 1)
        ? { type: 'capability', toolId: 'web-fetch', toolVersion: '1', input: { input: `https://example.com/source-${input.observations.length}` }, purpose: 'Fetch a source' }
        : { type: 'finish', title: 'Partial report', content: 'The source could not be fetched; its claims remain unverified.', evidenceRefs: [] } };
    },
  };
  const restart = () => new AgentEngine(repo, { model, tools, executionLimits: { maxNodeIterations: 20 } });
  const engine = restart();
  const run = await engine.create({ goal: 'Research and report available evidence', allowedTools: ['web-fetch'], actionPolicy: { allow: ['web-fetch'] }, maxModelCalls: 40, ...(options.budget ? { externalBudget: options.budget } : {}) });
  await engine.advance(run.id);
  await engine.command(run.id, 'approve', { planHash: (await repo.get(run.id)).plans[0]!.hash, planVersion: (await repo.get(run.id)).plans[0]!.version });
  await engine.advance(run.id); // Queue the first capability call.
  const finish = async (activeEngine = engine) => {
    for (let i = 0; i < 40; i++) {
      const status = await activeEngine.advance(run.id);
      if (status === 'succeeded' || status === 'failed' || status === 'unknown') break;
    }
    return repo.get(run.id);
  };
  return { engine, repo, id: run.id, requests, restart, finish, toolCalls: () => toolCalls };
}

describe('recoverable tool failures', () => {
  it('continues after target HTTP 403 and presents the error to the executor before succeeding', async () => {
    const fixture = await setup();
    expect(await fixture.engine.advance(fixture.id)).toBe('running');
    const current = await fixture.repo.get(fixture.id);
    expect(current.pendingTool).toBeUndefined();
    expect(current.error).toBeUndefined();
    expect(current.steps[0]).toMatchObject({ status: 'running' });
    expect(current.steps[0]!.error).toBeUndefined();
    const observation = { tool: 'web-fetch', argument: expect.any(String), result: {
      error: { recoverable: true, message: '网页抓取失败（HTTP 403）', errorCode: 'http_403', httpStatus: 403 }, receiptId: current.toolReceipts[0]!.receiptId,
    } };
    expect(current.steps[0]!.observations).toEqual([observation]);
    expect(current.events.filter(event => event.type === 'tool.failed_recoverable')).toHaveLength(1);
    expect((await fixture.finish()).status).toBe('succeeded');
    const executor = fixture.requests.filter(request => (request.input as { task?: unknown }).task).at(-1)!;
    expect(executor.input).toMatchObject({ observations: [observation] });
    expect(executor.system).toContain('error.recoverable=true');
    expect(fixture.toolCalls()).toBe(1);
  });

  it.each([
    { output: { error: 'HTTP 400: bad request' } },
    { output: 'Toolkit rejected the request: HTTP 400', errorCode: 'toolkit_http_400' },
    { output: { error: { message: 'Missing page', httpStatus: 404 } } },
    { output: 'Target site returned HTTP 401' },
    { output: 'Target site returned HTTP 410' },
    { output: 'HTTP 429: too many requests' },
    { output: '网页抓取失败（HTTP 503）' },
    { output: { error: 'Target site unavailable', httpStatus: 502 } },
    { output: { error: 'Request timed out' } },
    { output: { error: '读取超时' } },
    { output: { error: 'Deadline exceeded' }, errorCode: 'deadline_exceeded' },
  ])('recovers from a recognized target/client failure: $output', async options => {
    const fixture = await setup(options);
    expect(await fixture.engine.advance(fixture.id)).toBe('running');
    expect((await fixture.repo.get(fixture.id)).steps[0]!.observations[0]!.result).toMatchObject({ error: { recoverable: true } });
  });

  it('fails on the fourth recoverable failure with the default task cap', async () => {
    const fixture = await setup({ failuresPerTask: Infinity });
    const run = await fixture.finish();
    expect(run.status).toBe('failed');
    expect(run.error).toBe('External tool execution failed');
    expect(run.steps[0]).toMatchObject({ error: run.error, failureReason: run.error });
    expect(run.events.filter(event => event.type === 'tool.failed_recoverable')).toHaveLength(3);
    expect(fixture.toolCalls()).toBe(4);
  });

  it('honors the configured task cap across an engine restart', async () => {
    vi.stubEnv('AEEIS_MAX_RECOVERABLE_TOOL_FAILURES', '1');
    const fixture = await setup({ failuresPerTask: Infinity });
    expect(await fixture.engine.advance(fixture.id)).toBe('running');
    expect((await fixture.finish(fixture.restart())).status).toBe('failed');
    expect(fixture.toolCalls()).toBe(2);
  });

  it.each(['AEEIS_MAX_RECOVERABLE_TOOL_FAILURES', 'AEEIS_MAX_RUN_RECOVERABLE_TOOL_FAILURES'])('allows recovery to be disabled with %s=0', async name => {
    vi.stubEnv(name, '0');
    const fixture = await setup();
    expect(await fixture.engine.advance(fixture.id)).toBe('failed');
    expect((await fixture.repo.get(fixture.id)).events.some(event => event.type === 'tool.failed_recoverable')).toBe(false);
  });

  it('bounds the whole run to eight recoverable failures across tasks', async () => {
    const fixture = await setup({ failuresPerTask: 3, tasks: 3 });
    const run = await fixture.finish();
    expect(run.status).toBe('failed');
    expect(run.events.filter(event => event.type === 'tool.failed_recoverable')).toHaveLength(8);
    expect(fixture.toolCalls()).toBe(9);
  });

  it.each([
    { errorCode: 'unauthorized' }, { errorCode: 'forbidden' }, { errorCode: 'auth_failed' },
    { errorCode: 'toolkit_http_401' }, { errorCode: 'toolkit_http_403' }, { errorCode: 'gateway_http_503' },
    { errorCode: 'capability_violation' }, { errorCode: 'policy_denied' }, { errorCode: 'budget_exceeded' },
    { output: 'Toolkit authentication failed: HTTP 403' },
    { output: 'Gateway returned HTTP 503' },
    { output: 'HTTP 407: proxy authentication required' },
    { output: 'Toolkit execution failed' },
    { output: 'Transport or protocol failed' },
  ])('keeps authentication, policy and unrecognized failures fatal: $errorCode $output', async options => {
    const fixture = await setup(options);
    expect(await fixture.engine.advance(fixture.id)).toBe('failed');
    const run = await fixture.repo.get(fixture.id);
    expect(run.error).toBe('External tool execution failed');
    expect(run.events.some(event => event.type === 'tool.failed_recoverable')).toBe(false);
  });

  it('keeps an otherwise recoverable error fatal when settlement exceeds the budget', async () => {
    const fixture = await setup({ cost: { money: 2, currency: 'USD' }, budget: { moneyUsd: 1 } });
    expect(await fixture.engine.advance(fixture.id)).toBe('failed');
    const run = await fixture.repo.get(fixture.id);
    expect(run.toolReceipts[0]!.authorization).toMatchObject({ decision: 'isolated', reason: 'budget_stopped' });
    expect(run.steps[0]!.observations).toEqual([]);
  });

  it('keeps an isolated authorization fatal and excludes its observation', async () => {
    const fixture = await setup();
    await fixture.repo.mutate(fixture.id, run => { run.pendingTool!.capabilityGrant = 'invalid-grant'; });
    expect(await fixture.engine.advance(fixture.id)).toBe('failed');
    const run = await fixture.repo.get(fixture.id);
    expect(run.toolReceipts[0]!.authorization).toMatchObject({ decision: 'isolated', reason: 'capability_mismatch' });
    expect(run.steps[0]!.observations).toEqual([]);
  });

  it('leaves unknown results reconcilable even if their text resembles a target error', async () => {
    const fixture = await setup({ status: 'unknown' });
    expect(await fixture.engine.advance(fixture.id)).toBe('unknown');
    const run = await fixture.repo.get(fixture.id);
    expect(run.pendingTool!.receiptId).toBe(run.toolReceipts[0]!.receiptId);
    expect(run.steps[0]!.observations).toEqual([]);
  });

  it('recovers when reconciliation confirms a target failure without issuing another tool call', async () => {
    const fixture = await setup({ status: 'unknown' });
    expect(await fixture.engine.advance(fixture.id)).toBe('unknown');
    await fixture.engine.command(fixture.id, 'reconcile', { reason: 'Read the provider receipt' });
    expect(await fixture.engine.advance(fixture.id)).toBe('running');
    expect((await fixture.finish()).status).toBe('succeeded');
    expect(fixture.toolCalls()).toBe(1);
    expect((await fixture.repo.get(fixture.id)).events.filter(event => event.type === 'tool.failed_recoverable')).toHaveLength(1);
  });

  it('preserves recoverable error details when observations or the overall prompt are compacted', () => {
    const error = { recoverable: true, message: 'HTTP 403', errorCode: 'http_403', httpStatus: 403 };
    const observation = { tool: 'web-fetch', argument: '{}', result: { error, receiptId: 'receipt-target', padding: 'x'.repeat(8000) } };
    expect(boundedObservations([observation, { tool: 'other', argument: '', result: {} }], () => [])[0]!.result).toMatchObject({ error, receiptId: 'receipt-target' });
    const input = boundedExecutorInput('', { fixed: 'x'.repeat(90_000), observations: [observation] });
    expect((input.observations as Array<{ result: unknown }>)[0]!.result).toMatchObject({ error, receiptId: 'receipt-target' });
  });
});
