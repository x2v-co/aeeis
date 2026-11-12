import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { buildApp } from '../src/runtime/http.js';
import { event } from '../src/runtime/engine.js';

function run(index: number, status: AgentRun['status']): AgentRun {
  return {
    schemaVersion: 1, id: `run_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, revision: 1, owner: 'alice', tenantId: 'team-a', goal: `Run ${index}`, status,
    createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:01.000Z',
    context: { id: 'ctx', audience: ['alice@team-a'], sources: [] },
    privacy: 'internal', model: { model: 'fixture', endpoint: 'http://127.0.0.1:4399', promptVersion: 'fixture/1' },
    maxModelCalls: 10, modelUsage: { tokens: 0, unreportedCalls: 0 }, calls: [],
    allowedTools: [], allowedAgents: [], knowledgeMaxItems: 8,
    brainMaxItems: 20, toolReceipts: [], delegationOutcomes: [], plans: [], steps: [], artifacts: [],
    events: [{ id: `evt_${index}`, seq: 1, type: status === 'failed' ? 'run.failed' : 'run.started', at: '2026-11-05T00:00:01.000Z', data: {} }],
  } as unknown as AgentRun;
}

it('archives a finished Run without deleting it, brings it back, and refuses live or foreign Runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-run-archive-'));
  const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
  const app = buildApp({ repository: runs, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } } });
  const alice = { authorization: 'Bearer alice' };
  try {
    const failed = run(1, 'failed'), live = run(2, 'running');
    await runs.create(failed); await runs.create(live);
    const archive = (id: string, archived: boolean, headers = alice) => app.inject({ method: 'POST', url: `/api/runs/${id}/archive`, headers, payload: { archived } });

    expect((await archive(failed.id, true, { authorization: 'Bearer bob' })).statusCode).toBe(404);
    const live409 = await archive(live.id, true);
    expect(live409.statusCode).toBe(409);
    expect(live409.json().error).toContain('只有已结束的任务可以归档');
    expect((await app.inject({ method: 'POST', url: `/api/runs/${failed.id}/archive`, headers: alice, payload: { archived: true, extra: 1 } })).statusCode).toBe(400);

    const archived = await archive(failed.id, true);
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ id: failed.id, status: 'failed', archived: { actor: 'alice', at: expect.any(String) } });
    // Archiving twice is a no-op, not a second event.
    expect((await archive(failed.id, true)).statusCode).toBe(200);
    let stored = await runs.get(failed.id);
    expect(stored.events.filter(item => item.type === 'run.archived')).toHaveLength(1);
    expect(stored.events.at(-1)?.data).toEqual({ actor: 'alice' });
    // The record stays readable and listed, carrying the mark for the page to hide it.
    expect((await app.inject({ method: 'GET', url: `/api/runs/${failed.id}`, headers: alice })).json()).toMatchObject({ status: 'failed', archived: { actor: 'alice' } });
    const page = (await app.inject({ method: 'GET', url: '/api/runs/page?limit=50', headers: alice })).json();
    expect(page.items.find((item: { id: string }) => item.id === failed.id)).toMatchObject({ archived: { actor: 'alice' } });
    expect(page.items.find((item: { id: string }) => item.id === live.id)?.archived).toBeUndefined();

    const restored = await archive(failed.id, false);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().archived).toBeUndefined();
    stored = await runs.get(failed.id);
    expect(stored.archived).toBeUndefined();
    expect(stored.events.at(-1)?.type).toBe('run.unarchived');
  } finally { await app.close(); await runs.close(); }
});

it('clears the archive mark when the Run is put back to work', () => {
  for (const type of ['run.retry_requested', 'plan.revision_requested', 'plan.repair_requested', 'plan.revised', 'run.resumed', 'run.reconciled', 'model.timeout_retry']) {
    const item = run(3, 'failed');
    item.archived = { at: '2026-11-12T00:00:00.000Z', actor: 'alice' };
    event(item, type);
    expect(item.archived, type).toBeUndefined();
  }
  // A Run terminalized mid-call, archived, then revived by its late timeout retry.
  const revived = run(5, 'failed');
  revived.archived = { at: '2026-11-12T00:00:00.000Z', actor: 'alice' };
  revived.status = 'running';
  event(revived, 'model.timeout_retry', { callId: 'call_1' });
  expect(revived.archived).toBeUndefined();
  // Any write that finds the Run live again clears it, whatever the event.
  const live = run(6, 'failed');
  live.archived = { at: '2026-11-12T00:00:00.000Z', actor: 'alice' };
  live.status = 'planning';
  event(live, 'model.requested');
  expect(live.archived).toBeUndefined();
  const kept = run(4, 'failed');
  kept.archived = { at: '2026-11-12T00:00:00.000Z', actor: 'alice' };
  event(kept, 'rsi.correction.recorded');
  expect(kept.archived).toBeDefined();
});

it('never reports a live Run as archived, even with a stale stored mark', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aeeis-run-archive-live-'));
  const runs = new FileRunRepository(join(directory, 'runs')); await runs.init();
  const app = buildApp({ repository: runs, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
  try {
    const stale = run(7, 'running');
    stale.archived = { at: '2026-11-12T00:00:00.000Z', actor: 'alice' };
    await runs.create(stale);
    const page = (await app.inject({ method: 'GET', url: '/api/runs/page?limit=50', headers: { authorization: 'Bearer alice' } })).json();
    expect(page.items.find((item: { id: string }) => item.id === stale.id)).toMatchObject({ status: 'running' });
    expect(page.items.find((item: { id: string }) => item.id === stale.id)?.archived).toBeUndefined();
  } finally { await app.close(); await runs.close(); }
});
