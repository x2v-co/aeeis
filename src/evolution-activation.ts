import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import pg from 'pg';

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
  schemaVersion: z.literal(1), target: activationTargetSchema, candidateId,
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
export const evolutionActivationStateSchema = z.object({
  releases: z.array(activationSchema).max(10000),
  active: z.array(candidateId).max(2),
  revoked: z.array(candidateId).max(10000),
  history: z.array(historySchema).max(20000),
}).strict();
export type ActiveEvolution = z.infer<typeof activationSchema>;
export type EvolutionActivationHistory = z.infer<typeof historySchema>;
export interface EvolutionSnapshotProvider { listActive(): Promise<ActiveEvolution[]> }
export interface EvolutionActivationStore {
  list(): Promise<ActiveEvolution[]>;
  history(): Promise<EvolutionActivationHistory[]>;
  activate(input: Pick<ActiveEvolution, 'target' | 'candidateId' | 'baseVersion' | 'version' | 'change' | 'activationRef'>): Promise<ActiveEvolution>;
  revoke(candidateId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}
export function evolutionContentHash(value: Pick<ActiveEvolution, 'target' | 'version' | 'change'>): string {
  return createHash('sha256').update(JSON.stringify([value.target, value.version, value.change])).digest('hex');
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
        await this.save({ releases: [], active: [], revoked: [], history: [] });
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
  async list(): Promise<ActiveEvolution[]> {
    const state = await this.load();
    return state.active.map(id => {
      const release = state.releases.find(item => item.candidateId === id);
      if (!release || state.revoked.includes(id) || release.contentHash !== evolutionContentHash(release)) throw new Error('Invalid active evolution pointer');
      return release;
    }).sort((a, b) => a.target.localeCompare(b.target));
  }
  async history(): Promise<EvolutionActivationHistory[]> { return (await this.load()).history; }
  activate(input: Pick<ActiveEvolution, 'target' | 'candidateId' | 'baseVersion' | 'version' | 'change' | 'activationRef'>): Promise<ActiveEvolution> {
    return this.serial(async () => {
      const state = await this.load();
      const release = activationSchema.parse({ ...input, schemaVersion: 1, contentHash: evolutionContentHash(input), activatedAt: new Date().toISOString() });
      if (state.revoked.includes(release.candidateId)) throw new Error('Revoked candidate cannot be reactivated');
      const existing = state.releases.find(item => item.candidateId === release.candidateId);
      if (existing) {
        if (state.active.includes(existing.candidateId) && existing.contentHash === release.contentHash && existing.baseVersion === release.baseVersion) return existing;
        throw new Error('Candidate has already been activated; create a new version');
      }
      const previous = state.releases.find(item => state.active.includes(item.candidateId) && item.target === release.target);
      const expected = previous?.version ?? baselineVersions[release.target];
      if (release.baseVersion !== expected) throw new Error(`Activation base version conflict: expected ${expected}`);
      if (release.version === baselineVersions[release.target] || state.releases.some(item => item.target === release.target && item.version === release.version)) throw new Error('Evolution version must be new and immutable');
      if (previous) release.parentCandidateId = previous.candidateId;
      state.releases.push(release);
      state.active = [...state.active.filter(id => id !== previous?.candidateId), release.candidateId];
      state.history.push({ id: randomUUID(), action: 'activated', target: release.target, candidateId: release.candidateId, version: release.version, reason: release.activationRef, at: release.activatedAt });
      await this.save(state); return release;
    });
  }
  revoke(id: string, reason: string): Promise<void> {
    return this.serial(async () => {
      candidateId.parse(id); z.string().trim().min(1).max(4000).parse(reason);
      const state = await this.load();
      if (state.revoked.includes(id)) return;
      state.revoked.push(id);
      const release = state.releases.find(item => item.candidateId === id);
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
    await this.pool.query('CREATE TABLE IF NOT EXISTS aeeis_evolution_activation (id text PRIMARY KEY, state jsonb NOT NULL)');
    await this.pool.query(`INSERT INTO aeeis_evolution_activation(id,state) VALUES('singleton',$1) ON CONFLICT(id) DO NOTHING`, [{ releases: [], active: [], revoked: [], history: [] }]);
  }
  private async read(client: pg.Pool | pg.PoolClient): Promise<z.infer<typeof evolutionActivationStateSchema>> {
    const result = await client.query<{ state: unknown }>('SELECT state FROM aeeis_evolution_activation WHERE id=$1', ['singleton']);
    if (!result.rows[0]) throw new Error('Evolution activation state is missing');
    return evolutionActivationStateSchema.parse(result.rows[0].state);
  }
  async list(): Promise<ActiveEvolution[]> {
    const state = await this.read(this.pool);
    return state.active.map(id => {
      const release = state.releases.find(item => item.candidateId === id);
      if (!release || state.revoked.includes(id) || release.contentHash !== evolutionContentHash(release)) throw new Error('Invalid active evolution pointer');
      return release;
    }).sort((a, b) => a.target.localeCompare(b.target));
  }
  async history(): Promise<EvolutionActivationHistory[]> { return (await this.read(this.pool)).history; }
  async activate(input: Pick<ActiveEvolution, 'target' | 'candidateId' | 'baseVersion' | 'version' | 'change' | 'activationRef'>): Promise<ActiveEvolution> {
    return this.transaction(async (client, state) => {
      let release: ActiveEvolution = activationSchema.parse({ schemaVersion: 1 as const, ...input, contentHash: evolutionContentHash(input), activatedAt: new Date().toISOString() });
      const existing = state.releases.find(item => item.candidateId === input.candidateId);
      if (state.revoked.includes(input.candidateId)) throw new Error('Revoked candidate cannot be reactivated');
      if (existing) {
        if (state.active.includes(existing.candidateId) && existing.contentHash === release.contentHash && existing.baseVersion === release.baseVersion) return existing;
        throw new Error('Candidate has already been activated; create a new version');
      }
      const previous = state.releases.find(item => state.active.includes(item.candidateId) && item.target === input.target);
      const expected = previous?.version ?? baselineVersions[input.target];
      if (input.baseVersion !== expected) throw new Error(`Activation base version conflict: expected ${expected}`);
      if (input.version === baselineVersions[input.target] || state.releases.some(item => item.target === input.target && item.version === input.version)) throw new Error('Evolution version must be new and immutable');
      if (previous) release.parentCandidateId = previous.candidateId;
      const parsed = activationSchema.parse(release); state.releases.push(parsed); state.active = [...state.active.filter(id => id !== previous?.candidateId), parsed.candidateId];
      state.history.push({ id: randomUUID(), action: 'activated', target: parsed.target, candidateId: parsed.candidateId, version: parsed.version, reason: parsed.activationRef, at: parsed.activatedAt });
      return parsed;
    });
  }
  async revoke(id: string, reason: string): Promise<void> {
    await this.transaction(async (_client, state) => {
      candidateId.parse(id); z.string().trim().min(1).max(4000).parse(reason);
      if (state.revoked.includes(id)) return undefined;
      state.revoked.push(id); const release = state.releases.find(item => item.candidateId === id); if (!release) return undefined;
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
