import { describe, expect, it } from 'vitest';
import { comparePlans, projectRunGraphs } from '../src/runtime/graphs.js';
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

  it('keeps adjacent plan versions available for a diff view', () => {
    const revised = structuredClone(run) as AgentRun;
    revised.plans = [
      ...run.plans,
      {
        ...run.plans[0]!,
        version: 2,
        hash: 'f'.repeat(64),
        nodes: [
          { ...run.plans[0]!.nodes[0]!, title: 'Research sources' },
          { id: 'review', title: 'Review', instruction: 'Check', dependsOn: ['research'] },
          { ...run.plans[0]!.nodes[1]!, dependsOn: ['review'] },
        ],
      },
    ];
    const graphs = projectRunGraphs(revised);
    expect(graphs.planHistory).toHaveLength(2);
    expect(graphs.planHistory[1]?.nodes.map(node => node.id)).toEqual(['research', 'review', 'final']);
    expect(graphs.planComparisons).toHaveLength(1);
    expect(graphs.planComparisons[0]?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'research', kind: 'modified', fields: ['title'] }),
      expect.objectContaining({ taskId: 'review', kind: 'added' }),
      expect.objectContaining({ taskId: 'final', kind: 'modified', fields: ['dependsOn'] }),
    ]));
    // A reused task ID in v2 must not assign its current status to v1.
    expect(graphs.planHistory[0]?.nodes.every(node => node.status === undefined)).toBe(true);
    expect(graphs.plan?.nodes[0]?.status).toBe('succeeded');
  });

  it('treats dependency order as equivalent and reports instruction changes', () => {
    const before = { ...run.plans[0]!, nodes: [
      run.plans[0]!.nodes[0]!,
      { id: 'check', title: 'Check', instruction: 'Verify', dependsOn: [] },
      { ...run.plans[0]!.nodes[1]!, dependsOn: ['research', 'check'] },
    ] };
    const after = { ...before, version: 2, hash: 'f'.repeat(64), nodes: before.nodes.map(node => node.id === 'final' ? { ...node, instruction: 'Write with citations', dependsOn: ['check', 'research'] } : node) };
    const snapshot = structuredClone({ before, after });
    const comparison = comparePlans(before, after);
    expect(comparison.changes).toEqual([expect.objectContaining({ taskId: 'final', fields: ['instruction'] })]);
    expect({ before, after }).toEqual(snapshot);
    comparison.changes[0]!.before!.dependsOn.push('mutation');
    expect({ before, after }).toEqual(snapshot);
  });

  it('reports removed tasks and summary-only revisions without invented changes', () => {
    const before = run.plans[0]!;
    const after = { ...before, version: 2, hash: 'f'.repeat(64), summary: 'Revised explanation' };
    expect(comparePlans(before, after)).toMatchObject({
      fromVersion: 1, toVersion: 2, fromHash: before.hash, toHash: after.hash,
      summary: { before: before.summary, after: after.summary }, changes: [],
    });
    expect(comparePlans(before, { ...after, nodes: [before.nodes[0]!] }).changes).toEqual([
      { taskId: 'final', kind: 'removed', fields: [], before: before.nodes[1] },
    ]);
    expect(comparePlans(before, { ...before, nodes: [...before.nodes].reverse() }).changes).toEqual([]);
    expect(projectRunGraphs({ ...run, plans: [] }).planComparisons).toEqual([]);
  });

  it('excludes an isolated Tool receipt from the Evidence Graph', () => {
    const isolated = structuredClone(run) as AgentRun;
    isolated.toolReceipts = [{
      schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-4000-8000-000000000001', provider: 'fixture', operation: 'lookup', requestHash: 'a'.repeat(64), inputRefs: ['research'], outputRefs: [], capabilitiesUsed: [], startedAt: '2026-09-18T00:00:00.000Z', status: 'completed',
      authorization: { toolId: 'lookup', toolVersion: '1', taskId: 'research', capabilityGrant: 'run:graph:lookup', idempotencyKey: 'graph:lookup', decision: 'isolated', reason: 'cancelled', settledAt: '2026-09-18T00:00:01.000Z' },
    }];
    expect(projectRunGraphs(isolated).evidence.nodes.some(node => node.id === isolated.toolReceipts[0]!.receiptId)).toBe(false);
  });
});
