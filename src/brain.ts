import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const classification = z.enum(['public', 'internal', 'confidential', 'private']);
const scope = z.enum(['identity', 'project', 'room', 'task', 'session']);
const id = z.string().regex(/^brain_[a-f0-9-]{36}$/);
const claimSchema = z.object({
  schemaVersion: z.literal(1), id, owner: z.string().min(1).max(200), scope, scopeRef: z.string().min(1).max(200),
  classification, kind: z.enum(['fact', 'decision', 'preference', 'note']), content: z.string().min(1).max(30000),
  sourceRefs: z.array(z.string().max(200)).max(100), confidence: z.number().min(0).max(1), version: z.number().int().positive(),
  state: z.enum(['active', 'retracted']), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type BrainClaim = z.infer<typeof claimSchema>;
export interface BrainGrant { id: string; subject: string; scopeRef: string; classifications: Array<z.infer<typeof classification>>; actions: Array<'read' | 'write' | 'retract'>; expiresAt: string; revokedAt?: string; }

export class GovernedBrain {
  private claims = new Map<string, BrainClaim[]>();
  private grants = new Map<string, BrainGrant>();
  addClaim(input: Omit<BrainClaim, 'schemaVersion' | 'id' | 'version' | 'state' | 'createdAt' | 'updatedAt'>, actor: string): BrainClaim {
    this.assertGrant(actor, input.scopeRef, input.classification, 'write');
    const at = new Date().toISOString(); const history = this.claims.get(input.scopeRef) ?? [];
    const claim = claimSchema.parse({ ...input, schemaVersion: 1, id: 'brain_' + randomUUID(), version: history.length + 1, state: 'active', createdAt: at, updatedAt: at });
    this.claims.set(input.scopeRef, [...history, claim]); return claim;
  }
  grant(input: Omit<BrainGrant, 'id'>, issuer: string): BrainGrant {
    if (issuer !== 'owner') throw new Error('Only the owner can issue Brain grants');
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error('Grant must expire in the future');
    const value = { ...input, id: 'grant_' + randomUUID() }; this.grants.set(value.id, value); return value;
  }
  revoke(grantId: string, issuer: string): void {
    if (issuer !== 'owner') throw new Error('Only the owner can revoke Brain grants');
    const grant = this.grants.get(grantId); if (!grant) throw new Error('Grant not found');
    grant.revokedAt = new Date().toISOString();
  }
  read(scopeRef: string, actor: string, classificationLimit: BrainGrant['classifications'][number] = 'internal'): BrainClaim[] {
    this.assertGrant(actor, scopeRef, classificationLimit, 'read');
    return structuredClone((this.claims.get(scopeRef) ?? []).filter(claim => claim.state === 'active' && rank(claim.classification) <= rank(classificationLimit)));
  }
  retract(scopeRef: string, claimId: string, actor: string): void {
    this.assertGrant(actor, scopeRef, 'private', 'retract');
    const claim = (this.claims.get(scopeRef) ?? []).find(item => item.id === claimId); if (!claim) throw new Error('Claim not found');
    claim.state = 'retracted'; claim.updatedAt = new Date().toISOString();
  }
  export(scopeRef: string, actor: string): BrainClaim[] { return this.read(scopeRef, actor, 'private'); }
  private assertGrant(actor: string, scopeRef: string, level: BrainGrant['classifications'][number], action: BrainGrant['actions'][number]): void {
    if (actor === 'owner') return;
    const valid = [...this.grants.values()].some(grant => grant.subject === actor && grant.scopeRef === scopeRef && !grant.revokedAt && new Date(grant.expiresAt).getTime() > Date.now() && grant.actions.includes(action) && grant.classifications.some(item => rank(item) >= rank(level)));
    if (!valid) throw new Error('Brain grant does not permit this operation');
  }
}
function rank(value: BrainGrant['classifications'][number]): number { return { public: 0, internal: 1, confidential: 2, private: 3 }[value]; }
export function claimDigest(claim: BrainClaim): string { return createHash('sha256').update(JSON.stringify(claim)).digest('hex'); }
