import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { brainActor, isOwnedBy, type Principal } from './security/principal.js';

export const brainClassificationSchema = z.enum(['public', 'internal', 'confidential', 'private']);
const scope = z.enum(['identity', 'project', 'room', 'task', 'session']);
const id = z.string().regex(/^brain_[a-f0-9-]{36}$/);
const claimSchema = z.object({
  schemaVersion: z.literal(1), id, tenantId: z.string().min(1).max(200).optional(), owner: z.string().min(1).max(200), scope, scopeRef: z.string().min(1).max(200),
  classification: brainClassificationSchema, kind: z.enum(['fact', 'decision', 'preference', 'note']), content: z.string().min(1).max(30000),
  sourceRefs: z.array(z.string().max(200)).max(100), confidence: z.number().min(0).max(1), version: z.number().int().positive(),
  state: z.enum(['active', 'retracted']), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const brainClaimInputSchema = claimSchema.omit({ schemaVersion: true, id: true, version: true, state: true, createdAt: true, updatedAt: true });
export type BrainClaim = z.infer<typeof claimSchema>;
export const brainGrantInputSchema = z.object({ subject: z.string().min(1).max(200), scopeRef: z.string().min(1).max(200), classifications: z.array(brainClassificationSchema).min(1).max(4), actions: z.array(z.enum(['read', 'write', 'retract'])).min(1).max(3), expiresAt: z.string().datetime({ offset: true }) }).strict();
export const brainGrantSchema = brainGrantInputSchema.extend({ owner: z.string().min(1).max(200).optional(), tenantId: z.string().min(1).max(200).optional(), id: z.string().regex(/^grant_[a-f0-9-]{36}$/), revokedAt: z.string().datetime({ offset: true }).optional() }).strict();
export type BrainGrant = z.infer<typeof brainGrantSchema>;
export interface BrainAudit { tenantId?: string | undefined; owner?: string | undefined; id: string; at: string; actor: string; action: 'write' | 'read' | 'grant' | 'revoke' | 'retract' | 'export' | 'delete'; scopeRef?: string | undefined; ref?: string | undefined; contentHash?: string | undefined }
export interface BrainState { schemaVersion: 1; claims: BrainClaim[]; grants: BrainGrant[]; audit: BrainAudit[] }
const brainAuditSchema = z.object({ tenantId: z.string().max(200).optional(), owner: z.string().max(200).optional(), id: z.string().min(1).max(200), at: z.string().datetime({ offset: true }), actor: z.string().min(1).max(200), action: z.enum(['write', 'read', 'grant', 'revoke', 'retract', 'export', 'delete']), scopeRef: z.string().max(200).optional(), ref: z.string().max(200).optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const brainStateSchema = z.object({ schemaVersion: z.literal(1), claims: z.array(claimSchema).max(100000), grants: z.array(brainGrantSchema).max(10000), audit: z.array(brainAuditSchema).max(200000) }).strict();

export class BrainAccessDenied extends Error {}
export class GovernedBrain {
  private claims = new Map<string, BrainClaim[]>();
  private grants = new Map<string, BrainGrant>();
  private audit: BrainAudit[] = [];
  private key(owner: string, tenantId: string, scopeRef: string): string { return JSON.stringify([tenantId, owner, scopeRef]); }

  addClaim(input: z.input<typeof brainClaimInputSchema>, actor: Principal | string): BrainClaim {
    const principal = brainActor(actor);
    const parsed = brainClaimInputSchema.parse(input);
    const tenantId = parsed.tenantId ?? principal.tenantId;
    this.assertGrant(principal, parsed.owner, tenantId, parsed.scopeRef, parsed.classification, 'write');
    const at = new Date().toISOString();
    const key = this.key(parsed.owner, tenantId, parsed.scopeRef);
    const history = this.claims.get(key) ?? [];
    const claim = claimSchema.parse({ ...parsed, tenantId, schemaVersion: 1, id: 'brain_' + randomUUID(), version: history.length + 1, state: 'active', createdAt: at, updatedAt: at });
    this.claims.set(key, [...history, claim]);
    this.record('write', principal, parsed.owner, parsed.scopeRef, claim.id, claim);
    return structuredClone(claim);
  }
  grant(input: z.input<typeof brainGrantInputSchema>, actor: Principal | string): BrainGrant {
    const principal = brainActor(actor);
    if (!principal.roles.includes('owner')) throw new BrainAccessDenied('Only the owner can issue Brain grants');
    const parsed = brainGrantInputSchema.parse(input);
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) throw new Error('Grant must expire in the future');
    // The issuer can grant only its own tenant/owner namespace. Request data
    // cannot change the grant's resource owner or give it cross-tenant scope.
    const value = brainGrantSchema.parse({ ...parsed, owner: principal.id, tenantId: principal.tenantId, id: 'grant_' + randomUUID() });
    this.grants.set(value.id, value); this.record('grant', principal, principal.id, parsed.scopeRef, value.id);
    return structuredClone(value);
  }
  revoke(grantId: string, actor: Principal | string): void {
    const principal = brainActor(actor);
    const grant = this.grants.get(grantId);
    if (!principal.roles.includes('owner') || !grant || !isOwnedBy(grant, { owner: principal.id, tenantId: principal.tenantId })) throw new BrainAccessDenied('Brain grant does not permit this revocation');
    grant.revokedAt = new Date().toISOString(); this.record('revoke', principal, principal.id, grant.scopeRef, grant.id);
  }
  read(scopeRef: string, actor: Principal | string, classificationLimit: BrainGrant['classifications'][number] = 'internal', resourceOwner?: string): BrainClaim[] {
    const principal = brainActor(actor);
    // Preserve the legacy external-agent API, whose grants referred to local owner.
    const owner = resourceOwner ?? (typeof actor === 'string' ? 'owner' : principal.id);
    brainClassificationSchema.parse(classificationLimit);
    this.assertGrant(principal, owner, principal.tenantId, scopeRef, classificationLimit, 'read');
    const result = structuredClone((this.claims.get(this.key(owner, principal.tenantId, scopeRef)) ?? []).filter(claim => claim.state === 'active' && rank(claim.classification) <= rank(classificationLimit)));
    this.record('read', principal, owner, scopeRef); return result;
  }
  retract(scopeRef: string, claimId: string, actor: Principal | string, resourceOwner?: string): void {
    const principal = brainActor(actor);
    const owner = resourceOwner ?? (typeof actor === 'string' ? 'owner' : principal.id);
    const claim = (this.claims.get(this.key(owner, principal.tenantId, scopeRef)) ?? []).find(item => item.id === claimId);
    this.assertGrant(principal, owner, principal.tenantId, scopeRef, claim?.classification ?? 'private', 'retract');
    if (!claim) throw new Error('Claim not found');
    claim.state = 'retracted'; claim.updatedAt = new Date().toISOString(); this.record('retract', principal, owner, scopeRef, claim.id, claim);
  }
  export(scopeRef: string, actor: Principal | string, resourceOwner?: string): BrainClaim[] {
    const result = this.read(scopeRef, actor, 'private', resourceOwner);
    const principal = brainActor(actor);
    this.record('export', principal, resourceOwner ?? (typeof actor === 'string' ? 'owner' : principal.id), scopeRef); return result;
  }
  deleteScope(scopeRef: string, actor: Principal | string): void {
    const principal = brainActor(actor);
    if (!principal.roles.includes('owner')) throw new BrainAccessDenied('Only the owner can delete a Brain scope');
    this.claims.delete(this.key(principal.id, principal.tenantId, scopeRef));
    for (const [grantId, grant] of this.grants) if (grant.scopeRef === scopeRef && isOwnedBy(grant, { owner: principal.id, tenantId: principal.tenantId })) this.grants.delete(grantId);
    this.record('delete', principal, principal.id, scopeRef);
  }
  state(): BrainState { return structuredClone({ schemaVersion: 1 as const, claims: [...this.claims.values()].flat(), grants: [...this.grants.values()], audit: this.audit }); }
  auditLog(): BrainAudit[] { return structuredClone(this.audit); }
  static fromState(input: unknown): GovernedBrain {
    const state = brainStateSchema.parse(input);
    const brain = new GovernedBrain();
    for (const claim of state.claims) {
      const key = brain.key(claim.owner, claim.tenantId ?? 'local', claim.scopeRef);
      brain.claims.set(key, [...(brain.claims.get(key) ?? []), claim]);
    }
    for (const grant of state.grants) brain.grants.set(grant.id, grant);
    brain.audit = state.audit;
    return brain;
  }
  private record(action: BrainAudit['action'], actor: Principal, owner: string, scopeRef?: string, ref?: string, content?: { content: string }): void {
    this.audit.push({ id: 'brain_event_' + randomUUID(), at: new Date().toISOString(), actor: actor.id, tenantId: actor.tenantId, owner, action, ...(scopeRef ? { scopeRef } : {}), ...(ref ? { ref } : {}), ...(content ? { contentHash: digestContent(content.content) } : {}) });
  }
  private assertGrant(actor: Principal, owner: string, tenantId: string, scopeRef: string, level: BrainGrant['classifications'][number], action: BrainGrant['actions'][number]): void {
    if (actor.tenantId !== tenantId) throw new BrainAccessDenied('Brain grant does not permit cross-tenant access');
    if (actor.id === owner && actor.roles.includes('owner')) return;
    const valid = [...this.grants.values()].some(grant => isOwnedBy(grant, { owner, tenantId }) && grant.subject === actor.id && grant.scopeRef === scopeRef && !grant.revokedAt && new Date(grant.expiresAt).getTime() > Date.now() && grant.actions.includes(action) && grant.classifications.some(item => rank(item) >= rank(level)));
    if (!valid) throw new BrainAccessDenied('Brain grant does not permit this operation');
  }
}

function rank(value: BrainGrant['classifications'][number]): number { return { public: 0, internal: 1, confidential: 2, private: 3 }[value]; }
export function claimDigest(claim: BrainClaim): string { return createHash('sha256').update(JSON.stringify(claim)).digest('hex'); }
function digestContent(content: string): string { return createHash('sha256').update(content).digest('hex'); }

export class FileBrainStore {
  private lockPath: string;
  constructor(private readonly directory: string) { this.lockPath = join(directory, '.writer.lock'); }
  private statePath(): string { return join(this.directory, 'brain.json'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const lock = await open(this.lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Brain directory already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; await unlink(this.lockPath); return this.init(); }
    }
  }
  async load(): Promise<GovernedBrain> {
    try { return GovernedBrain.fromState(JSON.parse(await readFile(this.statePath(), 'utf8')) as BrainState); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new GovernedBrain(); throw error; }
  }
  async save(brain: GovernedBrain): Promise<void> {
    const path = this.statePath(), temporary = path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(JSON.stringify(brain.state())); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async close(): Promise<void> { await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
