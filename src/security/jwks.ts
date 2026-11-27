import { createPublicKey, createVerify, type JsonWebKey as NodeJsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';

const jwksSchema = z.object({ keys: z.array(z.object({
  kty: z.string(), kid: z.string().min(1).max(200).optional(), n: z.string().min(1).optional(), e: z.string().min(1).optional(),
  use: z.string().optional(), alg: z.string().optional(),
}).passthrough()).max(100) }).passthrough();
const headerSchema = z.object({ alg: z.literal('RS256'), kid: z.string().min(1).max(200), typ: z.string().optional() }).strict();

export interface JwksKeySetOptions { cacheTtlMs: number; timeoutMs: number; label: string }

/**
 * RS256 keys from one JWKS URL, cached and refreshed on an unknown key id. The token never chooses the key set:
 * a JWT verifies only against keys this URL served. Callers check the claims themselves.
 */
export class JwksKeySet {
  private keys = new Map<string, KeyObject>();
  private cachedAt = 0;
  private refreshInFlight: Promise<void> | undefined;

  constructor(private readonly url: string, private readonly options: JwksKeySetOptions) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) throw new Error(`${options.label} JWKS URL must use HTTPS except loopback`);
    if (parsed.username || parsed.password || parsed.hash) throw new Error(`${options.label} JWKS URL must not contain credentials or fragments`);
  }

  /** The verified payload, or undefined for anything malformed, unsigned by a served key, or unverifiable. */
  async verify(token: string): Promise<Record<string, unknown> | undefined> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      const header = headerSchema.parse(parseJwtSegment(parts[0]!));
      const payload = parseJwtSegment(parts[1]!);
      const signature = decodeBase64Url(parts[2]!);
      let key = this.keys.get(header.kid);
      const stale = Date.now() - this.cachedAt >= this.options.cacheTtlMs;
      if (!key || stale) {
        try { await this.refresh(!key); } catch { if (!key) return undefined; }
        key = this.keys.get(header.kid);
      }
      if (!key) return undefined;
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${parts[0]}.${parts[1]}`); verifier.end();
      return verifier.verify(key, signature) ? payload : undefined;
    } catch {
      return undefined;
    }
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && Date.now() - this.cachedAt < this.options.cacheTtlMs) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const response = await fetch(this.url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`${this.options.label} JWKS returned HTTP ${response.status}`);
      const body = jwksSchema.parse(await response.json());
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys) {
        if (jwk.kty !== 'RSA' || !jwk.kid || !jwk.n || !jwk.e) continue;
        if (jwk.use && jwk.use !== 'sig') continue;
        if (jwk.alg && jwk.alg !== 'RS256') continue;
        next.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e } as NodeJsonWebKey, format: 'jwk' }));
      }
      if (next.size === 0) throw new Error(`${this.options.label} JWKS contains no usable RS256 signing key`);
      this.keys = next; this.cachedAt = Date.now();
    })();
    try { await this.refreshInFlight; } finally { this.refreshInFlight = undefined; }
  }
}

export function parseJwtSegment(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JWT segment must be an object');
  return parsed as Record<string, unknown>;
}
function decodeBase64Url(value: string): Buffer { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid JWT signature'); return Buffer.from(value, 'base64url'); }
export function isLoopback(hostname: string): boolean { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'; }
