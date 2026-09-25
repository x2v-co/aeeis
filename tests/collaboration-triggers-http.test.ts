import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { CollaborationService, FileCollaborationRepository } from '../src/collaboration-service.js';
import { CollaborationTriggerService, FileCollaborationTriggerStore } from '../src/collaboration-triggers.js';

describe('collaboration trigger HTTP boundary', () => {
  it('persists owner-scoped policies and evaluates an idempotent event', async () => {
    const runs = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-trigger-runs-'))); await runs.init();
    const collaborations = new FileCollaborationRepository(await mkdtemp(join(tmpdir(), 'aeeis-http-trigger-collab-'))); await collaborations.init();
    const triggerState = new FileCollaborationTriggerStore(await mkdtemp(join(tmpdir(), 'aeeis-http-trigger-state-'))); await triggerState.init();
    const triggerService = new CollaborationTriggerService(triggerState, new CollaborationService(collaborations));
    const app = buildApp({ repository: runs, collaboration: new CollaborationService(collaborations), collaborationTriggers: triggerService, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-b', roles: ['owner'] },
    } });
    const headers = { authorization: 'Bearer alice' };
    try {
      const created = await app.inject({ method: 'POST', url: '/api/collaborations/triggers/policies', headers, payload: {
        id: 'policy.http', name: 'Review disagreement', eventTypes: ['review.completed'], reviewConfidenceAtMost: 0.5,
        action: { type: 'debate', participantAgentIds: ['agent.one'], maxRounds: 1, maxMessagesPerAgent: 1 },
      } });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ id: 'policy.http', owner: 'alice', tenantId: 'team-a' });
      const event = { eventId: 'run:http:v1', eventType: 'review.completed', source: 'system', taskId: 'task.http', contextVersion: 'ctx.http', reviewConfidence: 0.2, occurredAt: new Date().toISOString() };
      const evaluated = await app.inject({ method: 'POST', url: '/api/collaborations/triggers/evaluate', headers, payload: event });
      expect(evaluated.statusCode).toBe(200); expect(evaluated.json()[0]).toMatchObject({ created: true, decision: { state: 'triggered', actionType: 'debate' } });
      const repeated = await app.inject({ method: 'POST', url: '/api/collaborations/triggers/evaluate', headers, payload: event });
      expect(repeated.statusCode).toBe(200); expect(repeated.json()[0].created).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/api/collaborations/debates', headers })).json()).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/collaborations/triggers/decisions', headers })).json()).toHaveLength(1);
      const decision = (await app.inject({ method: 'GET', url: '/api/collaborations/triggers/decisions', headers })).json()[0];
      const reconciled = await app.inject({ method: 'POST', url: `/api/collaborations/triggers/decisions/${decision.id}/reconcile`, headers, payload: { outcome: 'dispatch_failed', reason: 'Operator confirmed the triggered collaboration was not actionable' } });
      expect(reconciled.statusCode).toBe(200); expect(reconciled.json()).toMatchObject({ id: decision.id, state: 'triggered', dispatchState: 'failed' });
      const forbidden = await app.inject({ method: 'POST', url: `/api/collaborations/triggers/decisions/${decision.id}/reconcile`, headers: { authorization: 'Bearer bob' }, payload: { outcome: 'failed', reason: 'cross tenant' } });
      expect(forbidden.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/collaborations/triggers/policies', headers: { authorization: 'Bearer bob' } })).json()).toEqual([]);
    } finally { await app.close(); await triggerState.close(); await collaborations.close(); await runs.close(); }
  });
});
