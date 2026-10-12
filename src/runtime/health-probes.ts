export interface ProbeHealth { ready: boolean; detail: string; stale?: boolean; lastGoodAt?: string }
export class HealthProbeTimeout extends Error {}
export interface HealthProbeOptions { timeoutMs?: number; cacheTtlMs?: number; lastGoodGraceMs?: number }
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
