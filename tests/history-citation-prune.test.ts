// Eval pulse-csv-followup (2026-11-19, deepseek-v4.1-flash): a follow-up cited "history:<runId>:artifact_<id>" and also listed
// the bare artifact id, which is not a valid ref. Pruning the bare id removed it from inside the history citation too,
// leaving "[history:<runId>:]" after every revision, and the reviewer rejected the follow-up three times.
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ThreadService } from '../src/application/thread-service.js';
import { AgentEngine, finishContentProblems, removeInlineRef } from '../src/runtime/engine.js';
import type { ModelRequest } from '../src/runtime/model.js';

afterEach(() => { vi.restoreAllMocks(); });
const pulse = (refs: string[]) => ({ schemaVersion: 'project-pulse/1', progress: [{ text: '开发完成', evidenceRefs: refs }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] });

it('removes a pruned id only where it stands alone, never inside a longer citation', () => {
  const id = 'artifact_ff1c63ec-7fb2-4766-8d30-77b5a0559d07', history = `history:run_febe92ef-fb52-4c46-a458-2fcf2bf45889:${id}`;
  expect(removeInlineRef(`a [${history}] b [${id}] c ${id}.`, id)).toBe(`a [${history}] b  c .`);
});

// Review on #241: only ids inside a real history citation are exempt; an id after any other colon is still checked and pruned.
it('still checks and prunes an id written right after an ordinary colon', () => {
  const id = 'source_11111111-1111-4111-8111-111111111111';
  expect(finishContentProblems(`证据:${id}`, new Set())).toEqual([`content cites IDs that were not received: ${JSON.stringify([id])}`]);
  expect(removeInlineRef(`证据:${id}。`, id)).toBe('证据:。');
  const history = 'history:run_febe92ef-fb52-4c46-a458-2fcf2bf45889:artifact_ff1c63ec-7fb2-4766-8d30-77b5a0559d07';
  expect(finishContentProblems(`[${history}]`, new Set([history]))).toEqual([]);
});

// Review on #241 (second round): a pruned history citation is removed whole; a longer citation that starts with it stays.
it('removes a whole invalid history citation, in brackets or bare, and nothing else', () => {
  const ref = 'history:run_febe92ef-fb52-4c46-a458-2fcf2bf45889:artifact_ff1c63ec-7fb2-4766-8d30-77b5a0559d07';
  expect(removeInlineRef(`正文 [${ref}]`, ref)).toBe('正文 ');
  expect(removeInlineRef(`正文 ${ref}，结束`, ref)).toBe('正文 ，结束');
  const run = 'history:run_febe92ef-fb52-4c46-a458-2fcf2bf45889:run_febe92ef-fb52-4c46-a458-2fcf2bf45889';
  expect(removeInlineRef(`[${run}#review] [${run}]`, run)).toBe(`[${run}#review] `);
  expect(removeInlineRef(`[${ref}]`, 'artifact_ff1c63ec-7fb2-4766-8d30-77b5a0559d07')).toBe(`[${ref}]`);
});

it('keeps a follow-up history citation whole when a bare artifact id in the same answer is pruned', async () => {
  for (const level of ['error', 'warn', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  const repository = new InMemoryRunRepository();
  let historyRef = '';
  const complete = vi.fn(async (request: ModelRequest) => {
    if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Pulse', nodes: [{ id: 'pulse', title: 'Pulse', instruction: 'Summarize', dependsOn: [] }] } };
    if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Supported' } };
    const input = request.input as any;
    const cited = (input.sourceCatalog as Array<{ id: string }>).find(source => /^history:.+:artifact_/.test(source.id));
    if (!cited) {
      const ref = input.sourceCatalog[0].id;
      return { value: { type: 'finish', title: 'Project Pulse', content: `开发完成 [${ref}]`, evidenceRefs: [ref], artifactType: 'project-pulse/1', structured: pulse([ref]) } };
    }
    historyRef = cited.id;
    const bare = historyRef.slice(historyRef.lastIndexOf(':') + 1);
    // The model cites the history excerpt correctly and also lists the bare artifact id, which is not a valid ref.
    return { value: { type: 'finish', title: 'Project Pulse', content: `开发完成 [${historyRef}]`, evidenceRefs: [historyRef], artifactType: 'project-pulse/1', structured: pulse([historyRef, bare]) } };
  });
  const engine = new AgentEngine(repository, { pin: { model: 'pulse-replay', endpoint: 'http://localhost', promptVersion: 'replay/1' }, complete });
  const drain = async (id: string) => { for (let tick = 0; tick < 12; tick++) if (['succeeded', 'failed', 'unknown'].includes(await engine.advance(id))) break; return repository.get(id); };
  const approve = async (id: string) => {
    expect(await engine.advance(id)).toBe('needs_approval');
    const plan = (await repository.get(id)).plans[0]!;
    await engine.command(id, 'approve', { planHash: plan.hash, planVersion: plan.version });
  };
  const run = await engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1', materials: [{ title: 'notes.txt', content: '开发完成', source: 'upload' }] }, 'owner', 'local');
  await approve(run.id);
  const parent = await drain(run.id);
  expect(parent.status, parent.error).toBe('succeeded');
  const thread = { id: `thread_${randomUUID()}`, owner: 'owner', tenantId: 'local', createdAt: new Date().toISOString() };
  await repository.createThread(thread, parent.id);
  const follow = await new ThreadService(repository, engine).followUp(thread.id, { idempotencyKey: 'follow', parentRunId: parent.id, request: { goal: 'Project Pulse follow-up', builtinSkill: 'project-pulse/1' } }, { owner: 'owner', tenantId: 'local' });
  await approve(follow.id);
  const done = await drain(follow.id);
  expect(done.status, done.error).toBe('succeeded');
  expect(historyRef).toMatch(/^history:run_.+:artifact_/);
  expect(done.events.some(event => event.type === 'artifact.evidence_pruned')).toBe(true);
  expect(done.artifacts.at(-1)!.content).toContain(`[${historyRef}]`);
  expect(done.artifacts.at(-1)!.content).not.toMatch(/\[history:run_[^\]]*:\]/);
});
