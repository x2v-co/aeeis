import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import pg from 'pg';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import type { Ownership } from './security/principal.js';

function matchesScope(value: { owner?: string; tenantId?: string }, scope?: Ownership): boolean {
  return scope === undefined || (value.owner ?? 'owner') === scope.owner && (value.tenantId ?? 'local') === scope.tenantId;
}

// Every target has a versioned activation boundary. Text is acceptable for
// profile/prompt supplements; operational targets must contain a typed JSON
// payload before they can become active.
export const activationTargetSchema = z.enum(['profile', 'skill', 'prompt', 'workflow', 'tool-policy', 'model-policy']);
export type ActivationTarget = z.infer<typeof activationTargetSchema>;
export const baselineVersions: Record<ActivationTarget, string> = {
  profile: 'profile/1', skill: 'skill/1', prompt: 'prompt/1', workflow: 'workflow/1', 'tool-policy': 'tool-policy/1', 'model-policy': 'model-policy/1',
};
const identifier = z.string().trim().min(1).max(200);
const typedChangeSchemas: Partial<Record<ActivationTarget, z.ZodTypeAny>> = {
  skill: z.object({ methodId: identifier, version: identifier, runtime: identifier.optional() }).strict(),
  workflow: z.object({ maxModelCalls: z.number().int().min(3).max(100).optional(), maxTaskCount: z.number().int().min(1).max(100).optional(), retry: z.object({ maxAttempts: z.number().int().min(1).max(10), backoffSeconds: z.number().int().min(0).max(3600) }).strict().optional() }).strict(),
  'tool-policy': z.object({ allow: z.array(identifier).max(200), deny: z.array(identifier).max(200), requireApproval: z.array(identifier).max(200) }).strict(),
  'model-policy': z.object({ providers: z.array(identifier).max(100), models: z.array(identifier).max(100), maxOutputPricePerMillion: z.number().nonnegative().optional(), requireHealthProbe: z.boolean() }).strict(),
};
export type TypedEvolutionChange = z.infer<NonNullable<(typeof typedChangeSchemas)['skill']>> | z.infer<NonNullable<(typeof typedChangeSchemas)['workflow']>> | z.infer<NonNullable<(typeof typedChangeSchemas)['tool-policy']>> | z.infer<NonNullable<(typeof typedChangeSchemas)['model-policy']>>;
export function parseActivationChange(target: ActivationTarget, change: string): unknown {
  if (target === 'profile' || target === 'prompt') return change;
  let parsed: unknown;
  try { parsed = JSON.parse(change); } catch { throw new Error(`Evolution ${target} change must be valid JSON for typed activation`); }
  return typedChangeSchemas[target]!.parse(parsed);
}
const candidateId = z.string().regex(/^evo_[a-f0-9-]{36}$/);
const version = z.string().trim().min(1).max(200);
const activationSchema = z.object({
  schemaVersion: z.literal(1), owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'), target: activationTargetSchema, candidateId,
  baseVersion: version, version, change: z.string().min(1).max(8000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  activationRef: z.string().trim().min(1).max(200),
  activatedAt: z.string().datetime({ offset: true }),
  parentCandidateId: candidateId.optional(),
}).strict();
const historySchema = z.object({
  id: z.string().uuid(), action: z.enum(['activated', 'rolled_back']),
  target: activationTargetSchema, candidateId, version,
  restoredCandidateId: candidateId.optional(),
  reason: z.string().trim().min(1).max(4000), at: z.string().datetime({ offset: true }),
}).strict();
const trafficRouteId = z.string().regex(/^traffic_[a-f0-9-]{36}$/);
const trafficObservationSchema = z.object({
  id: z.string().trim().min(1).max(200), passed: z.boolean(), score: z.number().min(0).max(1),
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(100), recordedAt: z.string().datetime({ offset: true }),
}).strict();
const defaultTrafficSafety = { minScore: 0, maxFailedObservations: 1, autoPause: true } as const;
const trafficSafetySchema = z.object({
  minScore: z.number().min(0).max(1).default(defaultTrafficSafety.minScore),
  maxFailedObservations: z.number().int().min(1).max(100).default(defaultTrafficSafety.maxFailedObservations),
  autoPause: z.boolean().default(defaultTrafficSafety.autoPause),
}).strict().default(defaultTrafficSafety);
const trafficRouteSchema = z.object({
  schemaVersion: z.literal(1), id: trafficRouteId,
  owner: z.string().min(1).max(200).default('owner'), tenantId: z.string().min(1).max(200).default('local'),
  target: activationTargetSchema, candidateId, baseCandidateId: candidateId.optional(),
  baseVersion: version, version,
  // Optional for backwards compatibility with pre-traffic-canary state; all
  // newly created routes persist it and runtime selection validates it when present.
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  percentage: z.number().int().min(1).max(9999),
  status: z.enum(['active', 'paused', 'stopped']),
  rolloutRef: z.string().trim().min(1).max(200),
  safety: trafficSafetySchema,
  lastReason: z.string().trim().min(1).max(4000).optional(),
  observations: z.array(trafficObservationSchema).max(1000).default([]),
  startedAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const evolutionActivationStateSchema = z.object({
  releases: z.array(activationSchema).max(10000),
  active: z.array(candidateId).max(10000),
  revoked: z.array(candidateId).max(10000),
  traffic: z.array(trafficRouteSchema).max(10000).default([]),
  history: z.array(historySchema).max(20000),
}).strict();
export type ActiveEvolution = z.infer<typeof activationSchema>;
export type EvolutionActivationHistory = z.infer<typeof historySchema>;
export type EvolutionTrafficRoute = z.infer<typeof trafficRouteSchema>;
export type EvolutionTrafficObservation = z.infer<typeof trafficObservationSchema>;
export type EvolutionTrafficSafety = z.infer<typeof trafficSafetySchema>;
export interface EvolutionTrafficSelection {
  active: ActiveEvolution[];
  traffic: Array<{ routeId: string; target: ActivationTarget; candidateId: string; percentage: number; bucket: number; selected: boolean }>;
}
export interface EvolutionSnapshotProvider {
  listActive(scope?: Ownership): Promise<ActiveEvolution[]>;
  selectActive?(scope: Ownership, routingKey: string): Promise<ActiveEvolution[]>;
  selectActiveWithTraffic?(scope: Ownership, routingKey: string): Promise<EvolutionTrafficSelection>;
}
export interface EvolutionActivationStore {
  list(scope?: Ownership): Promise<ActiveEvolution[]>;
  history(scope?: Ownership): Promise<EvolutionActivationHistory[]>;
  listTraffic?(scope?: Ownership): Promise<EvolutionTrafficRoute[]>;
  startTraffic?(input: Pick<EvolutionTrafficRoute, 'target' | 'candidateId' | 'baseCandidateId' | 'baseVersion' | 'version' | 'contentHash' | 'percentage' | 'rolloutRef'> & Partial<Pick<EvolutionTrafficRoute, 'owner' | 'tenantId' | 'safety'>>): Promise<EvolutionTrafficRoute>;
  updateTraffic?(candidateId: string, percentage: number, rolloutRef: string, scope?: Ownership): Promise<EvolutionTrafficRoute>;
  pauseTraffic?(candidateId: string, reason: string, scope?: Ownership): Promise<EvolutionTrafficRoute>;
  resumeTraffic?(candidateId: string, rolloutRef: string, scope?: Ownership): Promise<EvolutionTrafficRoute>;
  stopTraffic?(candidateId: string, reason: string, scope?: Ownership): Promise<EvolutionTrafficRoute>;
  recordTraffic?(candidateId: string, observation: EvolutionTrafficObservation, scope?: Ownership): Promise<EvolutionTrafficRoute>;
  activate(input: Pick<ActiveEvolution, 'target' | 'candidateId' | 'baseVersion' | 'version' | 'change' | 'activationRef'> & Partial<Pick<ActiveEvolution, 'owner' | 'tenantId'>>): Promise<ActiveEvolution>;
  revoke(candidateId: string, reason: string, scope?: Ownership): Promise<void>;
  close(): Promise<void>;
}
export function evolutionContentHash(value: Pick<ActiveEvolution, 'target' | 'version' | 'change'>): string {
  return createHash('sha256').update(JSON.stringify([value.target, value.version, value.change])).digest('hex');
}

type ActivationState = z.infer<typeof evolutionActivationStateSchema>;

function assertTrafficBase(state: ActivationState, route: EvolutionTrafficRoute): void {
  const base = state.releases.find(release => state.active.includes(release.candidateId) && release.target === route.target && matchesScope(release, route));
  if (!base || base.candidateId !== route.baseCandidateId || base.version !== route.baseVersion) throw new Error('Traffic canary base version conflict');
  if (state.revoked.includes(route.candidateId)) throw new Error('Revoked candidate cannot enter traffic canary');
}
function assertTrafficRevokeScope(state: ActivationState, id: string, scope?: Ownership): void {
  if (state.traffic.some(route => (route.candidateId === id || route.baseCandidateId === id) && !matchesScope(route, scope))) throw new Error('Unknown evolution candidate');
}
function stopAffectedTraffic(state: ActivationState, affected: (route: EvolutionTrafficRoute) => boolean, reason: string): void {
  for (const route of state.traffic) {
    if (route.status !== 'stopped' && affected(route)) {
      route.status = 'stopped'; route.lastReason = reason; route.updatedAt = new Date().toISOString();
    }
  }
}

function applyTrafficObservation(route: EvolutionTrafficRoute, observation: EvolutionTrafficObservation): EvolutionTrafficRoute {
  const observations = [...route.observations, observation];
  const failures = observations.filter(item => !item.passed || item.score < route.safety.minScore).length;
  const shouldPause = route.status === 'active' && route.safety.autoPause && failures >= route.safety.maxFailedObservations;
  return trafficRouteSchema.parse({
    ...route,
    observations,
    ...(shouldPause ? { status: 'paused', lastReason: `Automatic pause: traffic observation ${observation.id} failed the canary safety policy` } : {}),
    updatedAt: new Date().toISOString(),
  });
}

/** Active pointers, immutable releases and rollback receipts commit in one file.
 * A dedicated writer lock prevents lost updates across processes/instances. */
export class FileEvolutionActivationStore implements EvolutionActivationStore {
  private readonly path: string;
  private readonly lockPath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private opened = false;
  constructor(private readonly directory: string) {
    this.path = join(directory, 'activations.json'); this.lockPath = join(directory, '.activation-writer.lock');
  }
  async init(): Promise<void> {
    if (this.opened) throw new Error('Activation store already initialized');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      try { await lock.writeFile(String(process.pid)); } finally { await lock.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid activation writer lock');
      try { process.kill(pid, 0); }
      catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        await unlink(this.lockPath); return this.init();
      }
      throw new Error('Activation directory already has a live writer');
    }
    this.opened = true;
    try {
      try { await this.load(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.save({ releases: [], active: [], revoked: [], traffic: [], history: [] });
      }
    } catch (error) { await this.close(); throw error; }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.opened) return Promise.reject(new Error('Activation store is closed'));
    const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next;
  }
  private async load(): Promise<z.infer<typeof evolutionActivationStateSchema>> {
    if (!this.opened) throw new Error('Activation store is closed');
    return evolutionActivationStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
  }
  private async save(input: z.infer<typeof evolutionActivationStateSchema>): Promise<void> {
    const state = evolutionActivationStateSchema.parse(input);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
      const dir = await open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  async list(scope?: Ownership): Promise<ActiveEvolution[]> {
    const state = await this.load();
    return state.active.map(id => {
      const release = state.releases.find(item => item.candidateId === id);
      if (!release || state.revoked.includes(id) || release.contentHash !== evolutionContentHash(release)) throw new Error('Invalid active evolution pointer');
      return release;
    }).filter(release => matchesScope(release, scope)).sort((a, b) => a.target.localeCompare(b.target));
  }
  async history(scope?: Ownership): Promise<EvolutionActivationHistory[]> {
    const state = await this.load();
    if (scope === undefined) return state.history;
    const owned = new Set(state.releases.filter(release => matchesScope(release, scope)).map(release => release.candidateId));
    return state.history.filter(item => owned.has(item.candidateId));
  }
  async listTraffic(scope?: Ownership): Promise<EvolutionTrafficRoute[]> {
    const state = await this.load();
    return state.traffic.filter(route => matchesScope(route, scope)).map(route => structuredClone(route));
  }
  startTraffic(input: Pick<EvolutionTrafficRoute, 'target' | 'candidateId' | 'baseCandidateId' | 'baseVersion' | 'version' | 'contentHash' | 'percentage' | 'rolloutRef'> & Partial<Pick<EvolutionTrafficRoute, 'owner' | 'tenantId' | 'safety'>>): Promise<EvolutionTrafficRoute> {
    return this.serial(async () => {
      const state = await this.load();
      const now = new Date().toISOString();
      const route = trafficRouteSchema.parse({ ...input, schemaVersion: 1, id: `traffic_${randomUUID()}`, status: 'active', startedAt: now, updatedAt: now });
      if (state.traffic.some(item => item.status !== 'stopped' && item.id !== route.id && item.target === route.target && item.owner === route.owner && item.tenantId === route.tenantId)) throw new Error('An active traffic canary already exists for this target');
      assertTrafficBase(state, route);
      state.traffic.push(route); await this.save(state); return structuredClone(route);
    });
  }
  updateTraffic(candidateIdValue: string, percentage: number, rolloutRef: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.serial(async () => {
      candidateId.parse(candidateIdValue); const validatedPercentage = z.number().int().min(1).max(9999).parse(percentage); const validatedRef = z.string().trim().min(1).max(200).parse(rolloutRef);
      const state = await this.load(); const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status === 'active');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown traffic canary');
      const next = trafficRouteSchema.parse({ ...state.traffic[index]!, percentage: validatedPercentage, rolloutRef: validatedRef, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; await this.save(state); return structuredClone(next);
    });
  }
  stopTraffic(candidateIdValue: string, reason: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.serial(async () => {
      candidateId.parse(candidateIdValue); const validatedReason = z.string().trim().min(1).max(4000).parse(reason);
      const state = await this.load(); const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status !== 'stopped');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown traffic canary');
      const next = trafficRouteSchema.parse({ ...state.traffic[index]!, status: 'stopped', lastReason: validatedReason, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; await this.save(state); return structuredClone(next);
    });
  }
  recordTraffic(candidateIdValue: string, observation: EvolutionTrafficObservation, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.serial(async () => {
      candidateId.parse(candidateIdValue); const validated = trafficObservationSchema.parse(observation);
      const state = await this.load(); const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status !== 'stopped');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown traffic canary');
      const route = state.traffic[index]!;
      if (route.observations.some(item => item.id === validated.id)) throw new Error('Traffic observation already exists');
      const next = applyTrafficObservation(route, validated);
      state.traffic[index] = next; await this.save(state); return structuredClone(next);
    });
  }
  pauseTraffic(candidateIdValue: string, reason: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.serial(async () => {
      candidateId.parse(candidateIdValue); const validatedReason = z.string().trim().min(1).max(4000).parse(reason);
      const state = await this.load(); const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status === 'active');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown active traffic canary');
      const next = trafficRouteSchema.parse({ ...state.traffic[index]!, status: 'paused', lastReason: validatedReason, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; await this.save(state); return structuredClone(next);
    });
  }
  resumeTraffic(candidateIdValue: string, rolloutRef: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.serial(async () => {
      candidateId.parse(candidateIdValue); const validatedRef = z.string().trim().min(1).max(200).parse(rolloutRef);
      const state = await this.load(); const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status === 'paused');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown paused traffic canary');
      const route = state.traffic[index]!;
      assertTrafficBase(state, route);
      if (state.traffic.some(item => item.status !== 'stopped' && item.id !== route.id && item.target === route.target && item.owner === route.owner && item.tenantId === route.tenantId)) throw new Error('An active traffic canary already exists for this target');
      const next = trafficRouteSchema.parse({ ...route, status: 'active', rolloutRef: validatedRef, lastReason: undefined, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; await this.save(state); return structuredClone(next);
    });
  }
  activate(input: Pick<ActiveEvolution, 'target' | 'candidateId' | 'baseVersion' | 'version' | 'change' | 'activationRef'> & Partial<Pick<ActiveEvolution, 'owner' | 'tenantId'>>): Promise<ActiveEvolution> {
    return this.serial(async () => {
      const state = await this.load();
      const release = activationSchema.parse({ ...input, schemaVersion: 1, contentHash: evolutionContentHash(input), activatedAt: new Date().toISOString() });
      if (state.revoked.includes(release.candidateId)) throw new Error('Revoked candidate cannot be reactivated');
      const existing = state.releases.find(item => item.candidateId === release.candidateId);
      if (existing) {
        if (state.active.includes(existing.candidateId) && existing.contentHash === release.contentHash && existing.baseVersion === release.baseVersion) return existing;
        throw new Error('Candidate has already been activated; create a new version');
      }
      const previous = state.releases.find(item => state.active.includes(item.candidateId) && item.target === release.target && item.owner === release.owner && item.tenantId === release.tenantId);
      const expected = previous?.version ?? baselineVersions[release.target];
      if (release.baseVersion !== expected) throw new Error(`Activation base version conflict: expected ${expected}`);
      if (release.version === baselineVersions[release.target] || state.releases.some(item => item.target === release.target && item.version === release.version && item.owner === release.owner && item.tenantId === release.tenantId)) throw new Error('Evolution version must be new and immutable');
      if (previous) release.parentCandidateId = previous.candidateId;
      state.releases.push(release);
      state.active = [...state.active.filter(id => id !== previous?.candidateId), release.candidateId];
      stopAffectedTraffic(state, route => route.target === release.target && matchesScope(route, release), 'Active release changed');
      state.history.push({ id: randomUUID(), action: 'activated', target: release.target, candidateId: release.candidateId, version: release.version, reason: release.activationRef, at: release.activatedAt });
      await this.save(state); return release;
    });
  }
  revoke(id: string, reason: string, scope?: Ownership): Promise<void> {
    return this.serial(async () => {
      candidateId.parse(id); z.string().trim().min(1).max(4000).parse(reason);
      const state = await this.load();
      if (state.revoked.includes(id)) return;
      const release = state.releases.find(item => item.candidateId === id);
      if (release && !matchesScope(release, scope)) throw new Error('Unknown evolution candidate');
      assertTrafficRevokeScope(state, id, scope);
      // Validate ownership before mutating the durable state. A failed
      // cross-tenant revoke must be observationally read-only, just like the
      // PostgreSQL transaction counterpart.
      stopAffectedTraffic(state, route => route.candidateId === id || route.baseCandidateId === id, reason);
      state.revoked.push(id);
      if (release) {
        let parent = release.parentCandidateId ? state.releases.find(item => item.candidateId === release.parentCandidateId) : undefined;
        while (parent && state.revoked.includes(parent.candidateId)) {
          const parentId = parent.parentCandidateId;
          parent = parentId ? state.releases.find(item => item.candidateId === parentId) : undefined;
        }
        if (state.active.includes(id)) {
          state.active = state.active.filter(value => value !== id);
          if (parent) state.active.push(parent.candidateId);
        }
        state.history.push({ id: randomUUID(), action: 'rolled_back', target: release.target, candidateId: id, version: release.version, ...(parent && state.active.includes(parent.candidateId) ? { restoredCandidateId: parent.candidateId } : {}), reason, at: new Date().toISOString() });
      }
      await this.save(state);
    });
  }
  async close(): Promise<void> {
    await this.queue;
    if (!this.opened) return;
    this.opened = false; await unlink(this.lockPath);
  }
}

/** PostgreSQL counterpart used when AEEIS runs with DATABASE_URL. The single
 * locked row makes activation pointer changes atomic across API instances. */
export class PostgresEvolutionActivationStore implements EvolutionActivationStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({ connectionString }); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'evolution-activation', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_evolution_activation (id text PRIMARY KEY, state jsonb NOT NULL)');
      await client.query(`INSERT INTO aeeis_evolution_activation(id,state) VALUES('singleton',$1) ON CONFLICT(id) DO NOTHING`, [{ releases: [], active: [], revoked: [], history: [] }]);
    });
  }
  private async read(client: pg.Pool | pg.PoolClient): Promise<z.infer<typeof evolutionActivationStateSchema>> {
    const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_evolution_activation WHERE id=$1', ['singleton']);
    if (!result.rows[0]) throw new Error('Evolution activation state is missing');
    return evolutionActivationStateSchema.parse(result.rows[0].state);
  }
  async list(scope?: Ownership): Promise<ActiveEvolution[]> {
    const state = await this.read(this.pool);
    return state.active.map(id => {
      const release = state.releases.find(item => item.candidateId === id);
      if (!release || state.revoked.includes(id) || release.contentHash !== evolutionContentHash(release)) throw new Error('Invalid active evolution pointer');
      return release;
    }).filter(release => matchesScope(release, scope)).sort((a, b) => a.target.localeCompare(b.target));
  }
  async history(scope?: Ownership): Promise<EvolutionActivationHistory[]> {
    const state = await this.read(this.pool);
    if (scope === undefined) return state.history;
    const owned = new Set(state.releases.filter(release => matchesScope(release, scope)).map(release => release.candidateId));
    return state.history.filter(item => owned.has(item.candidateId));
  }
  async listTraffic(scope?: Ownership): Promise<EvolutionTrafficRoute[]> {
    const state = await this.read(this.pool);
    return state.traffic.filter(route => matchesScope(route, scope)).map(route => structuredClone(route));
  }
  startTraffic(input: Pick<EvolutionTrafficRoute, 'target' | 'candidateId' | 'baseCandidateId' | 'baseVersion' | 'version' | 'contentHash' | 'percentage' | 'rolloutRef'> & Partial<Pick<EvolutionTrafficRoute, 'owner' | 'tenantId' | 'safety'>>): Promise<EvolutionTrafficRoute> {
    return this.transaction(async (_client, state) => {
      const now = new Date().toISOString();
      const route = trafficRouteSchema.parse({ ...input, schemaVersion: 1, id: `traffic_${randomUUID()}`, status: 'active', startedAt: now, updatedAt: now });
      if (state.traffic.some(item => item.status !== 'stopped' && item.id !== route.id && item.target === route.target && item.owner === route.owner && item.tenantId === route.tenantId)) throw new Error('An active traffic canary already exists for this target');
      assertTrafficBase(state, route);
      state.traffic.push(route); return structuredClone(route);
    });
  }
  updateTraffic(candidateIdValue: string, percentage: number, rolloutRef: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.transaction(async (_client, state) => {
      candidateId.parse(candidateIdValue); const validatedPercentage = z.number().int().min(1).max(9999).parse(percentage); const validatedRef = z.string().trim().min(1).max(200).parse(rolloutRef);
      const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status === 'active');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown traffic canary');
      const next = trafficRouteSchema.parse({ ...state.traffic[index]!, percentage: validatedPercentage, rolloutRef: validatedRef, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; return structuredClone(next);
    });
  }
  stopTraffic(candidateIdValue: string, reason: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.transaction(async (_client, state) => {
      candidateId.parse(candidateIdValue); const validatedReason = z.string().trim().min(1).max(4000).parse(reason);
      const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status !== 'stopped');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown traffic canary');
      const next = trafficRouteSchema.parse({ ...state.traffic[index]!, status: 'stopped', lastReason: validatedReason, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; return structuredClone(next);
    });
  }
  recordTraffic(candidateIdValue: string, observation: EvolutionTrafficObservation, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.transaction(async (_client, state) => {
      candidateId.parse(candidateIdValue); const validated = trafficObservationSchema.parse(observation);
      const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status !== 'stopped');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown traffic canary');
      const route = state.traffic[index]!;
      if (route.observations.some(item => item.id === validated.id)) throw new Error('Traffic observation already exists');
      const next = applyTrafficObservation(route, validated);
      state.traffic[index] = next; return structuredClone(next);
    });
  }
  pauseTraffic(candidateIdValue: string, reason: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.transaction(async (_client, state) => {
      candidateId.parse(candidateIdValue); const validatedReason = z.string().trim().min(1).max(4000).parse(reason);
      const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status === 'active');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown active traffic canary');
      const next = trafficRouteSchema.parse({ ...state.traffic[index]!, status: 'paused', lastReason: validatedReason, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; return structuredClone(next);
    });
  }
  resumeTraffic(candidateIdValue: string, rolloutRef: string, scope?: Ownership): Promise<EvolutionTrafficRoute> {
    return this.transaction(async (_client, state) => {
      candidateId.parse(candidateIdValue); const validatedRef = z.string().trim().min(1).max(200).parse(rolloutRef);
      const index = state.traffic.findIndex(route => route.candidateId === candidateIdValue && route.status === 'paused');
      if (index < 0 || !matchesScope(state.traffic[index]!, scope)) throw new Error('Unknown paused traffic canary');
      const route = state.traffic[index]!;
      assertTrafficBase(state, route);
      if (state.traffic.some(item => item.status !== 'stopped' && item.id !== route.id && item.target === route.target && item.owner === route.owner && item.tenantId === route.tenantId)) throw new Error('An active traffic canary already exists for this target');
      const next = trafficRouteSchema.parse({ ...route, status: 'active', rolloutRef: validatedRef, lastReason: undefined, updatedAt: new Date().toISOString() });
      state.traffic[index] = next; return structuredClone(next);
    });
  }
  async activate(input: Pick<ActiveEvolution, 'target' | 'candidateId' | 'baseVersion' | 'version' | 'change' | 'activationRef'> & Partial<Pick<ActiveEvolution, 'owner' | 'tenantId'>>): Promise<ActiveEvolution> {
    return this.transaction(async (client, state) => {
      let release: ActiveEvolution = activationSchema.parse({ schemaVersion: 1 as const, ...input, contentHash: evolutionContentHash(input), activatedAt: new Date().toISOString() });
      const existing = state.releases.find(item => item.candidateId === input.candidateId);
      if (state.revoked.includes(input.candidateId)) throw new Error('Revoked candidate cannot be reactivated');
      if (existing) {
        if (state.active.includes(existing.candidateId) && existing.contentHash === release.contentHash && existing.baseVersion === release.baseVersion) return existing;
        throw new Error('Candidate has already been activated; create a new version');
      }
      const previous = state.releases.find(item => state.active.includes(item.candidateId) && item.target === input.target && item.owner === release.owner && item.tenantId === release.tenantId);
      const expected = previous?.version ?? baselineVersions[input.target];
      if (input.baseVersion !== expected) throw new Error(`Activation base version conflict: expected ${expected}`);
      if (input.version === baselineVersions[input.target] || state.releases.some(item => item.target === input.target && item.version === input.version && item.owner === release.owner && item.tenantId === release.tenantId)) throw new Error('Evolution version must be new and immutable');
      if (previous) release.parentCandidateId = previous.candidateId;
      const parsed = activationSchema.parse(release); state.releases.push(parsed); state.active = [...state.active.filter(id => id !== previous?.candidateId), parsed.candidateId];
      stopAffectedTraffic(state, route => route.target === release.target && matchesScope(route, release), 'Active release changed');
      state.history.push({ id: randomUUID(), action: 'activated', target: parsed.target, candidateId: parsed.candidateId, version: parsed.version, reason: parsed.activationRef, at: parsed.activatedAt });
      return parsed;
    });
  }
  async revoke(id: string, reason: string, scope?: Ownership): Promise<void> {
    await this.transaction(async (_client, state) => {
      candidateId.parse(id); z.string().trim().min(1).max(4000).parse(reason);
      if (state.revoked.includes(id)) return undefined;
      const release = state.releases.find(item => item.candidateId === id); if (release && !matchesScope(release, scope)) throw new Error('Unknown evolution candidate');
      assertTrafficRevokeScope(state, id, scope);
      stopAffectedTraffic(state, route => route.candidateId === id || route.baseCandidateId === id, reason);
      state.revoked.push(id); if (!release) return undefined;
      let parent = release.parentCandidateId ? state.releases.find(item => item.candidateId === release.parentCandidateId) : undefined;
      while (parent && state.revoked.includes(parent.candidateId)) parent = parent.parentCandidateId ? state.releases.find(item => item.candidateId === parent!.parentCandidateId) : undefined;
      if (state.active.includes(id)) { state.active = state.active.filter(value => value !== id); if (parent) state.active.push(parent.candidateId); }
      state.history.push({ id: randomUUID(), action: 'rolled_back', target: release.target, candidateId: id, version: release.version, ...(parent && state.active.includes(parent.candidateId) ? { restoredCandidateId: parent.candidateId } : {}), reason, at: new Date().toISOString() });
      return undefined;
    });
  }
  private async transaction<T>(operation: (client: pg.PoolClient, state: z.infer<typeof evolutionActivationStateSchema>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT id FROM aeeis_evolution_activation WHERE id=$1 FOR UPDATE', ['singleton']);
      const state = await this.read(client); const result = await operation(client, state);
      await client.query('UPDATE aeeis_evolution_activation SET state=$2 WHERE id=$1', ['singleton', evolutionActivationStateSchema.parse(state)]);
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close(): Promise<void> { await this.pool.end(); }
}
