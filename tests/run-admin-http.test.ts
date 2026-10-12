import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { ModelOutcomeUnknown } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { WorkflowStatus } from '../src/runtime/dispatcher.js';
import type { Principal } from '../src/security/principal.js';

describe('Run cancel and Temporal reconcile HTTP boundary', () => {
  let directory: string, repository: FileRunRepository, engine: AgentEngine, app: ReturnType<typeof buildApp>, runId: string;
  const principalTokens: Record<string, Principal> = {
    alice: { id: 'alice', tenantId: 'team', roles: ['owner'] },
    bob: { id: 'bob', tenantId: 'team', roles: ['owner'] },
    outsider: { id: 'alice', tenantId: 'other', roles: ['owner'] },
    agent: { id: 'alice', tenantId: 'team', roles: ['agent'] },
    operator: { id: 'alice', tenantId: 'team', roles: ['operator'] },
    ops: { id: 'ops', tenantId: 'local', roles: ['operator'] },
  };
  const dispatcher = {
    notify: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ outcome: 'cancelled' as const })),
    describe: vi.fn(async (): Promise<{ status: WorkflowStatus }> => ({ status: 'TERMINATED' })),
  };
  const post = (url: string, payload: unknown = {}, token = 'alice') => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}` } });
  beforeEach(async () => {
    vi.resetAllMocks();
    dispatcher.cancel.mockResolvedValue({ outcome: 'cancelled' });
    dispatcher.describe.mockResolvedValue({ status: 'TERMINATED' });
    directory = await mkdtemp(join(tmpdir(), 'aeeis-run-admin-'));
    repository = new FileRunRepository(directory); await repository.init();
    engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }) });
    runId = (await engine.create({ goal: 'Run administration' }, 'alice', 'team')).id;
    // These operational endpoints must work even without an engine/model.
    app = buildApp({ repository, dispatcher, principalTokens });
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); });

  it('cancels with audit metadata, then repeats without a duplicate event', async () => {
    dispatcher.cancel.mockImplementation(async () => {
      expect((await repository.get(runId)).status).toBe('cancelled');
      return { outcome: 'cancelled' };
    });
    const response = await post(`/api/runs/${runId}/cancel`, { reason: 'SRE request' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ run: { status: 'cancelled', cancellation: { reason: 'SRE request', actor: 'alice', source: 'api', at: expect.any(String) } }, workflow: { outcome: 'cancelled' } });
    const first = await repository.get(runId);
    expect(first.events.at(-1)).toMatchObject({ type: 'run.cancelled', data: { reason: 'SRE request', actor: 'alice' } });
    const repeated = await post(`/api/runs/${runId}/cancel`, { reason: 'Repeated' });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().run).toEqual(first);
    expect((await repository.get(runId)).events).toEqual(first.events);
    expect(dispatcher.cancel).toHaveBeenCalledTimes(2);
    expect(dispatcher.notify).not.toHaveBeenCalled();
  });
  it.each(['succeeded', 'failed'] as const)('rejects cancellation of %s with 409', async status => {
    await repository.mutate(runId, run => { run.status = status; });
    expect((await post(`/api/runs/${runId}/cancel`)).statusCode).toBe(409);
    expect(dispatcher.cancel).not.toHaveBeenCalled();
  });
  it('keeps cancellation durable when Temporal fails, and permits a retry', async () => {
    dispatcher.cancel.mockRejectedValueOnce(new Error('Temporal unavailable'));
    const response = await post(`/api/runs/${runId}/cancel`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ run: { status: 'cancelled' }, workflow: { outcome: 'error', message: 'Temporal unavailable' } });
    expect((await repository.get(runId)).events.at(-1)).toMatchObject({ type: 'run.cancel.workflow_failed', data: { actor: 'alice', reason: '', message: 'Temporal unavailable' } });
    expect((await post(`/api/runs/${runId}/cancel`)).json().workflow.outcome).toBe('cancelled');
    expect((await repository.get(runId)).events.filter(event => event.type === 'run.cancelled')).toHaveLength(1);
  });
  it('enforces authentication, roles, ownership and reason validation', async () => {
    expect((await app.inject({ method: 'POST', url: `/api/runs/${runId}/cancel`, payload: {} })).statusCode).toBe(401);
    for (const token of ['bob', 'outsider']) {
      expect((await post(`/api/runs/${runId}/cancel`, {}, token)).statusCode).toBe(404);
      expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal' }, token)).statusCode).toBe(404);
    }
    expect((await post(`/api/runs/${runId}/cancel`, {}, 'agent')).statusCode).toBe(403);
    expect((await post(`/api/runs/${runId}/cancel`, { reason: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await post(`/api/runs/${runId}/cancel`, { reason: 42 })).statusCode).toBe(400);
    expect(dispatcher.cancel).not.toHaveBeenCalled();
    expect((await post(`/api/runs/${runId}/cancel`, {}, 'operator')).statusCode).toBe(200);
  });
  it('allows an operator to reconcile only its own tenant-scoped run', async () => {
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal' }, 'operator')).statusCode).toBe(200);
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal' }, 'ops')).statusCode).toBe(404);
    expect((await post(`/api/runs/${runId}/cancel`, {}, 'ops')).statusCode).toBe(404);
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal' }, 'agent')).statusCode).toBe(403);
    expect((await post(`/api/runs/${runId}/resume`, {}, 'operator')).statusCode).toBe(403);
  });
  it('does not bypass cancellation validation through an encoded action', async () => {
    await app.close(); app = buildApp({ repository, dispatcher, engine, principalTokens });
    await repository.mutate(runId, run => { run.status = 'failed'; });
    expect((await post(`/api/runs/${runId}/%63ancel`)).statusCode).toBe(409);
    expect((await repository.get(runId)).status).toBe('failed');
    expect(dispatcher.notify).not.toHaveBeenCalled();
  });
  it.each(['running', 'queued'] as const)('does not apply a stale observation after concurrent progress to %s', async status => {
    dispatcher.describe.mockImplementationOnce(async () => {
      await repository.mutate(runId, run => { run.status = status; });
      return { status: 'TERMINATED' };
    });
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })).json()).toMatchObject({ appStatus: status, action: 'none', applied: false });
    expect((await repository.get(runId)).events.some(event => event.type === 'run.reconciled')).toBe(false);
  });
  it('rechecks Temporal before applying an old closed observation', async () => {
    dispatcher.describe.mockResolvedValueOnce({ status: 'COMPLETED' }).mockResolvedValue({ status: 'RUNNING' });
    const before = await repository.get(runId);
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })).json()).toMatchObject({ workflowStatus: 'RUNNING', action: 'none', applied: false });
    expect(await repository.get(runId)).toEqual(before);
  });
  it('serializes concurrent cancellation and reconciliation without duplicate events', async () => {
    await Promise.all(Array.from({ length: 4 }, () => post(`/api/runs/${runId}/cancel`)));
    expect((await repository.get(runId)).events.filter(event => event.type === 'run.cancelled')).toHaveLength(1);
    expect(dispatcher.cancel).toHaveBeenCalledTimes(4);
  });
  it('applies concurrent reconciliations only once', async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })));
    expect(responses.filter(response => response.json().applied)).toHaveLength(1);
    expect((await repository.get(runId)).events.filter(event => event.type === 'run.reconciled')).toHaveLength(1);
  });
  it('defaults to dry-run and applies reconciliation once with metadata', async () => {
    await repository.mutate(runId, run => { run.status = 'needs_approval'; });
    const before = await repository.get(runId);
    const dry = await post(`/api/runs/${runId}/reconcile`, { source: 'temporal' });
    expect(dry.json()).toEqual({ runId, appStatus: 'needs_approval', workflowStatus: 'TERMINATED', action: 'cancel', applied: false });
    expect(await repository.get(runId)).toEqual(before);
    const applied = await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false });
    expect(applied.json()).toEqual({ runId, appStatus: 'cancelled', workflowStatus: 'TERMINATED', action: 'cancel', applied: true });
    const run = await repository.get(runId);
    expect(run.reconciliation).toMatchObject({ workflowStatus: 'TERMINATED', previousStatus: 'needs_approval', actor: 'alice', at: expect.any(String), reason: expect.any(String) });
    expect(run.events.at(-1)).toMatchObject({ type: 'run.reconciled', data: run.reconciliation });
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })).json()).toMatchObject({ action: 'none', applied: false });
    expect(await repository.get(runId)).toEqual(run);
    expect(dispatcher.notify).not.toHaveBeenCalled();
  });
  it.each(['RUNNING', 'CONTINUED_AS_NEW'] as const)('never touches %s workflows', async status => {
    dispatcher.describe.mockResolvedValue({ status });
    const before = await repository.get(runId);
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })).json()).toMatchObject({ action: 'none', applied: false });
    expect(await repository.get(runId)).toEqual(before);
  });
  it('fails a missing workflow without dispatching it again', async () => {
    dispatcher.describe.mockResolvedValue({ status: 'NOT_FOUND' });
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })).json()).toMatchObject({ appStatus: 'failed', action: 'fail', applied: true });
    expect((await repository.get(runId)).error).toContain('not_found');
    expect(dispatcher.notify).not.toHaveBeenCalled();
  });
  it('does not overwrite a run that became terminal after describe', async () => {
    dispatcher.describe.mockImplementationOnce(async () => {
      await repository.mutate(runId, run => { run.status = 'succeeded'; });
      return { status: 'TERMINATED' };
    });
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false })).json()).toMatchObject({ appStatus: 'succeeded', action: 'none', applied: false });
    expect((await repository.get(runId)).events.some(event => event.type === 'run.reconciled')).toBe(false);
  });
  it.each(['completed', 'unknown', 'failed', 'recovered'] as const)('preserves reconciled failure when an in-flight model returns %s', async outcome => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    engine = new AgentEngine(repository, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'fixture/1' }, complete: async () => {
      entered(); await waiting;
      if (outcome === 'unknown') throw new ModelOutcomeUnknown('Provider disconnected');
      if (outcome === 'failed') throw new Error('Provider failed');
      return { value: { summary: 'Plan', nodes: [{ id: 'task', title: 'Task', instruction: 'Do task', dependsOn: [] }] } };
    } });
    const tick = engine.advance(runId);
    await started;
    dispatcher.describe.mockResolvedValue({ status: 'FAILED' });
    const response = await post(`/api/runs/${runId}/reconcile`, { source: 'temporal', dry_run: false });
    expect(response.json()).toMatchObject({ appStatus: 'failed', applied: true });
    if (outcome === 'recovered') {
      await engine.recover();
      expect((await repository.get(runId)).status).toBe('failed');
    }
    release();
    expect(await tick).toBe('failed');
    const current = await repository.get(runId);
    expect(current.error).toBe('Temporal workflow failed');
    expect(current.plans).toEqual([]);
    if (outcome === 'completed') expect(current.calls[0]?.state).toBe('discarded');
  });
  it('preserves legacy reason reconciliation through engine.command and notify', async () => {
    await app.close(); app = buildApp({ repository, dispatcher, engine, principalTokens });
    await repository.mutate(runId, run => { run.status = 'unknown'; });
    const command = vi.spyOn(engine, 'command');
    const response = await post(`/api/runs/${runId}/reconcile`, { reason: 'Provider confirmed safe retry' });
    expect(response.statusCode).toBe(200);
    expect(command).toHaveBeenCalledWith(runId, 'reconcile', { reason: 'Provider confirmed safe retry' });
    expect(response.json().status).toBe('queued');
    expect(dispatcher.notify).toHaveBeenCalledWith(runId);
    expect(dispatcher.describe).not.toHaveBeenCalled();
  });
  it('requires an installation operator and scans across owners with filters and limits', async () => {
    expect((await post('/api/admin/reconcile')).statusCode).toBe(403);
    expect((await post('/api/admin/reconcile', {}, 'agent')).statusCode).toBe(403);
    expect((await post('/api/admin/reconcile', {}, 'ops')).json()).toMatchObject({ dry_run: true, scanned: 1, results: [{ runId, action: 'cancel', applied: false }] });
    const second = await engine.create({ goal: 'Other tenant' }, 'bob', 'elsewhere');
    await repository.mutate(runId, run => { run.status = 'needs_approval'; });
    expect((await post('/api/admin/reconcile', { statuses: ['queued'], limit: 1 }, 'ops')).json()).toMatchObject({ scanned: 1, results: [{ runId: second.id }] });
    const response = await post('/api/admin/reconcile', { dry_run: false, run_ids: [runId, runId] }, 'ops');
    expect(response.json()).toMatchObject({ dry_run: false, scanned: 1, results: [{ runId, applied: true }] });
    expect((await repository.get(runId)).reconciliation?.actor).toBe('ops');
    expect((await post('/api/admin/reconcile', { limit: 1001 }, 'ops')).statusCode).toBe(400);
  });
  it('uses repository scan pages beyond terminal runs', async () => {
    const run = await repository.get(runId);
    const terminal = { ...run, id: 'terminal', status: 'succeeded' as const };
    const scan = vi.spyOn(repository, 'scanPage').mockResolvedValueOnce({ runs: [terminal], throughId: runId, done: false }).mockResolvedValueOnce({ runs: [run], throughId: runId, done: true });
    vi.spyOn(repository, 'list').mockRejectedValue(new Error('Unbounded list must not be used'));
    expect((await post('/api/admin/reconcile', { limit: 1 }, 'ops')).json().scanned).toBe(1);
    expect(scan).toHaveBeenNthCalledWith(2, { limit: 200, afterId: 'terminal', throughId: runId });
    expect(dispatcher.describe).toHaveBeenCalledTimes(1);
  });
  it('reports unsupported cancellation and unavailable Temporal description', async () => {
    await app.close(); app = buildApp({ repository, principalTokens });
    expect((await post(`/api/runs/${runId}/reconcile`, { source: 'temporal' })).statusCode).toBe(503);
    expect((await post('/api/admin/reconcile', {}, 'ops')).statusCode).toBe(503);
    expect((await post(`/api/runs/${runId}/cancel`)).json().workflow).toEqual({ outcome: 'unsupported' });
  });
});
