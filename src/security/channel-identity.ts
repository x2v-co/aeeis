import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * A Channel Identity is the fact that connects a platform subject (for
 * example a Feishu open_id or a Hermes senderRef) to an AEEIS subject.  It is
 * deliberately separate from Principal authentication and Room membership:
 * a signed platform event proves transport authenticity, while this record
 * says which stable AEEIS subject the platform identity represents.
 */
const identifier = z.string().regex(/^[a-z][a-z0-9_.-]{1,127}$/);
const tenantIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
const externalSubject = z.string().trim().min(1).max(500);
const channel = z.string().trim().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
const isoDate = z.string().datetime({ offset: true });

export const channelIdentityStatusSchema = z.enum(['active', 'suspended', 'revoked']);
export type ChannelIdentityStatus = z.infer<typeof channelIdentityStatusSchema>;
export const channelIdentitySubjectTypeSchema = z.enum(['agent', 'principal']);
export type ChannelIdentitySubjectType = z.infer<typeof channelIdentitySubjectTypeSchema>;
export const channelIdentityProvenanceSchema = z.object({
  source: z.enum(['manual', 'config', 'directory', 'platform']),
  reference: z.string().trim().min(1).max(500),
  verifiedAt: isoDate,
}).strict();

export const channelIdentitySchema = z.object({
  schemaVersion: z.literal('channel-identity/1'),
  channel,
  externalSubjectId: externalSubject,
  tenantId: tenantIdentifier,
  stableSubjectId: identifier,
  subjectType: channelIdentitySubjectTypeSchema,
  status: channelIdentityStatusSchema,
  verifiedAt: isoDate,
  provenance: channelIdentityProvenanceSchema,
}).strict();
export type ChannelIdentity = z.infer<typeof channelIdentitySchema>;

export interface ChannelIdentityLookup {
  channel: string;
  externalSubjectId: string;
  tenantId: string;
}

export interface ChannelIdentityResolver {
  init?(): Promise<void> | void;
  resolve(input: ChannelIdentityLookup): Promise<ChannelIdentity | undefined>;
  health?(): Promise<{ ready: boolean; detail: string }>;
  close?(): Promise<void>;
}

export class ChannelIdentityUnavailable extends Error {}

/** In-memory adapter for local development and deterministic protocol tests. */
export class InMemoryChannelIdentityResolver implements ChannelIdentityResolver {
  private readonly entries = new Map<string, ChannelIdentity>();

  constructor(entries: readonly ChannelIdentity[] = []) { for (const entry of entries) this.set(entry); }

  set(entry: ChannelIdentity): void {
    const parsed = channelIdentitySchema.parse(entry);
    this.entries.set(key(parsed.channel, parsed.externalSubjectId, parsed.tenantId), structuredClone(parsed));
  }

  revoke(channelValue: string, externalSubjectId: string, tenantId: string): void {
    const current = this.entries.get(key(channelValue, externalSubjectId, tenantId));
    if (!current) return;
    this.set({ ...current, status: 'revoked' });
  }

  async resolve(input: ChannelIdentityLookup): Promise<ChannelIdentity | undefined> {
    const entry = this.entries.get(key(input.channel, input.externalSubjectId, input.tenantId));
    return entry ? structuredClone(entry) : undefined;
  }

  async health(): Promise<{ ready: boolean; detail: string }> { return { ready: true, detail: 'in-memory channel identity resolver' }; }
  async close(): Promise<void> {}
}

/** Read-only JSON adapter. The file can contain an array or { identities }. */
export class JsonChannelIdentityResolver implements ChannelIdentityResolver {
  private entries = new Map<string, ChannelIdentity>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  init(): void {
    if (this.loaded) return;
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const values = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { identities?: unknown }).identities)
          ? (parsed as { identities: unknown[] }).identities : undefined);
      if (!values) throw new Error('channel identity file must be an array or an object with identities');
      for (const value of values) {
        const entry = channelIdentitySchema.parse(value);
        this.entries.set(key(entry.channel, entry.externalSubjectId, entry.tenantId), entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async resolve(input: ChannelIdentityLookup): Promise<ChannelIdentity | undefined> {
    this.init();
    const entry = this.entries.get(key(input.channel, input.externalSubjectId, input.tenantId));
    return entry ? structuredClone(entry) : undefined;
  }

  async health(): Promise<{ ready: boolean; detail: string }> { this.init(); return { ready: true, detail: 'file channel identity resolver loaded' }; }
  async close(): Promise<void> {}
}

/**
 * HTTPS adapter for an organization-owned identity service. The endpoint is
 * queried with channel, externalSubjectId and tenantId. It fails closed on
 * transport errors and rejects records whose key does not match the lookup.
 */
export class HttpChannelIdentityResolver implements ChannelIdentityResolver {
  private readonly endpoint: URL;

  constructor(
    endpoint: string,
    private readonly token?: string,
    private readonly timeoutMs = 5_000,
    allowInsecureHttp = false,
  ) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new Error('Channel identity URL must not contain credentials, query or fragment');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname);
    if (this.endpoint.protocol !== 'https:' && !(this.endpoint.protocol === 'http:' && (loopback || allowInsecureHttp))) throw new Error('Channel identity URL must use HTTPS except loopback');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('Channel identity timeout must be between 100 and 60000 milliseconds');
  }

  async resolve(input: ChannelIdentityLookup): Promise<ChannelIdentity | undefined> {
    const url = new URL(this.endpoint);
    url.searchParams.set('channel', input.channel);
    url.searchParams.set('externalSubjectId', input.externalSubjectId);
    url.searchParams.set('tenantId', input.tenantId);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      });
    } catch (error) {
      throw new ChannelIdentityUnavailable(`Channel identity request failed: ${error instanceof Error ? error.message : 'network error'}`);
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw new ChannelIdentityUnavailable(`Channel identity returned HTTP ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new ChannelIdentityUnavailable('Channel identity returned invalid JSON'); }
    const candidate = body && typeof body === 'object' && 'identity' in body ? (body as { identity: unknown }).identity : body;
    let parsed: ChannelIdentity;
    try { parsed = channelIdentitySchema.parse(candidate); }
    catch { throw new ChannelIdentityUnavailable('Channel identity returned an invalid record'); }
    if (parsed.channel !== input.channel || parsed.externalSubjectId !== input.externalSubjectId || parsed.tenantId !== input.tenantId) throw new ChannelIdentityUnavailable('Channel identity response does not match the lookup');
    return parsed;
  }

  async health(): Promise<{ ready: boolean; detail: string }> {
    try {
      await this.resolve({ channel: 'aeeis-health', externalSubjectId: 'aeeis-health-probe', tenantId: 'aeeis-health' });
      return { ready: true, detail: 'channel identity resolver reachable' };
    } catch (error) {
      // A deliberately non-existent identity is healthy when the service
      // returns 404; transport and protocol failures remain not ready.
      if (error instanceof ChannelIdentityUnavailable && /HTTP 404/.test(error.message)) return { ready: true, detail: 'channel identity resolver reachable' };
      return { ready: false, detail: 'channel identity resolver health probe failed' };
    }
  }

  async close(): Promise<void> {}
}

export function channelIdentityKey(input: ChannelIdentityLookup): string { return key(input.channel, input.externalSubjectId, input.tenantId); }

function key(channelValue: string, externalSubjectId: string, tenantId: string): string {
  return `${tenantId}\u0000${channelValue}\u0000${externalSubjectId}`;
}
