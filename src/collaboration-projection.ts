import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });
const projectionId = z.string().regex(/^projection_[a-f0-9-]{36}$/);
const aggregateId = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const projectionEventSchema = z.object({
  schemaVersion: z.literal(1), id: projectionId, idempotencyKey: z.string().min(1).max(500),
  channel: z.string().trim().min(1).max(100), destination: z.string().trim().min(1).max(500),
  aggregateType: z.enum(['debate', 'competition']), aggregateId, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(), status: z.enum(['pending', 'failed', 'delivered']), attempts: z.number().int().nonnegative(),
  createdAt: isoDate, updatedAt: isoDate, lastError: z.string().max(4000).optional(), deliveredAt: isoDate.optional(), externalId: z.string().max(500).optional(),
}).strict();
const stateSchema = z.object({ events: z.array(projectionEventSchema).max(10000) }).strict();
export type ProjectionEvent = z.infer<typeof projectionEventSchema>;
export interface ProjectionSink { deliver(event: ProjectionEvent): Promise<{ externalId?: string }> }

export class FileProjectionOutbox {
  private readonly lockPath: string;
  private readonly statePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly deliveries = new Map<string, Promise<ProjectionEvent>>();
  constructor(private readonly directory: string) { this.lockPath = join(directory, '.writer.lock'); this.statePath = join(directory, 'projections.json'); }
  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const lock = await open(this.lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(this.lockPath, 'utf8'));
      try { process.kill(pid, 0); throw new Error('Projection directory already has a live writer'); }
      catch (probeError) { if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError; await unlink(this.lockPath); return this.init(); }
    }
    try { stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await this.save({ events: [] }); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  private async load(): Promise<z.infer<typeof stateSchema>> { return stateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8'))); }
  private async save(state: z.infer<typeof stateSchema>): Promise<void> {
    const temporary = `${this.statePath}.${randomUUID()}.tmp`; const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.statePath); const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
  }
  async enqueue(input: { channel: string; destination: string; aggregateType: ProjectionEvent['aggregateType']; aggregateId: string; payload: unknown; idempotencyKey: string }): Promise<ProjectionEvent> {
    const payloadSize = JSON.stringify(input.payload).length;
    if (payloadSize > 200_000) throw new Error('Projection payload exceeds the 200KB limit');
    return this.serial(async () => {
      const state = await this.load();
      const snapshotHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
      const existing = state.events.find(event => event.idempotencyKey === input.idempotencyKey && event.channel === input.channel);
      if (existing) return structuredClone(existing);
      const now = new Date().toISOString();
      const event = projectionEventSchema.parse({ schemaVersion: 1, id: `projection_${randomUUID()}`, idempotencyKey: input.idempotencyKey, channel: input.channel, destination: input.destination, aggregateType: input.aggregateType, aggregateId: input.aggregateId, snapshotHash, payload: input.payload, status: 'pending', attempts: 0, createdAt: now, updatedAt: now });
      state.events.push(event); await this.save(state); return structuredClone(event);
    });
  }
  async get(id: string): Promise<ProjectionEvent> { const item = (await this.load()).events.find(event => event.id === id); if (!item) throw new Error('Unknown projection event'); return structuredClone(item); }
  async list(status?: ProjectionEvent['status']): Promise<ProjectionEvent[]> { return (await this.load()).events.filter(event => status === undefined || event.status === status).map(event => structuredClone(event)); }
  async deliver(id: string, sink: ProjectionSink): Promise<ProjectionEvent> {
    const active = this.deliveries.get(id);
    if (active) return active;
    const work = this.deliverOnce(id, sink).finally(() => this.deliveries.delete(id));
    this.deliveries.set(id, work);
    return work;
  }
  private async deliverOnce(id: string, sink: ProjectionSink): Promise<ProjectionEvent> {
    const current = await this.get(id);
    if (current.status === 'delivered') return current;
    await this.serial(async () => {
      const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) throw new Error('Unknown projection event');
      const event = state.events[index]!; state.events[index] = { ...event, attempts: event.attempts + 1, updatedAt: new Date().toISOString(), lastError: undefined }; await this.save(state);
    });
    try {
      const result = await sink.deliver(await this.get(id));
      return this.serial(async () => {
        const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) throw new Error('Unknown projection event');
        const event = state.events[index]!; const deliveredAt = new Date().toISOString();
        state.events[index] = { ...event, status: 'delivered', updatedAt: deliveredAt, deliveredAt, ...(result.externalId ? { externalId: result.externalId } : {}), lastError: undefined }; await this.save(state); return structuredClone(state.events[index]!);
      });
    } catch (error) {
      await this.serial(async () => {
        const state = await this.load(); const index = state.events.findIndex(event => event.id === id); if (index < 0) return;
        state.events[index] = { ...state.events[index]!, status: 'failed', updatedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : 'Projection delivery failed' }; await this.save(state);
      });
      throw error;
    }
  }
  async deliverPending(sink: ProjectionSink, limit = 20): Promise<{ delivered: number; failed: number; events: ProjectionEvent[] }> {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    const candidates = (await this.list()).filter(event => event.status === 'pending' || event.status === 'failed').slice(0, bounded);
    const events: ProjectionEvent[] = []; let failed = 0;
    for (const candidate of candidates) {
      try { events.push(await this.deliver(candidate.id, sink)); }
      catch { failed += 1; events.push(await this.get(candidate.id)); }
    }
    return { delivered: events.filter(event => event.status === 'delivered').length, failed, events };
  }
  async close(): Promise<void> { await this.queue; await unlink(this.lockPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}

export class HttpProjectionSink implements ProjectionSink {
  private readonly endpoint: string;
  constructor(endpoint: string, private readonly token?: string, private readonly timeoutMs = 30_000) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Projection sink URL must use HTTPS except loopback');
    if (url.username || url.password || url.hash) throw new Error('Projection sink URL must not contain credentials or fragments');
    this.endpoint = url.toString();
  }
  async deliver(event: ProjectionEvent): Promise<{ externalId?: string }> {
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, body: JSON.stringify({ schemaVersion: 'aeeis-projection-event/1', event }) });
    if (!response.ok) throw new Error(`Projection sink returned HTTP ${response.status}`);
    const body = z.object({ schemaVersion: z.literal('aeeis-projection-ack/1'), accepted: z.literal(true), externalId: z.string().max(500).optional() }).strict().parse(await response.json());
    return body.externalId === undefined ? {} : { externalId: body.externalId };
  }
}
