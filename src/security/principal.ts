import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/);
export const principalSchema = z.object({
  id: identity,
  tenantId: identity,
  roles: z.array(z.enum(['owner', 'agent', 'operator'])).max(3),
}).strict();
export type Principal = z.infer<typeof principalSchema>;
export interface Ownership { owner: string; tenantId: string }
export const localPrincipal = (): Principal => ({ id: 'owner', tenantId: 'local', roles: ['owner', 'operator'] });
export const validatePrincipal = (principal: unknown): Principal => principalSchema.parse(principal);
export const principalTokensSchema = z.record(z.string().regex(/^\S+$/).max(4096), principalSchema);
export type PrincipalResolver = (authorization: string | undefined) => Principal | undefined | Promise<Principal | undefined>;
export const ownershipOf = (principal: Principal): Ownership => ({ owner: principal.id, tenantId: principal.tenantId });
export function isOwnedBy(record: { owner?: string | undefined; tenantId?: string | undefined }, scope: Ownership): boolean {
  return (record.owner ?? 'owner') === scope.owner && (record.tenantId ?? 'local') === scope.tenantId;
}
/** Existing knowledge audience ACLs are strings. Encode both identity parts
 * without collisions while preserving the local owner's historical audience. */
export function principalAudience(principal: Pick<Principal, 'id' | 'tenantId'>): string {
  return principal.tenantId === 'local' ? principal.id : JSON.stringify([principal.tenantId, principal.id]);
}
export function brainActor(actor: Principal | string): Principal {
  return typeof actor === 'string'
    ? { id: actor, tenantId: 'local', roles: actor === 'owner' ? ['owner'] : ['agent'] }
    : validatePrincipal(actor);
}

/** Copy and validate credentials once at startup; compare fixed-size hashes.
 * No credential or digest is exposed through status or error responses. */
export function principalResolver(tokens: Record<string, Principal> | undefined): PrincipalResolver {
  if (tokens === undefined) return () => localPrincipal();
  const entries = Object.entries(principalTokensSchema.parse(tokens)).map(([token, principal]) => ({ digest: hash(token), principal }));
  return authorization => {
    const token = authorization && /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) return undefined;
    const digest = hash(token);
    let match: Principal | undefined;
    for (const entry of entries) if (timingSafeEqual(entry.digest, digest)) match = entry.principal;
    return match ? structuredClone(match) : undefined;
  };
}
function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }
