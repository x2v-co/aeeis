import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileProjectSourceProvider, projectSourceContentHash } from '../src/project-sources.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';

describe('Project Pulse follow-up tasks', () => {
  it.each(['connector', 'materials'] as const)('projects evidence-bound next actions from %s into a successor Plan after restart', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-project-pulse-followups-'));
    const sourcePath = join(directory, 'sources.json');
    const content = 'The release is blocked by the migration.';
    await writeFile(sourcePath, JSON.stringify([{ id: 'task:blocker', title: 'Release blocker', content, source: 'fixture:task', kind: 'task', tenantId: 'team-a', updatedAt: '2026-09-19T00:00:00.000Z', contentHash: projectSourceContentHash(content) }]));
    const store = new InMemoryStore();
    const domain = new AeeisService(store);
    const goal = await domain.createGoal({ title: 'Release readiness' }, undefined, 'alice', 'team-a');
    const model: ModelAdapter = {
      pin: { model: 'pulse-followup-fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' },
      complete: async request => {
        expect(request.system).toContain('built-in Project Pulse skill');
        if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Pulse', nodes: [{ id: 'pulse', title: 'Project Pulse', instruction: 'Summarize', dependsOn: [] }] } };
        if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Accepted', issues: [] } };
        const input = request.input as { sourceCatalog: Array<{ id: string }>; observations: unknown[] };
        if (input.observations.length === 0) return { value: { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog[0]!.id } };
        const ref = input.sourceCatalog[0]!.id;
        return { value: {
          type: 'finish', title: 'Project Pulse', content: 'Run a migration rehearsal before release.', evidenceRefs: [ref], artifactType: 'project-pulse/1',
          structured: { schemaVersion: 'project-pulse/1', progress: [], completedChanges: [], blockers: [{ text: content, evidenceRefs: [ref] }], risks: [], decisions: [], owners: [], deadlines: [], nextActions: [{ text: 'Run a migration rehearsal before release.', evidenceRefs: [ref] }], unknowns: [], },
        } };
      },
    };
    let repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const services = { model, domain, ...(mode === 'connector' ? { projectSources: new FileProjectSourceProvider(sourcePath) } : {}) };
    let engine = new AgentEngine(repository, services);
    try {
      const run = await engine.create({ goal: goal.title, goalId: goal.id, ...(mode === 'connector' ? { projectSourceQuery: 'release' } : { builtinSkill: 'project-pulse/1', materials: [{ title: 'Release blocker', content, source: 'user-input' }] }) }, 'alice', 'team-a');
      expect(await engine.advance(run.id)).toBe('needs_approval');
      // Restart at the approval boundary: the output contract is durable.
      await repository.close();
      repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
      engine = new AgentEngine(repository, services);
      const proposed = await repository.get(run.id);
      expect(proposed.builtinSkill).toBe(mode === 'materials' ? 'project-pulse/1' : undefined);
      await engine.command(run.id, 'approve', { planHash: proposed.plans[0]!.hash });
      expect(await engine.advance(run.id)).toBe('running');
      expect(await engine.advance(run.id)).toBe('running');
      expect(await engine.advance(run.id)).toBe('reviewing');
      expect(await engine.advance(run.id)).toBe('succeeded');
      const completed = await repository.get(run.id);
      const plans = await domain.listPlans(goal.id, 'alice', 'team-a');
      expect(plans).toHaveLength(2);
      expect(completed.domainPlanId).toBe(proposed.domainPlanId);
      const followUp = plans.find(plan => plan.id === completed.followUpPlanId)!;
      expect(followUp.nodes).toHaveLength(1);
      expect(followUp.nodes[0]).toMatchObject({ title: 'Run a migration rehearsal before release.', evidenceRefs: [run.context.sources[0]!.id], evidenceRunId: run.id, status: 'ready' });
      expect((await domain.getGoal(goal.id, 'alice', 'team-a')).status).toBe('active');
      expect(completed.events.some(event => event.type === 'project-pulse.next-actions.projected')).toBe(true);
    } finally { await repository.close(); }
  });
});
