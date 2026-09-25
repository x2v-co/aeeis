import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * A directory is an organization-owned identity fact source. Authentication
 * proves who is making the request; the directory decides whether a target
 * identity exists in the same tenant and may currently be invited.
 */
export const principalDirectoryStatusSchema = z.enum(['active', 'suspended', 'disabled']);
export type PrincipalDirectoryStatus = z.infer<typeof principalDirectoryStatusSchema>;
export const principalDirectoryEntrySchema = z.object({
  principalId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/),
  tenantId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/),
  status: principalDirectoryStatusSchema,
  displayName: z.string().max(500).optional(),
}).strict();
export type PrincipalDirectoryEntry = z.infer<typeof principalDirectoryEntrySchema>;

export interface PrincipalDirectory {
  init?(): Promise<void> | void;
  lookup(principalId: string, tenantId: string): Promise<PrincipalDirectoryEntry | undefined>;
  health?(): Promise<{ ready: boolean; detail: string }>;
  close?(): Promise<void>;
}

export interface PrincipalDirectoryCacheOptions {
  /** How long an active or negative lookup may be reused. */
  ttlMs?: number;
  /** Upper bound on cached identities. This is a process-local cache. */
  maxEntries?: number;
}

export class PrincipalDirectoryUnavailable extends Error {}

/**
 * A small, fail-closed cache around an organization directory.
 *
 * The cache is deliberately in front of the directory rather than in the
 * Room repository: directory state is identity metadata, while membership is
 * an AEEIS fact. Expired entries are never used as a stale fallback when the
 * directory is unavailable. Concurrent misses for the same identity share one
 * lookup, which prevents an invitation burst from becoming a directory burst.
 */
export class CachedPrincipalDirectory implements PrincipalDirectory {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, { expiresAt: number; value?: PrincipalDirectoryEntry }>();
  private readonly inFlight = new Map<string, Promise<PrincipalDirectoryEntry | undefined>>();
  private readonly versions = new Map<string, number>();
  private epoch = 0;
  private closed = false;

  constructor(private readonly delegate: PrincipalDirectory, options: PrincipalDirectoryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 0) throw new Error('Principal directory cache ttlMs must be a non-negative integer');
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) throw new Error('Principal directory cache maxEntries must be a positive integer');
  }

  async init(): Promise<void> { await this.delegate.init?.(); }

  async lookup(principalId: string, tenantId: string): Promise<PrincipalDirectoryEntry | undefined> {
    if (this.closed) throw new PrincipalDirectoryUnavailable('Principal directory cache is closed');
    const cacheKey = key(principalId, tenantId);
    const now = Date.now();
    const cached = this.entries.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value ? structuredClone(cached.value) : undefined;
    if (cached) this.entries.delete(cacheKey);
    const existing = this.inFlight.get(cacheKey);
    if (existing) return structuredClone(await existing);
    const version = this.versions.get(cacheKey) ?? 0;
    const pending = this.lookupAndCache(cacheKey, principalId, tenantId, this.epoch, version);
    this.inFlight.set(cacheKey, pending);
    try { return structuredClone(await pending); }
    finally { if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey); }
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    if (!this.delegate.health) return { ready: false, detail: 'Principal directory health probe unavailable' };
    return this.delegate.health();
  }

  invalidate(principalId: string, tenantId: string): void {
    const cacheKey = key(principalId, tenantId);
    this.entries.delete(cacheKey);
    this.versions.set(cacheKey, (this.versions.get(cacheKey) ?? 0) + 1);
    this.inFlight.delete(cacheKey);
  }
  invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId}\u0000`;
    for (const cacheKey of new Set([...this.entries.keys(), ...this.inFlight.keys()])) {
      if (!cacheKey.startsWith(prefix)) continue;
      this.entries.delete(cacheKey);
      this.versions.set(cacheKey, (this.versions.get(cacheKey) ?? 0) + 1);
      this.inFlight.delete(cacheKey);
    }
  }
  clear(): void { this.entries.clear(); this.versions.clear(); this.epoch += 1; this.inFlight.clear(); }
  get cacheSize(): number { return this.entries.size; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    await this.delegate.close?.();
  }

  private async lookupAndCache(cacheKey: string, principalId: string, tenantId: string, epoch: number, version: number): Promise<PrincipalDirectoryEntry | undefined> {
    const value = await this.delegate.lookup(principalId, tenantId);
    if (this.ttlMs > 0 && !this.closed && epoch === this.epoch && version === (this.versions.get(cacheKey) ?? 0)) {
      this.entries.set(cacheKey, { expiresAt: Date.now() + this.ttlMs, ...(value ? { value: structuredClone(value) } : {}) });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return value;
  }
}

export class InMemoryPrincipalDirectory implements PrincipalDirectory {
  private readonly entries = new Map<string, PrincipalDirectoryEntry>();
  constructor(entries: readonly PrincipalDirectoryEntry[] = []) { for (const entry of entries) this.set(entry); }
  set(entry: PrincipalDirectoryEntry): void { const valid = principalDirectoryEntrySchema.parse(entry); this.entries.set(key(valid.principalId, valid.tenantId), structuredClone(valid)); }
  async lookup(principalId: string, tenantId: string): Promise<PrincipalDirectoryEntry | undefined> {
    const entry = this.entries.get(key(principalId, tenantId));
    return entry ? structuredClone(entry) : undefined;
  }
  async health(): Promise<{ ready: boolean; detail: string }> { return { ready: true, detail: 'in-memory principal directory' }; }
  async close(): Promise<void> {}
}

/** Read-only local adapter for development and deterministic tests. */
export class JsonPrincipalDirectory implements PrincipalDirectory {
  private entries = new Map<string, PrincipalDirectoryEntry>();
  private loaded = false;
  constructor(private readonly filePath: string) {}
  init(): void {
    if (this.loaded) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const values = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { entries?: unknown }).entries) ? (parsed as { entries: unknown[] }).entries : undefined);
      if (!values) throw new Error('principal directory file must be an array or an object with entries');
      for (const value of values) {
        const entry = principalDirectoryEntrySchema.parse(value);
        this.entries.set(key(entry.principalId, entry.tenantId), entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }
  async lookup(principalId: string, tenantId: string): Promise<PrincipalDirectoryEntry | undefined> {
    this.init();
    const entry = this.entries.get(key(principalId, tenantId));
    return entry ? structuredClone(entry) : undefined;
  }
  async health(): Promise<{ ready: boolean; detail: string }> { this.init(); return { ready: true, detail: 'file principal directory loaded' }; }
  async close(): Promise<void> {}
}

/** HTTPS adapter. The endpoint receives principalId and tenantId as query
 * parameters and returns a directory entry, 404 for an unknown identity. */
export class HttpPrincipalDirectory implements PrincipalDirectory {
  private readonly endpoint: URL;
  constructor(endpoint: string, private readonly token?: string, private readonly timeoutMs = 5_000, allowInsecureHttp = false) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new Error('Principal directory URL must not contain credentials, query or fragment');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname);
    if (this.endpoint.protocol !== 'https:' && !(this.endpoint.protocol === 'http:' && (loopback || allowInsecureHttp))) throw new Error('Principal directory URL must use HTTPS except loopback');
  }
  async lookup(principalId: string, tenantId: string): Promise<PrincipalDirectoryEntry | undefined> {
    const url = new URL(this.endpoint);
    url.searchParams.set('principalId', principalId);
    url.searchParams.set('tenantId', tenantId);
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) } });
    } catch (error) {
      throw new PrincipalDirectoryUnavailable(`Principal directory request failed: ${error instanceof Error ? error.message : 'network error'}`);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new PrincipalDirectoryUnavailable(`Principal directory returned HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new PrincipalDirectoryUnavailable('Principal directory returned invalid JSON'); }
    const candidate = body && typeof body === 'object' && 'principal' in body ? (body as { principal: unknown }).principal : body;
    try { return principalDirectoryEntrySchema.parse(candidate); }
    catch { throw new PrincipalDirectoryUnavailable('Principal directory returned an invalid principal record'); }
  }
  async health(): Promise<{ ready: boolean; detail: string }> {
    try {
      // Probe the documented lookup contract with a reserved, non-existent
      // identity. This avoids requiring every directory vendor to implement a
      // second health endpoint or interpreting an arbitrary 404 as downtime.
      await this.lookup('aeeis-health-probe', 'aeeis-health-probe');
      return { ready: true, detail: 'principal directory reachable' };
    } catch { return { ready: false, detail: 'principal directory health probe failed' }; }
  }
  async close(): Promise<void> {}
}

function key(principalId: string, tenantId: string): string { return `${tenantId}\u0000${principalId}`; }
