import { createHash, createPublicKey, createVerify, type JsonWebKey as NodeJsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { principalSchema, type Principal, type PrincipalResolver } from './principal.js';

const urlSchema = z.string().url();
const configSchema = z.object({
  issuer: urlSchema,
  audience: z.string().trim().min(1).max(500),
  jwksUrl: urlSchema,
  tenantClaim: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,128}$/).default('tenant_id'),
  rolesClaim: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,128}$/).default('roles'),
  cacheTtlMs: z.number().int().min(10_000).max(86_400_000).default(300_000),
  clockSkewSeconds: z.number().int().min(0).max(300).default(60),
  timeoutMs: z.number().int().min(500).max(30_000).default(5_000),
}).strict();
const jwksSchema = z.object({ keys: z.array(z.object({
  kty: z.literal('RSA'), kid: z.string().min(1).max(200), n: z.string().min(1), e: z.string().min(1),
  use: z.string().optional(), alg: z.string().optional(),
}).strict()).max(100) }).strict();
const headerSchema = z.object({ alg: z.literal('RS256'), kid: z.string().min(1).max(200), typ: z.string().optional() }).strict();

export type OidcConfig = z.input<typeof configSchema>;

/**
 * OIDC bearer resolver for a resource server. It validates the JWT locally
 * against a cached JWKS; the issuer is never trusted to choose a key or a
 * principal. Invalid tokens fail closed as an unauthenticated request.
 */
export class OidcPrincipalResolver {
  private readonly config: z.infer<typeof configSchema>;
  private keys = new Map<string, KeyObject>();
  private cachedAt = 0;
  private refreshInFlight: Promise<void> | undefined;

  constructor(config: OidcConfig) {
    this.config = configSchema.parse(config);
    const issuer = new URL(this.config.issuer);
    const jwks = new URL(this.config.jwksUrl);
    if (issuer.protocol !== 'https:' && !isLoopback(issuer.hostname)) throw new Error('OIDC issuer must use HTTPS except loopback');
    if (jwks.protocol !== 'https:' && !isLoopback(jwks.hostname)) throw new Error('OIDC JWKS URL must use HTTPS except loopback');
    if (issuer.username || issuer.password || issuer.hash || jwks.username || jwks.password || jwks.hash) throw new Error('OIDC URLs must not contain credentials or fragments');
  }

  resolver(): PrincipalResolver {
    return authorization => this.resolve(authorization);
  }

  async resolve(authorization: string | undefined): Promise<Principal | undefined> {
    const token = authorization && /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) return undefined;
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return undefined;
      const header = headerSchema.parse(parseJson(parts[0]!));
      const payload = parseJson(parts[1]!);
      const signature = decodeBase64Url(parts[2]!);
      let key = this.keys.get(header.kid);
      const stale = Date.now() - this.cachedAt >= this.config.cacheTtlMs;
      if (!key || stale) {
        try { await this.refresh(!key); } catch { if (!key) return undefined; }
        key = this.keys.get(header.kid);
      }
      if (!key) return undefined;
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${parts[0]}.${parts[1]}`); verifier.end();
      if (!verifier.verify(key, signature)) return undefined;
      return this.claimsToPrincipal(payload);
    } catch {
      return undefined;
    }
  }

  private async refresh(force: boolean): Promise<void> {
    if (!force && Date.now() - this.cachedAt < this.config.cacheTtlMs) return;
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = (async () => {
      const response = await fetch(this.config.jwksUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`OIDC JWKS returned HTTP ${response.status}`);
      const body = jwksSchema.parse(await response.json());
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys) {
        if (jwk.use && jwk.use !== 'sig') continue;
        if (jwk.alg && jwk.alg !== 'RS256') continue;
        next.set(jwk.kid, createPublicKey({ key: jwk as unknown as NodeJsonWebKey, format: 'jwk' }));
      }
      if (next.size === 0) throw new Error('OIDC JWKS contains no usable RS256 signing key');
      this.keys = next; this.cachedAt = Date.now();
    })();
    try { await this.refreshInFlight; } finally { this.refreshInFlight = undefined; }
  }

  private claimsToPrincipal(payload: Record<string, unknown>): Principal | undefined {
    if (payload.iss !== this.config.issuer || !audienceContains(payload.aud, this.config.audience)) return undefined;
    const now = Math.floor(Date.now() / 1000); const skew = this.config.clockSkewSeconds;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < now - skew) return undefined;
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now + skew)) return undefined;
    if (typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 500) return undefined;
    const tenant = claimValue(payload, this.config.tenantClaim);
    const roleValue = claimValue(payload, this.config.rolesClaim);
    if (typeof tenant !== 'string' || tenant.length < 1 || tenant.length > 500 || !Array.isArray(roleValue)) return undefined;
    const roles = [...new Set(roleValue.filter((role): role is string => typeof role === 'string').filter(role => role === 'owner' || role === 'agent' || role === 'operator'))];
    if (roles.length === 0) return undefined;
    return principalSchema.parse({ id: safeIdentity(payload.sub, 'oidc'), tenantId: safeIdentity(tenant, 'oidc_tenant'), roles });
  }
}

export function createOidcPrincipalResolver(config: OidcConfig): PrincipalResolver {
  return new OidcPrincipalResolver(config).resolver();
}

function parseJson(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JWT segment must be an object');
  return parsed as Record<string, unknown>;
}
function decodeBase64Url(value: string): Buffer { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid JWT signature'); return Buffer.from(value, 'base64url'); }
function audienceContains(value: unknown, expected: string): boolean { return typeof value === 'string' ? value === expected : Array.isArray(value) && value.includes(expected); }
function claimValue(payload: Record<string, unknown>, path: string): unknown { return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined, payload); }
function safeIdentity(value: string, prefix: string): string {
  const direct = principalSchema.shape.id.safeParse(value);
  return direct.success ? direct.data : `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}
function isLoopback(hostname: string): boolean { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'; }
