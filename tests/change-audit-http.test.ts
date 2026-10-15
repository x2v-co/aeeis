import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { GovernedBrain } from '../src/brain.js';
import { InMemoryKnowledgeProvider, makeKnowledgeRecord } from '../src/knowledge.js';

describe('operator change audit HTTP API', () => {
  it('requires operator authority, lists snapshots, and records rollback with the authenticated actor', async () => {
    const domain = new AeeisService(new InMemoryStore());
    const goal = await domain.createGoal({ title: 'Audit' });
    await domain.addMemory(goal.id, { kind: 'note', content: 'private snapshot' });
    const entry = (await domain.changeAudit.list())[0]!;
    const app = buildApp({ repository: new InMemoryRunRepository(), domain, principalTokens: {
      owner: { id: 'owner', tenantId: 'local', roles: ['owner'] },
      operator: { id: 'ops', tenantId: 'local', roles: ['operator'] },
    } });
    const headers = { authorization: 'Bearer operator' }, reason = { runId: 'run.test', trigger: 'operator recovery' };
    try {
      const url = '/api/admin/change-audit/memory';
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer owner' } })).statusCode).toBe(403);
      const listed = await app.inject({ method: 'GET', url: `${url}?subjectId=${entry.subjectId}&limit=1`, headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ entries: [entry], valid: true, headHash: entry.hash });
      const rollbackUrl = `${url}/${entry.id}/rollback`;
      expect((await app.inject({ method: 'POST', url: rollbackUrl, headers: { authorization: 'Bearer owner' }, payload: { reason } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: rollbackUrl, headers, payload: { reason: { trigger: 'missing task/run' } } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: rollbackUrl, headers, payload: { reason, actor: { kind: 'system', id: 'forged' } } })).statusCode).toBe(400);
      const rolledBack = await app.inject({ method: 'POST', url: rollbackUrl, headers, payload: { reason } });
      expect(rolledBack.statusCode).toBe(200);
      expect(rolledBack.json()).toMatchObject({ op: 'rollback', actor: { kind: 'user', id: 'ops' }, reason, after: null });
      expect(await domain.listMemories(goal.id)).toEqual([]);
      expect((await app.inject({ method: 'POST', url: `${url}/missing/rollback`, headers, payload: { reason } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `${url}/${entry.id}`, headers })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/admin/change-audit/skill', headers })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
  it('restores Brain and knowledge state through their configured persistence boundaries', async () => {
    const brain = new GovernedBrain();
    brain.addClaim({ owner: 'alice', tenantId: 'team', scope: 'task', scopeRef: 'task.test', kind: 'note', classification: 'private', content: 'snapshot', confidence: 1, sourceRefs: [] }, { id: 'alice', tenantId: 'team', roles: ['owner'] });
    let saved = false;
    const knowledge = new InMemoryKnowledgeProvider([]);
    await knowledge.upsert(makeKnowledgeRecord({ id: 'knowledge.test', title: 'Snapshot', content: 'snapshot', source: 'fixture', classification: 'private', tags: [], updatedAt: new Date().toISOString() }));
    const app = buildApp({ repository: new InMemoryRunRepository(), brain, brainStore: { save: async () => { saved = true; }, load: async () => brain, init: async () => {}, close: async () => {} }, knowledgeProvider: knowledge });
    try {
      for (const [source, entry] of [['brain', brain.changeAudit.list()[0]!], ['knowledge', (await knowledge.changeAudit.list())[0]!]] as const) {
        const response = await app.inject({ method: 'POST', url: `/api/admin/change-audit/${source}/${entry.id}/rollback`, payload: { reason: { taskId: 'task.test', trigger: 'restore' } } });
        expect(response.statusCode).toBe(200);
        expect(response.json().after).toBeNull();
      }
      expect(saved).toBe(true); expect(brain.state().claims).toEqual([]);
    } finally { await app.close(); }
  });
});
