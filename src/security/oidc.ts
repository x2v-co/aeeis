import { createHash } from 'node:crypto';
import { JwksKeySet, isLoopback } from './jwks.js';
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

export type OidcConfig = z.input<typeof configSchema>;

/**
 * OIDC bearer resolver for a resource server. It validates the JWT locally
 * against a cached JWKS; the issuer is never trusted to choose a key or a
 * principal. Invalid tokens fail closed as an unauthenticated request.
 */
export class OidcPrincipalResolver {
  private readonly config: z.infer<typeof configSchema>;
  private readonly keySet: JwksKeySet;

  constructor(config: OidcConfig) {
    this.config = configSchema.parse(config);
    const issuer = new URL(this.config.issuer);
    if (issuer.protocol !== 'https:' && !isLoopback(issuer.hostname)) throw new Error('OIDC issuer must use HTTPS except loopback');
    if (issuer.username || issuer.password || issuer.hash) throw new Error('OIDC URLs must not contain credentials or fragments');
    this.keySet = new JwksKeySet(this.config.jwksUrl, { cacheTtlMs: this.config.cacheTtlMs, timeoutMs: this.config.timeoutMs, label: 'OIDC' });
  }

  resolver(): PrincipalResolver {
    return authorization => this.resolve(authorization);
  }

  async resolve(authorization: string | undefined): Promise<Principal | undefined> {
    const token = authorization && /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) return undefined;
    const payload = await this.keySet.verify(token);
    try { return payload ? this.claimsToPrincipal(payload) : undefined; } catch { return undefined; }
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

export function audienceContains(value: unknown, expected: string): boolean { return typeof value === 'string' ? value === expected : Array.isArray(value) && value.includes(expected); }
function claimValue(payload: Record<string, unknown>, path: string): unknown { return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>)[key] : undefined, payload); }
function safeIdentity(value: string, prefix: string): string {
  const direct = principalSchema.shape.id.safeParse(value);
  return direct.success ? direct.data : `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
}
