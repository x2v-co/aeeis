import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { encodeRunEventCursor, type RunRepository, type RunEventScanRecord } from './runtime/repository.js';
import type { AgentRun, Event } from './runtime/contracts.js';
import { createPostgresPool } from './adapters/postgres-pool.js';

const runId = z.string().regex(/^run_[a-f0-9-]{36}$/);
const nameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/);
const cursorSchema = z.object({
  afterId: runId.optional(), throughId: runId.optional(),
  // afterId stays before this Run until every captured event is attempted.
  resume: z.object({ runId, offset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative() }).strict().optional(),
}).strict();
const checkpointSchema = z.object({ revision: z.number().int().nonnegative(), cursor: cursorSchema }).strict();
const stateSchema = z.record(nameSchema, checkpointSchema);
export type RunScanCheckpoint = z.infer<typeof checkpointSchema>;
export type RunScanState = z.infer<typeof cursorSchema>;

/** Checkpoints are scheduling hints, never evidence that a signal succeeded.
 * CAS protects newer progress from stale workers; canonical attempts and
 * candidate IDs continue to provide at-least-once replay correctness. */
export interface RunScanCursorStore {
  init(): Promise<void>;
  get(name: string): Promise<RunScanCheckpoint>;
  advance(name: string, expectedRevision: number, cursor: RunScanState): Promise<boolean>;
  close(): Promise<void>;
}

/** Local single-writer deployment, guarded by the Run repository writer lock. */
export class FileRunScanCursorStore implements RunScanCursorStore {
  private queue: Promise<unknown> = Promise.resolve();
  private state: Record<string, RunScanCheckpoint> = {};
  private loaded = false;
  constructor(private readonly path: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation); this.queue = next.catch(() => undefined); return next;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try { this.state = stateSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = {}; }
    this.loaded = true;
  }
  async init(): Promise<void> { await this.serial(() => this.load()); }
  async get(name: string): Promise<RunScanCheckpoint> {
    nameSchema.parse(name);
    return this.serial(async () => { await this.load(); return structuredClone(this.state[name] ?? { revision: 0, cursor: {} }); });
  }
  async advance(name: string, expectedRevision: number, cursor: RunScanState): Promise<boolean> {
    nameSchema.parse(name);
    const checkpoint = checkpointSchema.parse({ revision: expectedRevision + 1, cursor });
    return this.serial(async () => {
      await this.load();
      if ((this.state[name]?.revision ?? 0) !== expectedRevision) return false;
      const next = { ...this.state, [name]: checkpoint };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path);
        const directory = await open(dirname(this.path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
        this.state = next;
        return true;
      } catch (error) { this.loaded = false; throw error; }
      finally { await unlink(temp).catch(() => undefined); }
    });
  }
  async close(): Promise<void> { await this.queue; }
}

export class PostgresRunScanCursorStore implements RunScanCursorStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init(): Promise<void> {
    await withPostgresMigrationLock(this.pool, 'run-scan-cursors', async client => {
      await client.query(`CREATE TABLE IF NOT EXISTS aeeis_run_scan_cursors (
        name text PRIMARY KEY, revision integer NOT NULL, cursor jsonb NOT NULL
      )`);
    });
  }
  async get(name: string): Promise<RunScanCheckpoint> {
    nameSchema.parse(name);
    const result = await this.pool.query('SELECT revision, cursor FROM aeeis_run_scan_cursors WHERE name=$1', [name]);
    return result.rows[0] ? checkpointSchema.parse(result.rows[0]) : { revision: 0, cursor: {} };
  }
  async advance(name: string, expectedRevision: number, cursor: RunScanState): Promise<boolean> {
    nameSchema.parse(name);
    const checkpoint = checkpointSchema.parse({ revision: expectedRevision + 1, cursor });
    const result = expectedRevision === 0
      ? await this.pool.query('INSERT INTO aeeis_run_scan_cursors(name, revision, cursor) VALUES($1,$2,$3) ON CONFLICT(name) DO NOTHING RETURNING revision', [name, checkpoint.revision, checkpoint.cursor])
      : await this.pool.query('UPDATE aeeis_run_scan_cursors SET revision=$2, cursor=$3 WHERE name=$1 AND revision=$4 RETURNING revision', [name, checkpoint.revision, checkpoint.cursor, expectedRevision]);
    return result.rows.length === 1;
  }
  async close(): Promise<void> { await this.pool.end(); }
}

export interface RunEventBatch {
  entries: Array<{ run: AgentRun; event: Event }>;
  /** Call only after all entries have been attempted. Failed entries are
   * revisited next sweep; a crash before this commit replays this batch.
   * Pass `{ settled: false }` when an entry failed, so an idle gate does not
   * delay that retry. */
  commit(options?: { settled?: boolean }): Promise<boolean>;
}

/** Lets scanners stop re-reading every Run once a sweep finds nothing new.
 * A finished sweep rests until a Run change wakes the gate or `restMs`
 * passes. Enable it only while a change feed is subscribed: the fallback
 * sweep is what covers a notification lost during a reconnect. Disabled,
 * scanners sweep continuously as before. */
export class RunScanIdleGate {
  private rest = 0;
  private replayEvery = 0;
  private changes = 0;
  private replays = 0;
  constructor(private readonly now: () => number = Date.now) {}
  /** `replayMs` (0 = never) makes scanners forget which Runs they already
   * settled and re-read everything that often, as a safety net. */
  enable(restMs: number, options: { replayMs?: number } = {}): void {
    if (!Number.isInteger(restMs) || restMs < 1000 || restMs > 3_600_000) throw new Error('Run scan idle rest must be between 1000 and 3600000 milliseconds');
    const replayMs = options.replayMs ?? 0;
    if (!Number.isInteger(replayMs) || (replayMs !== 0 && (replayMs < 60_000 || replayMs > 86_400_000))) throw new Error('Run scan replay interval must be 0 or between 60000 and 86400000 milliseconds');
    this.rest = restMs;
    this.replayEvery = replayMs;
  }
  disable(): void { this.rest = 0; }
  /** Called for every Run change hint; never throttle these. */
  wake(): void { this.changes += 1; }
  /** Something outside the Runs changed how their events are handled (for
   * example a trigger policy). The next sweep re-reads every Run. */
  replay(): void { this.replays += 1; this.wake(); }
  get restMs(): number { return this.rest; }
  get replayMs(): number { return this.replayEvery; }
  get generation(): number { return this.changes; }
  get replayGeneration(): number { return this.replays; }
  get clock(): number { return this.now(); }
}

/** A repeating paged pass outside the Run scanners (for example the task
 * board's recovery loops) that rests the same way: once a whole cycle started
 * and finished with no Run change and no failure, calls are skipped until the
 * rest ends or a change arrives. A disabled gate never rests. */
export class RunScanIdlePass {
  private cycleGeneration: number | undefined;
  private cycleFailed = false;
  private restUntil = 0;
  private restGeneration = -1;
  constructor(private readonly gate: RunScanIdleGate) {}
  /** Whether to run a step now. */
  begin(): boolean {
    const gate = this.gate;
    if (gate.restMs > 0 && gate.generation === this.restGeneration && gate.clock < this.restUntil) return false;
    this.restUntil = 0;
    if (this.cycleGeneration === undefined) { this.cycleGeneration = gate.generation; this.cycleFailed = false; }
    return true;
  }
  /** After a step that `begin()` allowed; `cycleDone` when it finished a whole pass. */
  end(outcome: { ok: boolean; cycleDone: boolean }): void {
    if (!outcome.ok) this.cycleFailed = true;
    if (!outcome.cycleDone) return;
    const gate = this.gate;
    if (gate.restMs > 0 && !this.cycleFailed && this.cycleGeneration === gate.generation) {
      this.restUntil = gate.clock + gate.restMs;
      this.restGeneration = gate.generation;
    }
    this.cycleGeneration = undefined;
  }
  /** Runs `step` unless resting; returns false when it rested. */
  async run(step: () => Promise<boolean>): Promise<boolean> {
    if (!this.begin()) return false;
    let ok = false; let cycleDone = false;
    try { cycleDone = await step(); ok = true; }
    finally { this.end({ ok, cycleDone }); }
    return true;
  }
}

export interface RunEventScannerOptions {
  /** Read the bounded event projection and load full Run state only for Runs
   * that actually contain events. The canonical Run remains authoritative. */
  useEventProjection?: boolean;
  /** Shared gate that pauses sweeps while nothing changes. While it is
   * enabled, sweeps also skip Runs that have not changed since they settled. */
  idle?: RunScanIdleGate;
}

/** Pages read in one batch while every Run on them is skipped. */
const maxQuietPages = 50;

export class RunEventScanner {
  /** Gate generation when the current sweep started from an empty cursor;
   * undefined after a restart mid-sweep, so that sweep never rests. */
  private sweepGeneration: number | undefined;
  /** Any batch of the current sweep failed; cleared only when a new sweep starts. */
  private sweepUnsettled = false;
  private restUntil = 0;
  private restGeneration = -1;
  /** Last event seq of each Run whose events were all delivered in settled
   * batches. Such a Run is skipped until that changes; a changed Run is read
   * again from its first event, exactly as before. Memory only: a restart,
   * a replay or the gate's replay interval starts from nothing. */
  private readonly settled = new Map<string, number>();
  private memoryReplay = -1;
  private memoryStartedAt = 0;
  /** Runs, in the current sweep, that were in an unsettled batch or were split
   * across batches; only split Runs whose first part ran in this sweep may be
   * remembered. */
  private readonly unsettledRuns = new Set<string>();
  private readonly splitRuns = new Set<string>();
  constructor(private readonly repository: RunRepository, private readonly store: RunScanCursorStore, private readonly name: string, private readonly pageSize = 25, private readonly options: RunEventScannerOptions = {}) {
    nameSchema.parse(name);
    if (!repository.scanPage) throw new Error('Run repository must support bounded scans');
    if (options.useEventProjection && (!repository.scanEventsPage || !repository.eventsPage)) throw new Error('Run repository must support event projection scans');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('Run scan page size must be between 1 and 200');
    if (options.idle) { this.memoryReplay = options.idle.replayGeneration; this.memoryStartedAt = options.idle.clock; }
  }
  async batch(maxEvents: number): Promise<RunEventBatch> {
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000) throw new Error('Run scan event limit must be between 1 and 1000');
    const gate = this.options.idle;
    if (gate && gate.restMs > 0 && gate.generation === this.restGeneration && gate.clock < this.restUntil) {
      return { entries: [], commit: async () => true };
    }
    this.restUntil = 0;
    // Skipping relies on change hints reaching the gate, like resting does.
    const skipping = Boolean(gate && gate.restMs > 0);
    if (!skipping) this.settled.clear();
    const checkpoint = await this.store.get(this.name);
    const previous = checkpoint.cursor;
    if (!previous.afterId && !previous.throughId && !previous.resume) {
      this.sweepGeneration = gate?.generation; this.sweepUnsettled = false;
      this.unsettledRuns.clear(); this.splitRuns.clear();
      if (!gate || gate.replayGeneration !== this.memoryReplay || (gate.replayMs > 0 && gate.clock - this.memoryStartedAt >= gate.replayMs)) {
        this.settled.clear();
        this.memoryReplay = gate?.replayGeneration ?? -1;
        this.memoryStartedAt = gate?.clock ?? 0;
      }
    }
    const projection = this.options.useEventProjection;
    let next: RunScanState = { ...previous };
    const entries: RunEventBatch['entries'] = [];
    /** Runs completed in this batch, with the last event seq delivered. */
    const completed: Array<[string, number]> = [];
    const touched = new Set<string>();
    const unchanged = (id: string, lastSeq: number) => skipping && lastSeq > 0 && this.settled.get(id) === lastSeq;
    const finishRun = (id: string, lastSeq: number, resumed: boolean) => {
      if (!resumed || this.splitRuns.has(id)) completed.push([id, lastSeq]);
    };
    let complete = true;
    let done = false;
    for (let pages = 0; ; pages++) {
      const query = { ...(next.afterId ? { afterId: next.afterId } : {}), ...(next.throughId ? { throughId: next.throughId } : {}), limit: this.pageSize };
      const page = projection ? await this.repository.scanEventsPage!(query) : await this.repository.scanPage!(query);
      if (page.throughId) next.throughId = page.throughId;
      done = page.done;
      for (const scanned of page.runs) {
        const resumeState = next.resume;
        if (projection) {
          const record = scanned as RunEventScanRecord;
          const resume = resumeState?.runId === record.id ? resumeState : undefined;
          const endOffset = resume ? Math.min(resume.endOffset, record.lastEventSeq) : record.lastEventSeq;
          if (endOffset === 0) { next.afterId = record.id; if (next.resume?.runId === record.id) delete next.resume; continue; }
          if (!resume && unchanged(record.id, record.lastEventSeq)) { next.afterId = record.id; continue; }
          const limit = maxEvents - entries.length;
          if (limit <= 0) { complete = false; break; }
          const afterSeq = resume?.offset ?? 0;
          const eventsPage = await this.repository.eventsPage!(record.id, { owner: record.owner, tenantId: record.tenantId }, limit, encodeRunEventCursor(afterSeq));
          const events = eventsPage.events.filter(event => event.seq <= endOffset);
          if (events.length) {
            const run = await this.repository.get(record.id, { owner: record.owner, tenantId: record.tenantId });
            for (const event of events) entries.push({ run, event });
            touched.add(record.id);
          }
          const lastSeq = events.at(-1)?.seq ?? afterSeq;
          const hasRemaining = Boolean(eventsPage.nextCursor) || lastSeq < endOffset;
          if (hasRemaining) {
            next = { ...(next.afterId ? { afterId: next.afterId } : {}), ...(next.throughId ? { throughId: next.throughId } : {}), resume: { runId: record.id, offset: lastSeq, endOffset } };
            if (!resume) this.splitRuns.add(record.id);
            complete = false;
            break;
          }
          finishRun(record.id, endOffset, Boolean(resume));
          next.afterId = record.id;
          if (next.resume?.runId === record.id) delete next.resume;
          continue;
        }
        const run = scanned as AgentRun;
        // Newly inserted IDs before a partial Run can still be visited. Keep its
        // resume position until we reach it, even across a page boundary.
        const resumed = resumeState?.runId === run.id;
        const offset = resumed ? resumeState!.offset : 0;
        const endOffset = resumed ? Math.min(resumeState!.endOffset, run.events.length) : run.events.length;
        if (!resumed && unchanged(run.id, run.events.at(-1)?.seq ?? 0)) { next.afterId = run.id; continue; }
        let index = offset;
        while (index < endOffset && entries.length < maxEvents) {
          entries.push({ run, event: run.events[index]! }); index++; touched.add(run.id);
        }
        if (index < endOffset) {
          // If this page gained a Run before the partial Run, restarting the
          // latter at zero is safe: domain idempotency prevents duplicate work.
          next = { ...(next.afterId ? { afterId: next.afterId } : {}), ...(next.throughId ? { throughId: next.throughId } : {}), resume: { runId: run.id, offset: index, endOffset } };
          if (!resumed) this.splitRuns.add(run.id);
          complete = false;
          break;
        }
        if (endOffset > 0) finishRun(run.id, run.events[endOffset - 1]!.seq, resumed);
        next.afterId = run.id;
        if (next.resume && next.resume.runId <= run.id) delete next.resume;
      }
      // While skipping, keep reading pages that delivered nothing, so a quiet
      // sweep takes one tick rather than one tick per page.
      if (!skipping || !complete || done || entries.length || pages + 1 >= maxQuietPages) break;
    }
    const finished = complete && done;
    if (finished) next = {};
    // Do not publish an unattempted batch or advance on read/processing errors.
    return {
      entries,
      commit: async (options = {}) => {
        const settled = options.settled !== false;
        if (!settled) { this.sweepUnsettled = true; for (const id of touched) this.unsettledRuns.add(id); }
        const advanced = await this.store.advance(this.name, checkpoint.revision, next);
        if (advanced && settled && skipping) {
          for (const [id, lastSeq] of completed) if (!this.unsettledRuns.has(id)) this.settled.set(id, lastSeq);
        }
        if (advanced && finished) {
          // Rest only when nothing changed since this sweep began and every
          // batch of it settled; otherwise the next tick starts a fresh sweep.
          if (gate && gate.restMs > 0 && !this.sweepUnsettled && this.sweepGeneration !== undefined && this.sweepGeneration === gate.generation) {
            this.restUntil = gate.clock + gate.restMs;
            this.restGeneration = gate.generation;
          }
          this.sweepGeneration = undefined;
          this.sweepUnsettled = false;
        }
        return advanced;
      },
    };
  }
}
