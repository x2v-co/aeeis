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
export interface BrainAudit { tenantId?: string | undefined; owner?: string | undefined; id: string; at: string; actor: string; action: 'write' | 'read' | 'grant' | 'revoke' | 'retract' | 'export' | 'import' | 'delete'; scopeRef?: string | undefined; ref?: string | undefined; contentHash?: string | undefined }
export interface BrainState { schemaVersion: 1; claims: BrainClaim[]; grants: BrainGrant[]; audit: BrainAudit[] }
const brainAuditSchema = z.object({ tenantId: z.string().max(200).optional(), owner: z.string().max(200).optional(), id: z.string().min(1).max(200), at: z.string().datetime({ offset: true }), actor: z.string().min(1).max(200), action: z.enum(['write', 'read', 'grant', 'revoke', 'retract', 'export', 'import', 'delete']), scopeRef: z.string().max(200).optional(), ref: z.string().max(200).optional(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const brainStateSchema = z.object({ schemaVersion: z.literal(1), claims: z.array(claimSchema).max(100000), grants: z.array(brainGrantSchema).max(10000), audit: z.array(brainAuditSchema).max(200000) }).strict();

/** A portable, permission-scoped Brain transfer. Grants and audit history are
 * deliberately excluded: importing a bundle must never mint authority or
 * rewrite the destination's canonical audit log. */
export const brainBundleSchema = z.object({
  schemaVersion: z.literal('aeeis-brain-bundle/1'),
  exportedAt: z.string().datetime({ offset: true }),
  owner: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200),
  scopeRef: z.string().min(1).max(200),
  claims: z.array(claimSchema).max(100000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type BrainBundle = z.infer<typeof brainBundleSchema>;

export class BrainAccessDenied extends Error {}
export class BrainConflict extends Error {}
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
  /** Deterministic, permission-checked retrieval for long-running Runs. The
   * semantic source remains the Brain claim history; this is only a bounded
   * lexical index that can be rebuilt from it later. */
  search(scopeRef: string, query: string, actor: Principal | string, classificationLimit: BrainGrant['classifications'][number] = 'internal', maxItems = 20, resourceOwner?: string): BrainClaim[] {
    const principal = brainActor(actor);
    const owner = resourceOwner ?? (typeof actor === 'string' ? 'owner' : principal.id);
    brainClassificationSchema.parse(classificationLimit);
    if (!query.trim()) throw new Error('Brain search query is required');
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new Error('Brain search maxItems must be an integer from 1 to 100');
    this.assertGrant(principal, owner, principal.tenantId, scopeRef, classificationLimit, 'read');
    const result = this.lexicalSearch(owner, principal.tenantId, scopeRef, query, classificationLimit, maxItems);
    this.record('read', principal, owner, scopeRef); return structuredClone(result);
  }
  /**
   * Uses a derived semantic index when available, while retaining the same
   * grant checks and canonical claim filtering as lexical retrieval. A stale,
   * unavailable, or malformed derived index never blocks a Brain read.
   */
  async searchSemantic(scopeRef: string, query: string, actor: Principal | string, classificationLimit: BrainGrant['classifications'][number] = 'internal', maxItems = 20, searcher?: BrainSemanticSearcher, resourceOwner?: string): Promise<BrainClaim[]> {
    const principal = brainActor(actor);
    const owner = resourceOwner ?? (typeof actor === 'string' ? 'owner' : principal.id);
    brainClassificationSchema.parse(classificationLimit);
    if (!query.trim()) throw new Error('Brain search query is required');
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new Error('Brain search maxItems must be an integer from 1 to 100');
    this.assertGrant(principal, owner, principal.tenantId, scopeRef, classificationLimit, 'read');
    const lexical = () => this.lexicalSearch(owner, principal.tenantId, scopeRef, query, classificationLimit, maxItems);
    let result: BrainClaim[];
    if (!searcher) result = lexical();
    else {
      try {
        const hits = await searcher.search({ owner, tenantId: principal.tenantId, scopeRef, classificationLimit, query, maxItems });
        if (!Array.isArray(hits) || hits.length > maxItems) throw new Error('Brain semantic index returned an invalid result set');
        const seen = new Set<string>();
        const claims = this.claims.get(this.key(owner, principal.tenantId, scopeRef)) ?? [];
        const byId = new Map(claims.filter(claim => claim.state === 'active' && rank(claim.classification) <= rank(classificationLimit)).map(claim => [claim.id, claim]));
        const semantic: BrainClaim[] = [];
        for (const hit of hits) {
          if (!hit || typeof hit.claimId !== 'string' || !Number.isFinite(hit.score) || hit.score < 0 || hit.score > 1 || seen.has(hit.claimId)) throw new Error('Brain semantic index returned an invalid hit');
          seen.add(hit.claimId);
          const claim = byId.get(hit.claimId);
          if (claim) semantic.push(claim);
        }
        result = semantic.length > 0 || claims.length === 0 ? semantic : lexical();
      } catch {
        result = lexical();
      }
    }
    this.record('read', principal, owner, scopeRef); return structuredClone(result);
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
  /** Export the complete claim history for migration. Unlike read/export,
   * this includes retracted claims so a restore cannot silently resurrect
   * knowledge that was deliberately withdrawn. */
  exportHistory(scopeRef: string, actor: Principal | string, resourceOwner?: string): BrainClaim[] {
    const principal = brainActor(actor);
    const owner = resourceOwner ?? (typeof actor === 'string' ? 'owner' : principal.id);
    const history = this.claims.get(this.key(owner, principal.tenantId, scopeRef)) ?? [];
    const highestClassification = history.reduce<BrainClaim['classification']>((highest, claim) => rank(claim.classification) > rank(highest) ? claim.classification : highest, 'public');
    this.assertGrant(principal, owner, principal.tenantId, scopeRef, highestClassification, 'read');
    this.record('export', principal, owner, scopeRef);
    return structuredClone(history);
  }
  /** Merge a previously exported bundle into the same owner's scope. The
   * operation is idempotent by claim id, rejects conflicting replays, and
   * appends imported history without allowing the bundle to overwrite local
   * claims, grants, or audit entries. */
  importBundle(input: unknown, actor: Principal | string): { imported: number; skipped: number; contentHash: string } {
    const bundle = brainBundleSchema.parse(input);
    const principal = brainActor(actor);
    if (!principal.roles.includes('owner') || principal.id !== bundle.owner || principal.tenantId !== bundle.tenantId) throw new BrainAccessDenied('Only the bundle owner can import this Brain bundle');
    const expectedHash = brainBundleContentHash(bundle.claims);
    if (bundle.contentHash !== expectedHash) throw new BrainConflict('Brain bundle content hash does not match its claims');
    const destinationKey = this.key(principal.id, principal.tenantId, bundle.scopeRef);
    // Work on a copy until every claim has passed validation. A malformed
    // later claim must not partially mutate the in-memory canonical state.
    const history = [...(this.claims.get(destinationKey) ?? [])];
    const byId = new Map<string, BrainClaim>();
    for (const claims of this.claims.values()) for (const claim of claims) byId.set(claim.id, claim);
    let imported = 0;
    let skipped = 0;
    let nextVersion = history.length + 1;
    for (const incoming of bundle.claims) {
      if (incoming.owner !== bundle.owner || incoming.tenantId !== bundle.tenantId || incoming.scopeRef !== bundle.scopeRef) throw new BrainConflict('Brain bundle claim is outside its declared owner, tenant, or scope');
      const existing = byId.get(incoming.id);
      if (existing) {
        if (claimDigest(existing) !== claimDigest(incoming) && claimImportDigest(existing) !== claimImportDigest(incoming)) throw new BrainConflict(`Brain bundle claim ${incoming.id} conflicts with existing history`);
        skipped += 1;
        continue;
      }
      this.assertGrant(principal, incoming.owner, incoming.tenantId, incoming.scopeRef, incoming.classification, 'write');
      const claim = claimSchema.parse({ ...incoming, version: nextVersion++, updatedAt: new Date().toISOString() });
      history.push(claim);
      byId.set(claim.id, claim);
      imported += 1;
    }
    if (imported > 0) this.claims.set(destinationKey, history);
    this.record('import', principal, principal.id, bundle.scopeRef, bundle.contentHash);
    return { imported, skipped, contentHash: bundle.contentHash };
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
  private lexicalSearch(owner: string, tenantId: string, scopeRef: string, query: string, classificationLimit: BrainGrant['classifications'][number], maxItems: number): BrainClaim[] {
    const terms = tokenize(query);
    return (this.claims.get(this.key(owner, tenantId, scopeRef)) ?? [])
      .filter(claim => claim.state === 'active' && rank(claim.classification) <= rank(classificationLimit))
      .map(claim => {
        const haystack = tokenize(`${claim.kind} ${claim.content} ${claim.sourceRefs.join(' ')}`);
        const matched = terms.filter(term => haystack.includes(term));
        return { claim, score: terms.length === 0 ? 1 : matched.length / terms.length };
      })
      .filter(item => terms.length === 0 || item.score > 0)
      .sort((left, right) => right.score - left.score || right.claim.updatedAt.localeCompare(left.claim.updatedAt) || left.claim.id.localeCompare(right.claim.id))
      .slice(0, maxItems)
      .map(item => item.claim);
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
function claimImportDigest(claim: BrainClaim): string {
  const { version: _version, updatedAt: _updatedAt, ...stable } = claim;
  return createHash('sha256').update(JSON.stringify(canonicalize(stable))).digest('hex');
}
function digestContent(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function tokenize(value: string): string[] { return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(term => term.length > 1))]; }
export function brainBundleContentHash(claims: BrainClaim[]): string { return createHash('sha256').update(JSON.stringify(canonicalize(claims))).digest('hex'); }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonicalize(nested)]));
  return value;
}

export interface BrainPersistence {
  init(): Promise<void>;
  load(): Promise<GovernedBrain>;
  save(brain: GovernedBrain): Promise<void>;
  close(): Promise<void>;
}

/** Embeddings are an optional, replaceable index capability. Brain claims and
 * their audit history remain the canonical source of truth. */
export interface BrainEmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  /** Optional read-only provider probe. Implementations must not call embed(). */
  health?(): Promise<{ ready: boolean; detail: string; checkedAt?: string }>;
}

export interface BrainSemanticSearchRequest {
  owner: string;
  tenantId: string;
  scopeRef: string;
  classificationLimit: BrainClaim['classification'];
  query: string;
  maxItems: number;
}

export interface BrainSemanticHit { claimId: string; score: number }

export interface BrainSemanticSearcher {
  search(request: BrainSemanticSearchRequest): Promise<BrainSemanticHit[]>;
}

/** Optional operator maintenance surface for a replaceable semantic index.
 * The canonical Brain state remains outside this interface; rebuilding may be
 * repeated or skipped without changing claims or their audit history. */
export interface BrainSemanticIndexMaintenance extends BrainSemanticSearcher {
  reconcile(claims: BrainClaim[]): Promise<void>;
  close(): Promise<void>;
  /** Optional read-only database + embedding dependency probe. */
  health?(): Promise<{ ready: boolean; detail: string; checkedAt?: string }>;
  readonly model?: string;
  readonly dimensions?: number;
}

export class FileBrainStore implements BrainPersistence {
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
