import { describe, expect, it } from 'vitest';
import { projectRunGraphs } from '../src/runtime/graphs.js';
import type { AgentRun } from '../src/runtime/contracts.js';

const run = {
  schemaVersion: 1, id: 'run_graphs', revision: 1, owner: 'owner', goal: 'Graph', status: 'succeeded', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:01.000Z',
  context: { id: 'ctx.graphs', audience: ['owner'], sources: [{ id: 'source.graph', title: 'Brief', content: 'Facts', source: 'user', hash: 'a'.repeat(64) }] }, privacy: 'internal', model: { model: 'fixture', endpoint: 'http://127.0.0.1/chat/completions', promptVersion: 'fixture/1' }, maxModelCalls: 5, calls: [{ id: 'model.graph', phase: 'executor', taskId: 'research', state: 'completed', inputHash: 'b'.repeat(64), outputHash: 'c'.repeat(64), startedAt: '2026-09-18T00:00:00.000Z', endedAt: '2026-09-18T00:00:01.000Z' }], allowedTools: [], allowedAgents: [], knowledgeMaxItems: 8, toolReceipts: [], delegationOutcomes: [], plans: [{ summary: 'Graph plan', nodes: [{ id: 'research', title: 'Research', instruction: 'Read', dependsOn: [] }, { id: 'final', title: 'Final', instruction: 'Write', dependsOn: ['research'] }], version: 1, hash: 'd'.repeat(64), createdAt: '2026-09-18T00:00:00.000Z' }], steps: [{ taskId: 'research', status: 'succeeded', attempts: 1, observations: [] }, { taskId: 'final', status: 'pending', attempts: 0, observations: [] }], artifacts: [{ id: 'artifact.graph', taskId: 'research', title: 'Notes', content: 'Notes', evidenceRefs: ['source.graph'], hash: 'e'.repeat(64), createdAt: '2026-09-18T00:00:01.000Z' }], events: [{ id: 'event.graph', seq: 1, type: 'artifact.created', at: '2026-09-18T00:00:01.000Z', data: { artifactId: 'artifact.graph', taskId: 'research', modelCallId: 'model.graph', evidenceRefs: ['source.graph'] } }], answers: [], review: { verdict: 'accepted', summary: 'accepted', issues: [] },
} as AgentRun;

describe('run graph projections', () => {
  it('projects independent plan, execution, and evidence graphs', () => {
    const graphs = projectRunGraphs(run);
    expect(graphs.plan?.edges).toEqual([{ from: 'research', to: 'final', type: 'depends_on' }]);
    expect(graphs.execution.nodes.map(node => node.id)).toContain('call:model.graph');
    expect(graphs.evidence.edges).toEqual(expect.arrayContaining([
      { from: 'source.graph', to: 'artifact.graph', type: 'supports' },
      { from: 'model.graph', to: 'artifact.graph', type: 'generated' },
    ]));
  });
});
