import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { buildThreadHistory, DEFAULT_THREAD_HISTORY_BYTES, threadHistoryHash } from '../src/runtime/thread-history.js';
import { ThreadConflict } from '../src/runtime/threads.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { threadRecord, threadRun, threadScope } from './support/thread-contract.js';

async function fixture(count = 3) {
  const repository = new InMemoryRunRepository(), thread = threadRecord();
  await repository.createThread(thread);
  const runs = [];
  for (let index = 0; index < count; index++) {
    const run = threadRun(); run.goal = `goal ${index}`;
    runs.push(await repository.createRunInThread(run, thread.id, runs.at(-1)?.id, threadScope));
  }
  return { repository, thread, runs };
}
describe('frozen thread history', () => {
  it('includes only selected ancestry, chronological goals, latest summaries, answers and final outputs with provenance', async () => {
    const { repository, thread, runs } = await fixture();
    const parent = runs[2]!;
    await repository.mutate(parent.id, run => {
      run.plans = [1, 2].map(version => ({ version, summary: `plan ${version}`, nodes: [], hash: 'planhash', createdAt: run.createdAt }));
      run.review = { verdict: 'accepted', summary: 'latest review', issues: [] };
      run.answers = [{ taskId: 'task', question: 'Question?', answer: 'Answer.' }];
      run.calls = [{ id: 'secret-call', phase: 'planner', state: 'completed', inputHash: 'secret-input', rawOutput: 'raw provider output', startedAt: run.createdAt }];
      run.context.sources[0]!.content = 'complete source payload';
    });
    const branch = threadRun(); branch.goal = 'sibling excluded';
    await repository.createRunInThread(branch, thread.id, runs[0]!.id, threadScope);
    const snapshot = await buildThreadHistory(repository, thread.id, await repository.get(parent.id), threadScope, 'internal', DEFAULT_THREAD_HISTORY_BYTES);
    expect(snapshot.entries.map(entry => entry.runId)).toEqual(runs.map(run => run.id));
    expect(snapshot.entries.map(entry => entry.excerpts.find(item => item.kind === 'goal')?.text)).toEqual(['goal 0', 'goal 1', 'goal 2']);
    expect(snapshot.entries[2]!.excerpts.map(item => item.text)).toEqual(['goal 2', 'plan 2', 'latest review', 'report', 'Question?\nAnswer.']);
    expect(snapshot.entries[2]!.revision).toBe(parent.revision + 1);
    expect(snapshot.entries[2]!.excerpts.find(item => item.kind === 'artifact')).toMatchObject({ ref: 'artifact_1', hash: 'b'.repeat(64) });
    const serialized = JSON.stringify(snapshot);
    for (const excluded of ['sibling excluded', 'raw provider output', 'complete source payload', 'secret-call', 'secret-input', 'plan 1']) expect(serialized).not.toContain(excluded);
    expect(snapshot.hash).toBe(threadHistoryHash(snapshot));
    expect(snapshot.actualBytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    await repository.mutate(parent.id, run => { run.goal = 'changed later'; run.artifacts[0]!.content = 'changed later'; });
    expect(JSON.stringify(snapshot)).toBe(serialized);
  });
  it('honors the full byte budget for multibyte and JSON-escaped prose, prioritizes the immediate parent and stops retrieval', async () => {
    const { repository, thread, runs } = await fixture();
    await repository.mutate(runs[2]!.id, run => { run.goal = '中文🙂\n"\\'.repeat(3000); });
    const get = vi.spyOn(repository, 'get');
    const parent = await repository.get(runs[2]!.id); get.mockClear();
    const snapshot = await buildThreadHistory(repository, thread.id, parent, threadScope, 'internal', 1800);
    expect(snapshot.actualBytes).toBe(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
    expect(snapshot.actualBytes).toBeLessThanOrEqual(1800);
    expect(snapshot.entries.map(entry => entry.runId)).toEqual([parent.id]);
    expect(snapshot.entries[0]!.excerpts[0]!.text).not.toContain('\uFFFD');
    expect(snapshot.truncated).toBe(1);
    expect(snapshot.omitted.excerpts).toBeGreaterThan(0);
    expect(snapshot.omitted.ancestorContinuations).toBe(1);
    expect(get).not.toHaveBeenCalled();
    expect(snapshot.hash).toBe(threadHistoryHash(snapshot));
  });
  it('redacts against each ancestor before excerpt truncation, hashing and byte budgeting', async () => {
    const { repository, thread, runs } = await fixture(2);
    const secrets = ['opaque-ancestor-value', 'opaque-parent-value'];
    for (const [index, run] of runs.entries()) {
      await repository.mutate(run.id, current => {
        const secret = secrets[index]!.repeat(500);
        current.modelDecision = { environment: { CUSTOM: secret } };
        current.goal = `Goal repeats ${secret}. Safe ending.`;
        current.artifacts[0]!.content = `Report repeats ${secret}. Safe ending.`;
      });
    }
    const snapshot = await buildThreadHistory(repository, thread.id, await repository.get(runs[1]!.id), threadScope, 'internal', 1800);
    expect(snapshot.entries.map(entry => entry.runId)).toEqual(runs.map(run => run.id));
    for (const entry of snapshot.entries) {
      expect(entry.excerpts.map(excerpt => excerpt.text)).toEqual(['Goal repeats [REDACTED]. Safe ending.', 'Report repeats [REDACTED]. Safe ending.']);
      expect(entry.excerpts[0]!.hash).toBe(createHash('sha256').update(entry.excerpts[0]!.text).digest('hex'));
      expect(entry.excerpts[1]!.hash).toBe('b'.repeat(64));
    }
    for (const secret of secrets) expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(snapshot.truncated).toBe(0);
    expect(snapshot.omitted).toEqual({ excerpts: 0, artifacts: 0, ancestorContinuations: 0 });
    expect(snapshot.actualBytes).toBe(Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
    expect(snapshot.actualBytes).toBeLessThanOrEqual(1800);
    expect(snapshot.hash).toBe(threadHistoryHash(snapshot));
  });
  it('bounds ancestors to 20, artifacts to 8 per run and individual excerpts to 8 KiB', async () => {
    const { repository, thread, runs } = await fixture(22);
    const get = vi.spyOn(repository, 'get');
    const ancestry = await buildThreadHistory(repository, thread.id, runs[21], threadScope, 'internal', 65536);
    expect(get).toHaveBeenCalledTimes(19);
    expect(ancestry.visitedAncestors).toBe(20);
    expect(ancestry.entries.map(entry => entry.runId)).toEqual(runs.slice(2).map(run => run.id));
    expect(ancestry.omitted.ancestorContinuations).toBe(1);
    await repository.mutate(runs[0]!.id, run => {
      run.goal = '🙂'.repeat(4000);
      run.artifacts = Array.from({ length: 10 }, (_, index) => ({ ...run.artifacts[0]!, id: `artifact_${index}`, taskId: `task_${index}`, content: `output ${index}` }));
    });
    const outputs = await buildThreadHistory(repository, thread.id, await repository.get(runs[0]!.id), threadScope, 'internal', 65536);
    expect(outputs.entries[0]!.excerpts.filter(item => item.kind === 'artifact')).toHaveLength(8);
    expect(outputs.omitted.artifacts).toBe(2);
    expect(Buffer.byteLength(outputs.entries[0]!.excerpts[0]!.text, 'utf8')).toBeLessThanOrEqual(8192);
    expect(outputs.entries[0]!.excerpts[0]!.text).toMatch(/…\[truncated\]$/);
    expect(outputs.entries[0]!.excerpts[0]!.text).not.toContain('\uFFFD');
    expect(outputs.truncated).toBe(1);
  });
  it('rejects disclosure of included parent or ancestor classifications and validates envelope budgets', async () => {
    const { repository, thread, runs } = await fixture(2);
    await repository.mutate(runs[0]!.id, run => { run.privacy = 'private'; });
    await expect(buildThreadHistory(repository, thread.id, runs[1], threadScope, 'internal', 32768)).rejects.toThrow(ThreadConflict);
    const snapshot = await buildThreadHistory(repository, thread.id, runs[1], threadScope, 'private', 32768);
    expect(snapshot.entries[0]!.classification).toBe('private');
    for (const budget of [0, 1, 1.5, 65537]) await expect(buildThreadHistory(repository, thread.id, undefined, threadScope, 'internal', budget)).rejects.toThrow(RangeError);
    const empty = await buildThreadHistory(repository, thread.id, undefined, threadScope, 'internal', 32768);
    expect(empty.entries).toEqual([]); expect(empty.visitedAncestors).toBe(0);
  });
  it('retains source classifications and rejects owner audience exclusion even after redaction', async () => {
    const { repository, thread, runs } = await fixture(1);
    await repository.mutate(runs[0]!.id, run => { run.context.sources[0]!.classification = 'private'; });
    const parent = await repository.get(runs[0]!.id);
    await expect(buildThreadHistory(repository, thread.id, parent, threadScope, 'internal', 32768)).rejects.toThrow('classification');
    const history = await buildThreadHistory(repository, thread.id, parent, threadScope, 'private', 32768);
    expect(history.entries[0]!.classification).toBe('private');
    parent.context.audience = ['bob'];
    await expect(buildThreadHistory(repository, thread.id, parent, threadScope, 'private', 32768)).rejects.toThrow('audience');
    await expect(buildThreadHistory(repository, thread.id, parent, { ...threadScope, tenantId: 'other' }, 'private', 32768)).rejects.toThrow('owner and tenant');
  });
  it('excludes isolated receipts, delegations and dependent artifacts including review prose', async () => {
    const { repository, thread, runs } = await fixture(1);
    const parent = await repository.get(runs[0]!.id);
    parent.toolReceipts = [{ receiptId: 'isolated-tool', outputRefs: ['isolated-tool-output'], authorization: { decision: 'isolated' } }] as AgentRun['toolReceipts'];
    parent.delegationOutcomes = [{ receiptRef: 'isolated-agent', disposition: 'isolated', result: { artifacts: [{ ref: 'isolated-agent-output' }] } }] as AgentRun['delegationOutcomes'];
    const artifact = parent.artifacts[0]!;
    parent.artifacts = [
      { ...artifact, id: 'dependent', taskId: 'dependent', evidenceRefs: ['tainted'], content: 'indirect isolated text' },
      { ...artifact, id: 'tainted', taskId: 'tainted', evidenceRefs: ['isolated-tool-output'], content: 'isolated tool text' },
      { ...artifact, id: 'agent-result', taskId: 'agent-result', evidenceRefs: ['isolated-agent-output'], content: 'isolated agent text' },
      { ...artifact, id: 'safe', taskId: 'safe', content: 'safe final output' },
    ];
    parent.review = { verdict: 'accepted', issues: [], summary: 'review repeats isolated tool text' };
    parent.plans = [{ version: 1, hash: 'planhash', createdAt: parent.createdAt, nodes: [], summary: 'plan repeats isolated tool text' }];
    const history = await buildThreadHistory(repository, thread.id, parent, threadScope, 'internal', 32768);
    expect(history.entries[0]!.excerpts.map(item => item.ref)).toEqual([`${parent.id}#goal`, 'safe']);
    expect(history.omitted.artifacts).toBe(3);
    expect(history.omitted.excerpts).toBe(2);
    expect(JSON.stringify(history)).not.toContain('isolated tool text');
    expect(JSON.stringify(history)).not.toContain('isolated agent text');
    expect(JSON.stringify(history)).not.toContain('indirect isolated text');
  });
});
