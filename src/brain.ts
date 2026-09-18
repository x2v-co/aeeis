import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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
export const brainClaimInputSchema = claimSchema.omit({ schemaVersion: true, id: true, version: true, state: true, createdAt: true, updatedAt: true });
export type BrainClaim = z.infer<typeof claimSchema>;
export interface BrainGrant { id: string; subject: string; scopeRef: string; classifications: Array<z.infer<typeof classification>>; actions: Array<'read' | 'write' | 'retract'>; expiresAt: string; revokedAt?: string; }
export interface BrainAudit { id: string; at: string; actor: string; action: 'write' | 'read' | 'grant' | 'revoke' | 'retract' | 'export' | 'delete'; scopeRef?: string; ref?: string; contentHash?: string }
export interface BrainState { schemaVersion: 1; claims: BrainClaim[]; grants: BrainGrant[]; audit: BrainAudit[] }

export class GovernedBrain {
  private claims = new Map<string, BrainClaim[]>();
  private grants = new Map<string, BrainGrant>();
  private audit: BrainAudit[] = [];
  addClaim(input: Omit<BrainClaim, 'schemaVersion' | 'id' | 'version' | 'state' | 'createdAt' | 'updatedAt'>, actor: string): BrainClaim {
    this.assertGrant(actor, input.scopeRef, input.classification, 'write');
    const at = new Date().toISOString(); const history = this.claims.get(input.scopeRef) ?? [];
    const claim = claimSchema.parse({ ...input, schemaVersion: 1, id: 'brain_' + randomUUID(), version: history.length + 1, state: 'active', createdAt: at, updatedAt: at });
    this.claims.set(input.scopeRef, [...history, claim]); this.record('write', actor, input.scopeRef, claim.id, claim); return claim;
  }
  grant(input: Omit<BrainGrant, 'id'>, issuer: string): BrainGrant {
    if (issuer !== 'owner') throw new Error('Only the owner can issue Brain grants');
    if (new Date(input.expiresAt).getTime() <= Date.now()) throw new Error('Grant must expire in the future');
    const value = { ...input, id: 'grant_' + randomUUID() }; this.grants.set(value.id, value); this.record('grant', issuer, input.scopeRef, value.id); return value;
  }
  revoke(grantId: string, issuer: string): void {
    if (issuer !== 'owner') throw new Error('Only the owner can revoke Brain grants');
    const grant = this.grants.get(grantId); if (!grant) throw new Error('Grant not found');
    grant.revokedAt = new Date().toISOString(); this.record('revoke', issuer, grant.scopeRef, grant.id);
  }
  read(scopeRef: string, actor: string, classificationLimit: BrainGrant['classifications'][number] = 'internal'): BrainClaim[] {
    this.assertGrant(actor, scopeRef, classificationLimit, 'read');
    const result = structuredClone((this.claims.get(scopeRef) ?? []).filter(claim => claim.state === 'active' && rank(claim.classification) <= rank(classificationLimit)));
    this.record('read', actor, scopeRef); return result;
  }
  retract(scopeRef: string, claimId: string, actor: string): void {
    this.assertGrant(actor, scopeRef, 'private', 'retract');
    const claim = (this.claims.get(scopeRef) ?? []).find(item => item.id === claimId); if (!claim) throw new Error('Claim not found');
    claim.state = 'retracted'; claim.updatedAt = new Date().toISOString(); this.record('retract', actor, scopeRef, claim.id, claim);
  }
  export(scopeRef: string, actor: string): BrainClaim[] { const result = this.read(scopeRef, actor, 'private'); this.record('export', actor, scopeRef); return result; }
  deleteScope(scopeRef: string, actor: string): void {
    if (actor !== 'owner') throw new Error('Only the owner can delete a Brain scope');
    this.claims.delete(scopeRef);
    for (const [grantId, grant] of this.grants) if (grant.scopeRef === scopeRef) this.grants.delete(grantId);
    this.record('delete', actor, scopeRef);
  }
  state(): BrainState { return structuredClone({ schemaVersion: 1 as const, claims: [...this.claims.values()].flat(), grants: [...this.grants.values()], audit: this.audit }); }
  auditLog(): BrainAudit[] { return structuredClone(this.audit); }
  static fromState(state: BrainState): GovernedBrain {
    const brain = new GovernedBrain();
    for (const claim of state.claims) brain.claims.set(claim.scopeRef, [...(brain.claims.get(claim.scopeRef) ?? []), claim]);
    for (const grant of state.grants) brain.grants.set(grant.id, grant);
    brain.audit = state.audit;
    return brain;
  }
  private record(action: BrainAudit['action'], actor: string, scopeRef?: string, ref?: string, content?: { content: string }): void {
    this.audit.push({ id: 'brain_event_' + randomUUID(), at: new Date().toISOString(), actor, action, ...(scopeRef ? { scopeRef } : {}), ...(ref ? { ref } : {}), ...(content ? { contentHash: digestContent(content.content) } : {}) });
  }
  private assertGrant(actor: string, scopeRef: string, level: BrainGrant['classifications'][number], action: BrainGrant['actions'][number]): void {
    if (actor === 'owner') return;
    const valid = [...this.grants.values()].some(grant => grant.subject === actor && grant.scopeRef === scopeRef && !grant.revokedAt && new Date(grant.expiresAt).getTime() > Date.now() && grant.actions.includes(action) && grant.classifications.some(item => rank(item) >= rank(level)));
    if (!valid) throw new Error('Brain grant does not permit this operation');
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
