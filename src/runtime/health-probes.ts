export interface ProbeHealth { ready: boolean; detail: string; stale?: boolean; lastGoodAt?: string }
export class HealthProbeTimeout extends Error {}
export interface HealthProbeOptions { timeoutMs?: number; cacheTtlMs?: number; lastGoodGraceMs?: number }
export interface BackgroundHealthMonitorOptions { timeoutMs?: number; refreshIntervalMs?: number; lastGoodRetentionMs?: number }
export type BackgroundHealthSnapshot = ProbeHealth & { lastCheckedAt: string };

/** Background-only tools diagnostics. Reading a snapshot never starts I/O.
 * A deadline ends the cycle, but retains the underlying operation's slot until
 * it settles, so even a hung provider cannot cause overlapping refreshes. */
export class BackgroundHealthMonitor {
  private readonly timeoutMs: number;
  private readonly refreshIntervalMs: number;
  private readonly lastGoodRetentionMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private cycle: Promise<void> | undefined;
  private finishCycle: (() => void) | undefined;
  private value: ProbeHealth = { ready: false, detail: 'Tool gateway health probe unavailable' };
  private checkedAt = Date.now();
  private lastGood: { value: ProbeHealth; at: number } | undefined;

  constructor(private readonly operation: () => ProbeHealth | Promise<ProbeHealth>, options: BackgroundHealthMonitorOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
    this.lastGoodRetentionMs = options.lastGoodRetentionMs ?? 900_000;
    for (const [name, value] of Object.entries({ timeoutMs: this.timeoutMs, refreshIntervalMs: this.refreshIntervalMs, lastGoodRetentionMs: this.lastGoodRetentionMs })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`Background health monitor ${name} must be a positive finite number`);
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.refreshNow();
    this.timer = setInterval(() => { void this.refreshNow(); }, this.refreshIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.finishCycle?.();
  }

  refreshNow(): Promise<void> {
    if (this.inFlight) return this.cycle!;
    let timedOut = false;
    let resolveCycle!: () => void;
    this.cycle = new Promise<void>(resolve => { resolveCycle = resolve; });
    const deadline = setTimeout(() => {
      timedOut = true;
      this.value = { ready: false, detail: 'Tool gateway health probe timed out' };
      this.checkedAt = Date.now();
      finish();
    }, this.timeoutMs);
    deadline.unref();
    const finish = () => {
      clearTimeout(deadline);
      this.finishCycle = undefined;
      resolveCycle();
    };
    this.finishCycle = finish;
    this.inFlight = Promise.resolve().then(this.operation).then(value => {
      // A late success can recover readiness via last-good retention, but
      // the timeout remains the result of this cycle.
      if (!timedOut) {
        this.value = value;
        this.checkedAt = Date.now();
      }
      if (value.ready) this.lastGood = { value, at: Date.now() };
    }, () => {
      if (!timedOut) {
        this.value = { ready: false, detail: 'Tool gateway health probe failed' };
        this.checkedAt = Date.now();
      }
    }).then(() => {
      this.inFlight = undefined;
      finish();
    });
    return this.cycle;
  }

  snapshot(): BackgroundHealthSnapshot {
    const timestamps = { lastCheckedAt: new Date(this.checkedAt).toISOString(), ...(this.lastGood ? { lastGoodAt: new Date(this.lastGood.at).toISOString() } : {}) };
    if (!this.value.ready && this.lastGood && Date.now() - this.lastGood.at < this.lastGoodRetentionMs) {
      return { ...this.lastGood.value, ...timestamps, stale: true, detail: `${this.lastGood.value.detail}; using last successful probe (${this.value.detail})` };
    }
    return { ...this.value, ...timestamps };
  }
}

type Entry = { pending?: Promise<ProbeHealth>; value?: ProbeHealth; error?: unknown; checkedAt?: number; lastGood?: { value: ProbeHealth; at: number } };

/** Read-only diagnostics only. Execution, manifests and permission lookups
 * must use their own live validation, never this cache. */
export class HealthProbes {
  private readonly entries = new Map<string, Entry>();
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly lastGoodGraceMs: number;
  constructor(options: HealthProbeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 500;
    this.cacheTtlMs = options.cacheTtlMs ?? 2_000;
    this.lastGoodGraceMs = options.lastGoodGraceMs ?? 10_000;
    for (const [name, value] of Object.entries({ timeoutMs: this.timeoutMs, cacheTtlMs: this.cacheTtlMs, lastGoodGraceMs: this.lastGoodGraceMs })) {
      if (!Number.isFinite(value) || value < 0 || (name === 'timeoutMs' && value === 0)) throw new Error(`Health probe ${name} must be ${name === 'timeoutMs' ? 'positive' : 'nonnegative'} and finite`);
    }
  }
  private lastGood(entry: Entry, detail: string): ProbeHealth | undefined {
    if (!entry.lastGood || Date.now() - entry.lastGood.at >= this.lastGoodGraceMs) return undefined;
    return { ...entry.lastGood.value, stale: true, lastGoodAt: new Date(entry.lastGood.at).toISOString(),
      detail: `${entry.lastGood.value.detail}; using last successful probe (${detail})` };
  }
  async get<T extends ProbeHealth>(name: string, operation: () => T | Promise<T>): Promise<T> {
    const entry = this.entries.get(name) ?? {};
    this.entries.set(name, entry);
    if (entry.checkedAt !== undefined && Date.now() - entry.checkedAt < this.cacheTtlMs) {
      if (entry.value?.ready) return entry.value as T;
      const good = this.lastGood(entry, entry.value?.detail ?? 'dependency check failed');
      if (good) return good as T;
      if (entry.value) return entry.value as T;
      throw entry.error;
    }
    if (!entry.pending) {
      entry.pending = Promise.resolve().then(operation).then(value => {
        entry.value = value; delete entry.error; entry.checkedAt = Date.now();
        if (value.ready) entry.lastGood = { value, at: entry.checkedAt };
        return value;
      }, error => {
        delete entry.value; entry.error = error; entry.checkedAt = Date.now();
        throw error;
      }).finally(() => { delete entry.pending; });
      // Refresh can outlive the request. Late rejection must be handled; late
      // success updates this same cache instead of being lost after a timeout.
      void entry.pending.catch(() => {});
    }
    const good = this.lastGood(entry, 'refresh pending');
    if (good) return good as T;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        entry.pending as Promise<T>,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HealthProbeTimeout()), this.timeoutMs); }),
      ]);
    } catch (error) {
      if (error instanceof HealthProbeTimeout) { delete entry.value; entry.error = error; entry.checkedAt = Date.now(); }
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
