import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { FileBrainStore } from '../src/brain.js';
import { FileEvolutionRepository, RsiService } from '../src/rsi.js';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { JsonFileStore } from '../src/adapters/json-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import type { RsiEvaluationHarness } from '../src/evaluation.js';
import { FileProjectionOutbox } from '../src/collaboration-projection.js';
import type { SkillGovernance } from '../src/integrations.js';

describe('AEEIS HTTP boundary', () => {
  it('does not pretend to execute when no model is configured', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-')));
    await repo.init();
    const app = buildApp({ repository: repo });
    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Do real work' } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('Configure');
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json()).toMatchObject({ modelConfigured: false });
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_bad/finish', payload: {} })).statusCode).toBe(503);
    await app.close(); await repo.close();
  });

  it('separates liveness from readiness and exposes bounded Prometheus metrics', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-health-runs-'))); await repo.init();
    const app = buildApp({ repository: repo });
    const live = await app.inject({ method: 'GET', url: '/health' });
    expect(live.statusCode).toBe(200); expect(live.json()).toMatchObject({ status: 'ok', protocol: 'aeeis-health/1' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503); expect(ready.json()).toMatchObject({ protocol: 'aeeis-readiness/1', status: 'not_ready' });
    expect(ready.json().checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'repository', ready: true, required: true }),
      expect.objectContaining({ name: 'model', ready: false, required: true }),
    ]));
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200); expect(metrics.headers['content-type']).toContain('text/plain'); expect(metrics.body).toContain('aeeis_model_configured 0');
    await app.close(); await repo.close();
  });

  it('exposes the three graph projections for a persisted run', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-graphs-'))); await repo.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: { summary: 'Plan', nodes: [{ id: 'one', title: 'One', instruction: 'One', dependsOn: [] }] } }) };
    const engine = new AgentEngine(repo, model); const run = await engine.create({ goal: 'Graph run' });
    const app = buildApp({ repository: repo, engine });
    const response = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/graphs` });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ planHistory: [], execution: { kind: 'execution' }, evidence: { kind: 'evidence' } }); expect(response.json().plan).toBeUndefined();
    await app.close(); await repo.close();
  });
  it('requires the configured bearer token and rejects cross-origin requests', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-auth-')));
    await repo.init();
    const app = buildApp({ repository: repo, token: 'local-secret' });
    expect((await app.inject({ method: 'GET', url: '/api/runs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer local-secret', origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: 'Bearer local-secret' } })).statusCode).toBe(200);
    await app.close(); await repo.close();
  });

  it('exposes owner Brain operations through the local API and persists them', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-runs-'))); await repo.init();
    const brainStore = new FileBrainStore(await mkdtemp(join(tmpdir(), 'aeeis-http-brain-'))); await brainStore.init();
    const brain = await brainStore.load(); const app = buildApp({ repository: repo, brain, brainStore });
    const created = await app.inject({ method: 'POST', url: '/api/brain/claims', payload: { owner: 'owner', scope: 'project', scopeRef: 'p1', classification: 'internal', kind: 'decision', content: 'Use durable execution', sourceRefs: ['src1'], confidence: 1 } });
    expect(created.statusCode).toBe(200);
    const listed = await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' });
    expect(listed.json().claims).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: '/api/brain/p1' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/brain/p1?classification=internal' })).json().claims).toHaveLength(0);
    await app.close(); await brainStore.close(); await repo.close();
  });

  it('exposes durable Goal, Plan, Task and Memory domain operations', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-runs-'))); await repo.init();
    const domainStore = new JsonFileStore(join(await mkdtemp(join(tmpdir(), 'aeeis-http-domain-')), 'domain.json')); await domainStore.init();
    const app = buildApp({ repository: repo, domain: new AeeisService(domainStore) });
    const created = await app.inject({ method: 'POST', url: '/api/goals', payload: { title: 'Ship domain API', description: 'Persist core objects' } });
    expect(created.statusCode).toBe(200);
    const goal = created.json() as { id: string };
    const memory = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/memories`, payload: { kind: 'decision', content: 'Keep AEEIS as the source of truth' } });
    expect(memory.statusCode).toBe(200);
    const planResponse = await app.inject({ method: 'POST', url: `/api/goals/${goal.id}/plans`, payload: { nodes: [{ id: 'draft', title: 'Draft', dependsOn: [] }, { id: 'review', title: 'Review', dependsOn: ['draft'] }] } });
    expect(planResponse.statusCode).toBe(200);
    const plan = planResponse.json() as { id: string };
    expect((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/tasks/draft/transition`, payload: { transition: 'start' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/tasks/draft/transition`, payload: { transition: 'succeed' } })).statusCode).toBe(200);
    const snapshot = await app.inject({ method: 'GET', url: `/api/plans/${plan.id}/snapshot` });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ goal: { id: goal.id }, plan: { id: plan.id }, receipts: [{ to: 'running' }, { to: 'succeeded' }] });
    expect((await app.inject({ method: 'GET', url: `/api/goals/${goal.id}/memories` })).json()).toHaveLength(1);
    await app.close(); await repo.close();
  });

  it('exposes the governed RSI candidate lifecycle through the API', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-'))); await evolution.init();
    const app = buildApp({ repository: repo, rsi: new RsiService(evolution) });
    const created = await app.inject({ method: 'POST', url: '/api/evolution/candidates', payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Correction', risk: 'low' } });
    expect(created.statusCode).toBe(200);
    const candidate = created.json() as { id: string };
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind: 'replay', passed: true, score: 0.9, evidenceRefs: ['eval.1'] } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind: 'holdout', passed: true, score: 0.9, evidenceRefs: ['eval.2'] } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind: 'safety', passed: true, score: 0.9, evidenceRefs: ['eval.3'] } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, payload: { approvalRef: 'approval.1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/promote`, payload: {} })).json().status).toBe('promoted');
    await app.close(); await evolution.close(); await repo.close();
  });

  it('exposes shadow and canary rollout gates for a medium-risk candidate', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-rollout-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-rsi-rollout-'))); await evolution.init();
    const app = buildApp({ repository: repo, rsi: new RsiService(evolution) });
    const created = await app.inject({ method: 'POST', url: '/api/evolution/candidates', payload: { target: 'skill', baseVersion: 'skill/1', proposedVersion: 'skill/2', change: 'Require rollout evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Safe rollout', risk: 'medium' } });
    const candidate = created.json() as { id: string };
    for (const kind of ['replay', 'holdout', 'safety'] as const) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate`, payload: { kind, passed: true, score: 0.9, evidenceRefs: [`eval.${kind}`] } });
    await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/approve`, payload: { approvalRef: 'owner.approval' } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/start-shadow`, payload: {} })).json().status).toBe('shadowing');
    for (let index = 1; index <= 3; index++) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/record-shadow`, payload: { id: `shadow.${index}`, passed: true, score: 0.9, evidenceRefs: [`shadow.${index}`] } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/start-canary`, payload: {} })).json().status).toBe('canarying');
    for (let index = 1; index <= 3; index++) await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/record-canary`, payload: { id: `canary.${index}`, passed: true, score: 0.9, evidenceRefs: [`canary.${index}`] } });
    expect((await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/promote`, payload: {} })).json().status).toBe('promoted');
    await app.close(); await evolution.close(); await repo.close();
  });

  it('exposes explicit Skill governance proposal, apply and rollback operations', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-skills-runs-'))); await repo.init();
    const calls: string[] = [];
    const skills: SkillGovernance = {
      resolve: async () => ({ plan: {} }),
      record: async () => ({ receiptRef: 'skill.receipt.1' }),
      propose: async () => [{ id: 'proposal.1', task: 'project pulse', status: 'ready', sourceReceiptId: 'receipt.1' }],
      apply: async proposalId => { calls.push(`apply:${proposalId}`); return { methodId: 'project-pulse', version: '2' }; },
      rollback: async (methodId, version) => { calls.push(`rollback:${methodId}@${version}`); return { methodId, version }; },
    };
    const app = buildApp({ repository: repo, skills });
    expect((await app.inject({ method: 'GET', url: '/api/skills/proposals' })).json()).toEqual([{ id: 'proposal.1', task: 'project pulse', status: 'ready', sourceReceiptId: 'receipt.1' }]);
    expect((await app.inject({ method: 'POST', url: '/api/skills/proposals/proposal.1/apply', payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/skills/proposals/proposal.1/apply', payload: { approvalRef: 'owner.approval.1' } })).json()).toEqual({ methodId: 'project-pulse', version: '2' });
    expect((await app.inject({ method: 'POST', url: '/api/skills/project-pulse/2/rollback', payload: { reason: 'regression' } })).json()).toEqual({ methodId: 'project-pulse', version: '2' });
    expect(calls).toEqual(['apply:proposal.1', 'rollback:project-pulse@2']);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().skillGovernanceConfigured).toBe(true);
    await app.close(); await repo.close();
  });

  it('turns a Run correction into an evidence-bound RSI candidate', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-correction-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-correction-rsi-'))); await evolution.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }) };
    const engine = new AgentEngine(repo, model);
    const app = buildApp({ repository: repo, engine, rsi: new RsiService(evolution) });
    const withMaterial = await engine.create({ goal: 'Correction source with evidence', materials: [{ title: 'Brief', source: 'test', content: 'Evidence' }] });
    const materialRun = await app.inject({ method: 'GET', url: `/api/runs/${withMaterial.id}` });
    const evidenceId = (materialRun.json() as { context: { sources: Array<{ id: string }> } }).context.sources[0]!.id;
    const response = await app.inject({ method: 'POST', url: `/api/runs/${withMaterial.id}/corrections`, payload: { target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Require explicit evidence', reason: 'The report omitted its source', risk: 'low', sourceReceiptRefs: [evidenceId] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidate.status).toBe('proposed');
    expect(response.json().correction.sourceRefs).toEqual([evidenceId]);
    expect((await app.inject({ method: 'GET', url: `/api/runs/${withMaterial.id}` })).json().corrections).toHaveLength(1);
    await app.close(); await evolution.close(); await repo.close();
  });

  it('runs a bounded RSI evaluation suite through the HTTP boundary', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-suite-runs-'))); await repo.init();
    const evolution = new FileEvolutionRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-suite-rsi-'))); await evolution.init();
    const rsi = new RsiService(evolution);
    const candidate = await rsi.propose({ target: 'prompt', baseVersion: 'prompt/1', proposedVersion: 'prompt/2', change: 'Cite evidence', sourceReceiptRefs: ['receipt.1'], reason: 'Correction', risk: 'low' });
    const harness: RsiEvaluationHarness = { evaluate: async (_candidate, mode, testCase) => ({ passed: true, score: 0.9, evidenceRefs: [`${mode}.${testCase.id}`] }) };
    const app = buildApp({ repository: repo, rsi, rsiHarness: harness });
    const response = await app.inject({ method: 'POST', url: `/api/evolution/candidates/${candidate.id}/evaluate-suite`, payload: { suite: { replay: [{ id: 'r1', input: {} }], holdout: [{ id: 'h1', input: {} }], safety: [{ id: 's1', input: {} }] } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('evaluating');
    expect(response.json().evaluations).toHaveLength(3);
    await app.close(); await evolution.close(); await repo.close();
  });

  it('creates and delivers an idempotent collaboration projection snapshot', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-collab-'))); await collaboration.init();
    const projection = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-http-projection-outbox-'))); await projection.init();
    let delivered = 0;
    const app = buildApp({ repository: repo, collaboration: new CollaborationService(collaboration), projection, projectionSink: { deliver: async () => { delivered += 1; return { externalId: 'feishu.msg.1' }; } } });
    const debate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', payload: { taskId: 'task.projection', contextVersion: 'ctx.projection', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1 } });
    const debateId = (debate.json() as { id: string }).id;
    const created = await app.inject({ method: 'POST', url: '/api/collaborations/projections', payload: { channel: 'feishu', destination: 'chat.1', aggregateType: 'debate', aggregateId: debateId } });
    expect(created.statusCode).toBe(200);
    const eventId = (created.json() as { id: string }).id;
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/projections/${eventId}/deliver` })).json().status).toBe('delivered');
    expect(delivered).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().projectionConfigured).toBe(true);
    await app.close(); await projection.close(); await collaboration.close(); await repo.close();
  });

  it('exposes durable competition and debate collaboration endpoints', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-runs-'))); await repo.init();
    const collaboration = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-collab-'))); await collaboration.init();
    const app = buildApp({ repository: repo, collaboration: new CollaborationService(collaboration) });
    const created = await app.inject({ method: 'POST', url: '/api/collaborations/competitions', payload: {
      schemaVersion: 'competition-brief/1', taskId: 'task.http', contextVersion: 'ctx.http', goal: 'Choose', participantAgentIds: ['agent.one', 'agent.two'], expectedResultType: 'plan/1', maxRounds: 1, blindEvaluation: true,
    }});
    expect(created.statusCode).toBe(200); const competition = created.json() as { id: string };
    const result = (agentId: string) => ({ schemaVersion: 'result-envelope/1', taskId: 'task.http', agentId, status: 'completed', resultType: 'plan/1', summary: agentId, claims: [], artifacts: [], unresolved: [], requestedFollowups: [], cost: {}, capabilitiesUsed: [], contextVersion: 'ctx.http', receiptRef: `receipt.${agentId}` });
    await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/candidate`, payload: result('agent.one') });
    await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/candidate`, payload: result('agent.two') });
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/begin-evaluation`, payload: { evaluatorAgentId: 'agent.eval' } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/score`, payload: { evaluatorAgentId: 'agent.eval', score: { agentId: 'candidate_1', score: 0.8, accepted: true, reasons: [], evidenceRefs: [] } } });
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/competitions/${competition.id}/score`, payload: { evaluatorAgentId: 'agent.eval', score: { agentId: 'candidate_2', score: 0.5, accepted: true, reasons: [], evidenceRefs: [] } } })).json().status).toBe('completed');
    const debate = await app.inject({ method: 'POST', url: '/api/collaborations/debates', payload: { taskId: 'task.debate.http', contextVersion: 'ctx.debate.http', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1, maxTotalMessages: 1 } });
    expect(debate.statusCode).toBe(200); const room = debate.json() as { id: string };
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/debates/${room.id}/message`, payload: { schemaVersion: 'debate-message/1', messageId: 'message.http', debateId: room.id, round: 1, speakerAgentId: 'agent.one', type: 'position', content: 'Position', claimRefs: [], contextVersion: 'ctx.debate.http' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/collaborations/debates/${room.id}/close`, payload: { reason: 'done' } })).json().status).toBe('closed');
    await app.close(); await collaboration.close(); await repo.close();
  });
});
