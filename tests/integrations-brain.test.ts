import { describe, expect, it } from 'vitest';
import { brainBundleContentHash, GovernedBrain, FileBrainStore } from '../src/brain.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectModel } from '../src/integrations.js';

describe('governed Brain', () => {
  it('requires task-scoped grants for non-owner access and supports revocation', () => {
    const brain = new GovernedBrain();
    const claim = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-1', classification: 'confidential', kind: 'decision', content: 'Use Temporal', sourceRefs: ['source-1'], confidence: 1 }, 'owner');
    expect(() => brain.read('project-1', 'external')).toThrow('grant');
    const grant = brain.grant({ subject: 'external', scopeRef: 'project-1', classifications: ['confidential'], actions: ['read'], expiresAt: '2030-01-01T00:00:00.000Z' }, 'owner');
    expect(brain.read('project-1', 'external', 'confidential')[0]?.id).toBe(claim.id);
    brain.revoke(grant.id, 'owner');
    expect(() => brain.read('project-1', 'external', 'confidential')).toThrow('grant');
  });

  it('persists claims and audit history with atomic file replacement, then supports owner deletion', async () => {
    const store = new FileBrainStore(await mkdtemp(join(tmpdir(), 'aeeis-brain-')));
    await store.init();
    const brain = await store.load();
    const claim = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-2', classification: 'internal', kind: 'fact', content: 'Persist this claim', sourceRefs: ['source-2'], confidence: 0.8 }, 'owner');
    await store.save(brain);
    const restored = await store.load();
    expect(restored.export('project-2', 'owner')[0]?.id).toBe(claim.id);
    expect(restored.auditLog().map(item => item.action)).toContain('write');
    restored.deleteScope('project-2', 'owner');
    await store.save(restored);
    expect((await store.load()).export('project-2', 'owner')).toEqual([]);
    await store.close();
  });

  it('rejects malformed Brain grants before they can enter state', () => {
    const brain = new GovernedBrain();
    expect(() => brain.grant({ subject: 'agent', scopeRef: 'project', classifications: ['internal'], actions: [] as never[], expiresAt: '2030-01-01T00:00:00.000Z' }, 'owner')).toThrow();
  });

  it('exports and restores withdrawn claim history without resurrecting it', () => {
    const brain = new GovernedBrain();
    const active = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-history', classification: 'internal', kind: 'fact', content: 'Keep this fact', sourceRefs: ['source.active'], confidence: 1 }, 'owner');
    const withdrawn = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-history', classification: 'internal', kind: 'fact', content: 'Withdraw this fact', sourceRefs: ['source.withdrawn'], confidence: 0.5 }, 'owner');
    brain.retract('project-history', withdrawn.id, 'owner');
    const claims = brain.exportHistory('project-history', 'owner');
    expect(claims.map(item => [item.id, item.state])).toEqual([[active.id, 'active'], [withdrawn.id, 'retracted']]);
    const restored = new GovernedBrain();
    expect(restored.importBundle({ schemaVersion: 'aeeis-brain-bundle/1', exportedAt: new Date().toISOString(), owner: 'owner', tenantId: 'local', scopeRef: 'project-history', claims, contentHash: brainBundleContentHash(claims) }, 'owner')).toMatchObject({ imported: 2, skipped: 0 });
    expect(restored.export('project-history', 'owner').map(item => item.id)).toEqual([active.id]);
    expect(restored.exportHistory('project-history', 'owner').find(item => item.id === withdrawn.id)?.state).toBe('retracted');
  });

  it('supports bounded lexical retrieval without bypassing classification grants', () => {
    const brain = new GovernedBrain();
    const first = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-search', classification: 'internal', kind: 'decision', content: 'Use Temporal for durable execution', sourceRefs: ['receipt.temporal'], confidence: 1 }, 'owner');
    brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-search', classification: 'internal', kind: 'note', content: 'The launch color is blue', sourceRefs: ['receipt.color'], confidence: 1 }, 'owner');
    const hits = brain.search('project-search', 'durable execution', 'owner', 'internal', 1);
    expect(hits.map(claim => claim.id)).toEqual([first.id]);
    brain.grant({ subject: 'external', scopeRef: 'project-search', classifications: ['internal'], actions: ['read'], expiresAt: '2030-01-01T00:00:00.000Z' }, 'owner');
    expect(() => brain.search('project-search', 'durable', 'external', 'confidential', 1)).toThrow('grant');
    expect(brain.auditLog().filter(item => item.action === 'read')).toHaveLength(1);
  });

  it('uses semantic claim IDs while preserving canonical permission filtering', async () => {
    const brain = new GovernedBrain();
    const semantic = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-semantic', classification: 'internal', kind: 'decision', content: 'Use durable execution', sourceRefs: ['receipt.semantic'], confidence: 1 }, 'owner');
    brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-semantic', classification: 'private', kind: 'note', content: 'Private unrelated detail', sourceRefs: ['receipt.private'], confidence: 1 }, 'owner');
    const hits = await brain.searchSemantic('project-semantic', 'durability architecture', 'owner', 'internal', 2, {
      async search() { return [{ claimId: semantic.id, score: 0.91 }]; },
    });
    expect(hits.map(claim => claim.id)).toEqual([semantic.id]);
    expect(brain.auditLog().filter(item => item.action === 'read')).toHaveLength(1);
  });

  it('falls back to lexical retrieval when the derived semantic index is unavailable', async () => {
    const brain = new GovernedBrain();
    const claim = brain.addClaim({ owner: 'owner', scope: 'project', scopeRef: 'project-fallback', classification: 'internal', kind: 'decision', content: 'Use durable recovery', sourceRefs: ['receipt.fallback'], confidence: 1 }, 'owner');
    const hits = await brain.searchSemantic('project-fallback', 'durable recovery', 'owner', 'internal', 2, {
      async search() { throw new Error('embedding provider unavailable'); },
    });
    expect(hits.map(item => item.id)).toEqual([claim.id]);
  });
});

describe('model routing port', () => {
  it('records a deterministic model decision from catalog data', () => {
    const decision = selectModel([{ model: 'cheap', provider: 'p1', endpoint: 'https://p1.example', capabilities: ['planning'], outputPricePerMillion: 1 }, { model: 'strong', provider: 'p2', endpoint: 'https://p2.example', capabilities: ['planning'], outputPricePerMillion: 2 }], { capability: 'planning', privacy: 'internal' });
    expect(decision.selected.model).toBe('cheap');
    expect(decision.candidates).toHaveLength(2);
    expect(() => selectModel([{ model: 'public-only', provider: 'p1', endpoint: 'https://p1.example', capabilities: ['planning'], contextTokens: 1000, privateDataAllowed: false }], { capability: 'planning', privacy: 'private', minContextTokens: 2000 })).toThrow('No model');
  });
});
