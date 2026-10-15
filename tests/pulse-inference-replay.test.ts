import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ThreadService } from '../src/application/thread-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { projectPulseArtifactSchema, type AgentRun } from '../src/runtime/contracts.js';
import { repairMaxBytes, repairMaxTokens, repairTimeoutMs } from '../src/runtime/finish-repair.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const pulse = (ref: string) => ({ schemaVersion: 'project-pulse/1', progress: [{ text: '开发完成', evidenceRefs: [ref] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] });
const finish = (ref: string, prefix = '推断：') => ({ type: 'finish', title: 'Project Pulse', content: `开发完成 [${ref}]\n${prefix}可能需要调整测试顺序 [${ref}]`, evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse(ref) });

function replayModel(decide: (input: any, request: ModelRequest) => unknown | Promise<unknown>) {
  const repository = new InMemoryRunRepository();
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Pulse', nodes: [{ id: 'pulse', title: 'Pulse', instruction: 'Summarize source evidence', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Supported' } };
    return { value: await decide(request.input, request) };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'pulse-replay', endpoint: 'http://localhost', promptVersion: 'replay/1' }, complete });
  return { repository, complete, engine };
}
async function approved(f: ReturnType<typeof replayModel>, title = 'notes.txt', content = '开发完成，截止 10-20，测试安排未说明') {
  const run = await f.engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1', materials: [{ title, content, source: 'upload' }] }, 'owner', 'local');
  await approve(f, run);
  return run;
}
async function approve(f: ReturnType<typeof replayModel>, run: AgentRun) {
  expect(await f.engine.advance(run.id)).toBe('needs_approval');
  await f.engine.command(run.id, 'approve', { planHash: (await f.repository.get(run.id)).plans[0]!.hash, planVersion: (await f.repository.get(run.id)).plans[0]!.version });
}
async function drain(f: ReturnType<typeof replayModel>, run: AgentRun) {
  for (let tick = 0; tick < 12; tick++) if (['succeeded', 'failed', 'unknown'].includes(await f.engine.advance(run.id))) break;
  return f.repository.get(run.id);
}

describe('six Pulse cases with a deterministic replay model', () => {
  it.each(['csv', 'follow', 'md', 'txt', 'json', 'lt'] as const)('%s: source tools, inference derivation and terminal success without repair', async name => {
    const logs: any[] = [];
    vi.spyOn(console, 'warn').mockImplementation(line => logs.push(JSON.parse(String(line))));
    vi.spyOn(console, 'info').mockImplementation(line => logs.push(JSON.parse(String(line))));
    const large = readFileSync(new URL('./fixtures/project-pulse-large.csv', import.meta.url), 'utf8');
    const due = 'id,title,status,due,createdAt\n1,Fix login,open,2026-10-04,2026-01-05\n2,Write docs,done,2026-10-09,2026-01-05\n3,Ship v2,in_progress,2026-10-21,2026-01-05\n4,Audit logs,open,2026-10-13,2026-01-05\n5,Plan Q4,open,tbd,2026-01-05';
    const f = replayModel(input => {
      const ref = input.sourceCatalog[0].id;
      if ((name === 'csv' || name === 'lt' || name === 'follow' && !input.threadHistory) && !input.observations.length) return { type: 'tool', tool: 'sources.csvQuery', argument: ref,
        ...(name === 'lt' ? { select: ['id', 'title', 'due'], filters: [{ column: 'due', op: 'BEFORE', value: input.clock.currentDate }, ...['done', 'closed', '完成'].map(value => ({ column: 'status', op: 'ne', value }))], orderBy: [{ column: 'due', direction: 'asc' }] } : { groupBy: ['status'], aggregates: [{ op: 'count', as: 'count' }] }) };
      if (name === 'lt' && input.observations.length === 1) {
        expect(input.observations[0].result.rows.map((row: any) => row[0])).toEqual(['1', '4']);
        return { type: 'tool', tool: 'sources.csvQuery', argument: ref, filters: input.observations[0].result.query.filters, aggregates: [{ op: 'count', as: 'total' }] };
      }
      if (name === 'lt') {
        expect(input.observations[1].result.rows[0][0]).toBe(2);
        return { ...finish(ref), content: `总数 2\n1 Fix login 2026-10-04 [${ref}]\n4 Audit logs 2026-10-13 [${ref}]`, structured: { ...pulse(ref), progress: [{ text: '1 Fix login 2026-10-04', evidenceRefs: [ref] }, { text: '4 Audit logs 2026-10-13', evidenceRefs: [ref] }] } };
      }
      return finish(ref, name === 'csv' ? '' : name === 'txt' ? '推断:' : name === 'json' ? 'Inference:' : '推断：');
    });
    let run = await approved(f, name === 'follow' ? 'tasks.csv' : `notes.${name === 'lt' ? 'csv' : name}`, name === 'csv' || name === 'follow' ? large : name === 'lt' ? due : name === 'json' ? '{"progress":"开发完成","due":"10-20"}' : '# 计划\n开发完成，截止 10-20');
    if (name === 'lt') await f.repository.mutate(run.id, current => { current.createdAt = '2026-10-14T04:00:00.000Z'; });
    if (name === 'follow') {
      const parent = await drain(f, run);
      const thread = { id: `thread_${randomUUID()}`, owner: 'owner', tenantId: 'local', createdAt: new Date().toISOString() };
      await f.repository.createThread(thread, parent.id);
      run = await new ThreadService(f.repository, f.engine).followUp(thread.id, { idempotencyKey: 'pulse-follow', parentRunId: parent.id, request: { goal: 'Project Pulse follow-up', builtinSkill: 'project-pulse/1' } }, { owner: 'owner', tenantId: 'local' });
      await approve(f, run);
    }
    const completed = await drain(f, run);
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.events.some(event => event.type === 'artifact.repair_requested')).toBe(false);
    expect(completed.artifacts[0]?.artifactType).toBe('project-pulse/1');
    expect(projectPulseArtifactSchema.safeParse(completed.artifacts[0]?.structured).success).toBe(true);
    if (name !== 'lt' && name !== 'csv') expect(completed.artifacts[0]?.structured).toMatchObject({ risks: [{ text: '推断：可能需要调整测试顺序', derived: true, evidenceRefs: completed.artifacts[0]!.evidenceRefs }] });
    if (name === 'follow') expect(completed.context.threadHistory?.entries.length).toBeGreaterThan(0);
    if (name === 'lt') expect(logs.some(log => log.protocol === 'aeeis-csv-date-filter/1' && log.filters.some((filter: any) => filter.op === 'lt' && filter.effective))).toBe(true);
    for (const protocol of ['aeeis-finish-content-check/1', 'aeeis-finish-evidence-check/1']) expect(logs.some(log => log.protocol === protocol && log.result !== 'rejected')).toBe(true);
    expect(f.complete.mock.calls.some(([request]) => (request.input as any).finishRepair)).toBe(false);
  });
});

describe('production repair failure shapes', () => {
  function repairFixture(repair: (input: any, request: ModelRequest) => unknown | Promise<unknown>) {
    return replayModel((input, request) => {
      if (input.finishRepair) return repair(input, request);
      const ref = input.sourceCatalog[0].id;
      return { ...finish(ref), content: `截止 2026-10-20 [${ref}]`, structured: { ...pulse(ref), deadlines: [{ text: '交付', date: '2026-10-20', evidenceRefs: [ref] }] } };
    });
  }
  it('follow run_ba729f53: preserves artifactType, schema identity and valid fields when the repair drops or alters them', async () => {
    const f = repairFixture(input => ({ content: `截止 10-20 [${input.sourceCatalog[0].id}]`, title: 'corrupted', artifactType: 'website-builder/1', structured: { schemaVersion: 'website-builder/1', progress: [], deadlines: [{ text: 'corrupted', date: '10-20', evidenceRefs: ['invented'] }] } }));
    const completed = await drain(f, await approved(f));
    expect(completed.status, completed.error).toBe('succeeded');
    expect(completed.artifacts[0]).toMatchObject({ title: 'Project Pulse', artifactType: 'project-pulse/1', structured: { schemaVersion: 'project-pulse/1', progress: [{ text: '开发完成' }], deadlines: [{ text: '交付', date: '10-20', evidenceRefs: completed.artifacts[0]!.evidenceRefs }] } });
    expect(completed.events.some(event => event.type === 'artifact.repair_discarded')).toBe(false);
  });
  it.each(['more problems', 'new error type', 'invalid finish content'])('reverts a repair with %s and retains a useful partial artifact', async shape => {
    const f = repairFixture(input => ({ content: shape === 'more problems' ? '负载测试通常在核心集成之后 [证据]' : shape === 'invalid finish content' ? '' : `截止 10-20 [${input.sourceCatalog[0].id}]`, structured: { deadlines: [{ date: shape === 'more problems' ? '2026-10-20' : '' }] } }));
    const completed = await drain(f, await approved(f));
    expect(completed.status, completed.error).toBe('succeeded'); expect(completed.partial).toBe(true);
    expect(completed.artifacts[0]).toMatchObject({ structured: { progress: [{ text: '开发完成' }], deadlines: [] }, partial: true });
    expect(completed.artifacts[0]!.content).not.toContain('负载测试通常');
    expect(completed.events.find(event => event.type === 'artifact.repair_discarded')?.data.reason).toContain(shape === 'invalid finish content' ? 'new decision schema error' : 'more problems or new error types');
  });
  it('csv run_02ad7211: discards 651KB repair output under explicit token and byte caps', async () => {
    const f = repairFixture((_input, request) => {
      expect(request).toMatchObject({ maxTokens: repairMaxTokens, maxResponseBytes: repairMaxBytes, timeoutMs: repairTimeoutMs, disableRetries: true });
      return { content: 'x'.repeat(651 * 1024) };
    });
    const completed = await drain(f, await approved(f));
    expect(completed.status, completed.error).toBe('succeeded'); expect(completed.partial).toBe(true);
    expect(completed.events.find(event => event.type === 'artifact.repair_discarded')?.data.reason).toContain('64KB');
    expect(JSON.stringify(completed).length).toBeLessThan(100_000);
  });
  it('csv run_02ad7211: a repair with no response times out, aborts, and finishes partial without another model call', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    let signal: AbortSignal | undefined;
    const f = repairFixture((_input, request) => { signal = request.signal; started(); return new Promise(() => {}); });
    const run = await approved(f);
    const transitions: string[] = [];
    const mutate = f.repository.mutate.bind(f.repository);
    vi.spyOn(f.repository, 'mutate').mockImplementation(async (...args) => {
      const snapshot = await mutate(...args);
      transitions.push(snapshot.status);
      return snapshot;
    });
    await f.engine.advance(run.id); // invalid candidate
    const repairing = f.engine.advance(run.id);
    await began;
    await vi.advanceTimersByTimeAsync(repairTimeoutMs);
    expect(await repairing).toBe('succeeded');
    const completed = await f.repository.get(run.id);
    expect(signal?.aborted).toBe(true); expect(completed.partial).toBe(true);
    expect(completed.calls.at(-1)?.state).toBe('unknown');
    expect(transitions).not.toContain('unknown'); // Temporal never races the repair fallback.
    const calls = f.complete.mock.calls.length;
    expect(await f.engine.advance(run.id)).toBe('succeeded'); expect(f.complete).toHaveBeenCalledTimes(calls);
    expect(completed.events.find(event => event.type === 'artifact.repair_discarded')?.data.reason).toContain('timed out');
  });
});
