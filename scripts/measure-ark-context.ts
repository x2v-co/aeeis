/** Offline real-engine prompt measurements. No credentials or provider requests. */
import { readFile } from 'node:fs/promises';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { ThreadService } from '../src/application/thread-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';

const csv = (await readFile(new URL('../tests/fixtures/project-pulse-large.csv', import.meta.url), 'utf8')).trimEnd();
const text = Array.from({ length: 200 }, (_, i) => `Task ${i}: owner ${i % 8}, ${i % 4 === 0 ? 'blocked' : 'open'}. Migration evidence and next action: verify release readiness.\n`).join('').padEnd(25_000, 'x');
const markdown = Array.from({ length: 200 }, (_, i) => `## Task ${i}\nOwner ${i % 8}; status ${i % 4 === 0 ? 'blocked' : 'open'}.\nMigration evidence and next action: verify release readiness.\n`).join('').padEnd(29_000, 'x');
for (const [name, content] of [['tasks.csv', csv], ['tasks.txt', text], ['tasks.md', markdown], ['thread-followup', '']] as const) {
  const repository = new InMemoryRunRepository();
  const calls: unknown[] = [];
  const model: ModelAdapter = {
    pin: { model: 'offline-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'measurement/1' },
    async complete(request) {
      const input = request.input as any;
      const phase = input.task ? 'executor' : input.artifacts ? 'reviewer' : 'planner';
      const finish = phase === 'executor' && (input.observations.length > 0 || input.task.id === 'pulse');
      calls.push({ phase: finish ? 'finish' : phase, task: input.task?.id, systemChars: request.system.length,
        inputChars: JSON.stringify(input).length, promptChars: request.system.length + JSON.stringify(input).length,
        maxTokens: request.maxTokens ?? 16_384 });
      let value: unknown;
      if (phase === 'planner') value = { summary: 'Pulse', nodes: [{ id: 'inspect', title: 'Inspect evidence', instruction: 'Inspect project evidence', dependsOn: [] }, { id: 'pulse', title: 'Project Pulse', instruction: 'Summarize project evidence', dependsOn: ['inspect'] }] };
      else if (phase === 'reviewer') value = { verdict: 'accepted', summary: 'Verified', issues: [] };
      else if (!finish) {
        const argument = input.sourceCatalog[0].id;
        value = name.endsWith('.csv') ? { type: 'tool', tool: 'sources.csvQuery', argument, aggregates: [{ op: 'count', as: 'tasks' }] }
          : name.endsWith('.md') ? { type: 'tool', tool: 'sources.markdownSection', argument, heading: 'Task 0' }
          : { type: 'tool', tool: 'sources.read', argument };
      } else {
        const ref = input.availableEvidenceRefs[0];
        const structured = { schemaVersion: 'project-pulse/1', progress: [{ text: 'Migration work is open.', evidenceRefs: [ref] }], completedChanges: [], blockers: [], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [], unknowns: [] };
        value = { type: 'finish', title: 'Pulse', content: 'Migration work is open.\n' + 'Evidence checked. '.repeat(150), evidenceRefs: [ref], ...(input.expectedArtifactType ? { artifactType: 'project-pulse/1', structured } : {}) };
      }
      return { value, usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const engine = new AgentEngine(repository, model);
  let run;
  if (name === 'thread-followup') {
    const parent = await engine.create({ goal: 'Previous project update' }, 'alice', 'tenant');
    await repository.mutate(parent.id, current => {
      current.status = 'succeeded';
      current.plans = [{ summary: 'Prior project plan', nodes: [], version: 1, hash: 'planhash', createdAt: current.createdAt }];
      current.review = { verdict: 'accepted', summary: 'Prior report verified', issues: [] };
      current.artifacts = Array.from({ length: 8 }, (_, i) => ({ id: `artifact_${i}`, taskId: `task_${i}`, title: 'Prior report', content: 'Migration progress. '.repeat(1500), evidenceRefs: [], hash: 'a'.repeat(64), createdAt: current.createdAt }));
    });
    const threads = new ThreadService(repository, engine), scope = { owner: 'alice', tenantId: 'tenant' };
    const thread = await threads.create({ initialRunId: parent.id }, scope);
    run = await threads.followUp(thread.id, { idempotencyKey: 'measurement', request: { goal: 'Project Pulse follow-up', builtinSkill: 'project-pulse/1' }, parentRunId: parent.id }, scope);
  } else run = await engine.create({ goal: 'Project Pulse', builtinSkill: 'project-pulse/1', materials: [{ title: name, source: `browser-file:${name}`, content }] });
  await engine.advance(run.id);
  await engine.command(run.id, 'approve', { planHash: (await repository.get(run.id)).plans[0]!.hash });
  for (let i = 0; i < 8; i++) if (['succeeded', 'failed', 'unknown'].includes(await engine.advance(run.id))) break;
  const completed = await repository.get(run.id);
  console.log(JSON.stringify({ name, sourceChars: content.length, status: completed.status, error: completed.error,
    historyBytes: run.context.threadHistory?.actualBytes, calls }));
}
