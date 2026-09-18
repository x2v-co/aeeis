import { describe, expect, it } from 'vitest';
import { GovernedBrain } from '../src/brain.js';
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
});

describe('model routing port', () => {
  it('records a deterministic model decision from catalog data', () => {
    const decision = selectModel([{ model: 'cheap', provider: 'p1', endpoint: 'https://p1.example', capabilities: ['planning'], outputPricePerMillion: 1 }, { model: 'strong', provider: 'p2', endpoint: 'https://p2.example', capabilities: ['planning'], outputPricePerMillion: 2 }], { capability: 'planning', privacy: 'internal' });
    expect(decision.selected.model).toBe('cheap');
    expect(decision.candidates).toHaveLength(2);
    expect(() => selectModel([{ model: 'public-only', provider: 'p1', endpoint: 'https://p1.example', capabilities: ['planning'], contextTokens: 1000, privateDataAllowed: false }], { capability: 'planning', privacy: 'private', minContextTokens: 2000 })).toThrow('No model');
  });
});
