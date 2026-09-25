import { expect, it } from 'vitest';
import { collaborationTriggerPolicySchema, type CollaborationTriggerDecision, type CollaborationTriggerStore } from '../../src/collaboration-triggers.js';

const scope = { owner: 'alice', tenantId: 'team-a' };
const origin = '2020-01-01T00:00:00.000Z';
const policy = () => collaborationTriggerPolicySchema.parse({
  schemaVersion: 1, id: 'policy.cooldown', ...scope, name: 'Review cooldown', enabled: true,
  eventTypes: ['review.completed'], action: { type: 'debate', participantAgentIds: ['agent.one'] },
  cooldownMs: 60_000, createdAt: origin, updatedAt: origin,
});
const decision = (suffix: string): CollaborationTriggerDecision => ({
  schemaVersion: 1, id: `trigger_${suffix}`, policyId: 'policy.cooldown', eventId: `event:${suffix}`,
  ...scope, state: 'started', actionType: 'debate', dispatchState: 'not_requested', startedAt: origin,
});

export function triggerClaimContract(open: () => Promise<{ stores: CollaborationTriggerStore[]; close(): Promise<void> }>) {
  it('atomically admits one event, preserves duplicates and rejects future-clock bypasses', async () => {
    const env = await open(); const [a, b = a] = env.stores;
    try {
      const p = policy(); await a!.createPolicy(p);
      const guard = { policy: p, occurredAt: new Date().toISOString() };
      const candidates = [decision('one'), decision('two')];
      const claims = await Promise.all([a!.claimForPolicy(candidates[0]!, guard), b!.claimForPolicy(candidates[1]!, guard)]);
      expect(claims.filter(item => item?.claimed)).toHaveLength(1);
      const winner = claims.find(item => item?.claimed)!;
      expect((await b!.claimForPolicy(winner.decision, guard))?.claimed).toBe(false);
      expect(await b!.claimForPolicy(decision('future'), { ...guard, occurredAt: '2999-01-01T00:00:00.000Z' })).toBeUndefined();
      await expect(b!.claimForPolicy({ ...winner.decision, owner: 'bob' }, guard)).rejects.toThrow('Unknown');
      expect(await a!.listDecisions(scope)).toHaveLength(1);
      // Admission uses the store clock, not caller-supplied startedAt.
      expect(Date.parse(winner.decision.startedAt)).toBeGreaterThan(Date.parse(origin));
    } finally { await env.close(); }
  });

  it('checks policy changes, disable and deletion at admission', async () => {
    const env = await open(); const a = env.stores[0]!;
    try {
      const p = policy(); await a.createPolicy(p);
      const guard = { policy: p, occurredAt: new Date().toISOString() };
      await a.updatePolicy(p.id, current => ({ ...current, cooldownMs: 120_000 }), scope);
      expect(await a.claimForPolicy(decision('changed'), guard)).toBeUndefined();
      const disabled = await a.updatePolicy(p.id, current => ({ ...current, enabled: false }), scope);
      expect(await a.claimForPolicy(decision('disabled'), { ...guard, policy: disabled })).toBeUndefined();
      await a.deletePolicy(p.id, scope);
      expect(await a.claimForPolicy(decision('deleted'), guard)).toBeUndefined();
      expect(await a.listDecisions(scope)).toEqual([]);
    } finally { await env.close(); }
  });

  it('does not consume the cooldown when a claim fails to persist', async () => {
    const env = await open(); const a = env.stores[0]!;
    try {
      const p = policy(); await a.createPolicy(p);
      // A collision outside this policy fails at persistence, after the
      // guarded admission checks. The transaction must release its lock.
      await a.claimDecision({ ...decision('collision'), policyId: 'policy.other' });
      const guard = { policy: p, occurredAt: new Date().toISOString() };
      await expect(a.claimForPolicy(decision('collision'), guard)).rejects.toThrow();
      expect((await a.claimForPolicy(decision('retry'), guard))?.claimed).toBe(true);
    } finally { await env.close(); }
  });

  it('admits the exact event-time boundary but does not replay stale events after wall-clock expiry', async () => {
    const env = await open(); const a = env.stores[0]!;
    try {
      const p = policy(); await a.createPolicy(p);
      await a.claimDecision(decision('old'));
      expect(await a.claimForPolicy(decision('stale'), { policy: p, occurredAt: '2020-01-01T00:00:59.999Z' })).toBeUndefined();
      expect((await a.claimForPolicy(decision('boundary'), { policy: p, occurredAt: '2020-01-01T00:01:00.000Z' }))?.claimed).toBe(true);
    } finally { await env.close(); }
  });

  it('releases a verified creation failure but keeps unknown dispatch inside the cooldown', async () => {
    const env = await open(); const a = env.stores[0]!;
    try {
      const p = policy(); await a.createPolicy(p);
      const guard = { policy: p, occurredAt: new Date().toISOString() };
      await a.claimForPolicy(decision('failed'), guard);
      await a.updateDecision('trigger_failed', current => ({ ...current, state: 'failed' }), scope);
      expect((await a.claimForPolicy(decision('unknown'), guard))?.claimed).toBe(true);
      await a.updateDecision('trigger_unknown', current => ({ ...current, state: 'triggered', dispatchState: 'unknown' }), scope);
      expect(await a.claimForPolicy(decision('blocked'), guard)).toBeUndefined();
      const other = { ...p, id: 'policy.independent' }; await a.createPolicy(other);
      expect((await a.claimForPolicy({ ...decision('independent'), policyId: other.id }, { ...guard, policy: other }))?.claimed).toBe(true);
    } finally { await env.close(); }
  });
}
