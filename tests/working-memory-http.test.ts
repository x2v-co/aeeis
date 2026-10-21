import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { buildApp } from '../src/runtime/http.js';
import { captureWorkingOriginals, newWorkingMemory } from '../src/runtime/working-memory.js';
import { debugBundle, debugRunView, sharedRunView } from '../src/runtime/run-debug.js';
import { threadRun } from './support/thread-contract.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function fixture() {
  const repository = new InMemoryRunRepository();
  const run = threadRun(); run.workingMemory = newWorkingMemory();
  const nodes = [{ id: 'alpha', title: 'Alpha', instruction: 'Read own evidence', dependsOn: [] }, { id: 'beta', title: 'Beta', instruction: 'Read other evidence', dependsOn: [] }];
  run.plans = [{ version: 1, hash: 'a'.repeat(64), summary: 'Two isolated nodes', nodes, createdAt: run.createdAt }];
  run.approval = { approved: true, planHash: 'a'.repeat(64), planVersion: 1, at: run.createdAt };
  run.steps = nodes.map(node => ({ taskId: node.id, status: 'running', attempts: 1, observations: [{ tool: 'sources.read', argument: 'source_1', result: { id: 'source_1', text: `${node.id}-unique-marker ` + 'x'.repeat(4000), evidenceRefs: ['source_1'] } }] }));
  for (const node of nodes) captureWorkingOriginals(run, node, () => ['source_1']);
  const alpha = run.workingMemory.originals.find(original => original.taskId === 'alpha')!;
  const beta = run.workingMemory.originals.find(original => original.taskId === 'beta')!;
  run.calls.push({ id: 'call_summary', phase: 'compaction', taskId: 'alpha', state: 'completed', inputHash: 'b'.repeat(64), startedAt: run.createdAt, rawOutput: 'private-summary-payload', modelRequest: { system: 'summary', input: { slices: [{ text: 'private-manifest-payload' }] } } });
  run.calls.push({ id: 'call_planner', phase: 'planner', state: 'completed', inputHash: 'c'.repeat(64), startedAt: run.createdAt, rawOutput: 'planner-raw-marker', modelRequest: { system: 'planner', input: { marker: 'planner-model-marker' } } });
  run.steps[0]!.observations.push({ tool: 'context.read', argument: alpha.id, result: { text: 'private-read-payload' } });
  run.events.push({ id: 'evt_summary_leak', seq: run.events.length + 1, type: 'model.failed', at: run.createdAt, data: { callId: 'call_summary', rawOutput: 'private-summary-payload', modelRequest: { system: 'summary-leak' } } });
  run.events.push({ id: 'evt_planner_raw', seq: run.events.length + 1, type: 'model.failed', at: run.createdAt, data: { callId: 'call_planner', rawOutput: 'planner-event-raw' } });
  await repository.create(run);
  const app = buildApp({ repository, principalTokens: {
    alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
    elsewhere: { id: 'alice', tenantId: 'team-b', roles: ['owner'] }, agent: { id: 'alice', tenantId: 'team-a', roles: ['agent'] },
  } });
  cleanup.push(() => app.close());
  const get = (suffix: string, token = 'alice') => app.inject({ method: 'GET', url: `/api/runs/${run.id}/working-memory${suffix}`, headers: { authorization: `Bearer ${token}` } });
  return { repository, app, run, alpha, beta, get };
}

describe('owner-scoped working memory inspection', () => {
  it('lists a hierarchy, searches exact originals and reads bounded pages without charging or mutating', async () => {
    const f = await fixture(), before = await f.repository.get(f.run.id);
    const index = await f.get('?taskId=alpha');
    expect(index.statusCode).toBe(200); expect(index.json().index.totalOriginals).toBe(1);
    expect(JSON.stringify(index.json())).not.toContain('beta-unique-marker');
    const search = await f.get('/search?taskId=alpha&q=alpha-unique-marker');
    expect(search.statusCode).toBe(200); expect(search.json().results[0].originalId).toBe(f.alpha.id);
    const original = await f.get(`/original?taskId=alpha&entryId=${f.alpha.id}`);
    expect(original.statusCode).toBe(200); expect(original.json().text).toContain('alpha-unique-marker');
    expect(original.json().text.length).toBeLessThanOrEqual(1800);
    expect(original.json().page.nextCharacterOffset).toBeGreaterThan(0);
    const next = await f.get(`/original?taskId=alpha&entryId=${f.alpha.id}&offset=${original.json().page.nextCharacterOffset}`);
    expect(next.statusCode).toBe(200); expect(next.json().page.characterOffset).toBe(original.json().page.nextCharacterOffset);
    expect(await f.repository.get(f.run.id)).toEqual(before);
  });
  it('rejects sibling originals, unknown tasks, malformed bounds and unauthorized owners/tenants', async () => {
    const f = await fixture();
    expect((await f.get(`/original?taskId=alpha&entryId=${f.beta.id}`)).statusCode).toBe(404);
    expect((await f.get('/original?taskId=alpha&entryId=wm_original_unknown')).statusCode).toBe(404);
    expect((await f.get('?taskId=unknown')).statusCode).toBe(404);
    expect((await f.get('/search?taskId=alpha&q=beta-unique-marker')).json().results).toEqual([]);
    expect((await f.get('/search?taskId=alpha&q=alpha&limit=7')).statusCode).toBe(400);
    expect((await f.get(`/original?taskId=alpha&entryId=${f.alpha.id}&offset=-1`)).statusCode).toBe(400);
    expect((await f.get(`/original?taskId=alpha&entryId=${f.alpha.id}&offset=99999`)).statusCode).toBe(400);
    for (const token of ['bob', 'elsewhere', 'agent']) {
      const result = await f.get('?taskId=alpha', token);
      expect(result.statusCode).toBe(token === 'agent' ? 403 : 404); expect(result.body).not.toContain('alpha');
    }
  });
  it('does not publish raw memory, compaction requests or rehydrated pages through ordinary views', async () => {
    const f = await fixture();
    for (const view of [debugRunView(f.run), sharedRunView(f.run), debugBundle(f.run), debugBundle(f.run, { omitRawProviderText: true })]) {
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('private-summary-payload'); expect(serialized).not.toContain('private-manifest-payload');
      expect(serialized).not.toContain('private-read-payload'); expect(serialized).not.toContain('"workingMemory"');
    }
    expect(JSON.stringify(debugRunView(f.run))).toContain('planner-model-marker');
    expect(JSON.stringify(debugBundle(f.run))).toContain('planner-raw-marker');
    expect(JSON.stringify(debugBundle(f.run))).toContain('planner-event-raw');
    expect(JSON.stringify(sharedRunView(f.run))).not.toContain('planner-model-marker');
    const response = await f.app.inject({ method: 'GET', url: `/api/runs/${f.run.id}`, headers: { authorization: 'Bearer alice' } });
    expect(response.statusCode).toBe(200); expect(response.json().workingMemoryEnabled).toBe(true);
    expect(response.json().workingMemory).toBeUndefined(); expect(response.body).not.toContain('private-read-payload');
    expect(response.body).not.toContain('private-summary-payload'); expect(response.body).toContain('planner-event-raw');
    expect(f.run.workingMemory?.originals).toHaveLength(2);
    expect(f.run.calls.find(call => call.id === 'call_summary')?.rawOutput).toBe('private-summary-payload');
  });
});
