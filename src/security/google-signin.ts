import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { JwksKeySet, isLoopback } from './jwks.js';
import { audienceContains } from './oidc.js';
import { principalSchema, type Principal } from './principal.js';

/** Who may sign in, and as whom. Emails are matched lower-cased; a listed email keeps its identity across sign-ins.
 * `sub` pins the entry to one Google account. It is required for an address Google is not authoritative for (not
 * Gmail, not a Workspace account of its own domain): such an address may have changed hands since that Google
 * account verified it. */
const userSchema = z.object({ id: principalSchema.shape.id, tenantId: principalSchema.shape.tenantId, roles: principalSchema.shape.roles, sub: z.string().trim().min(1).max(500).optional() }).strict();
export const googleUsersSchema = z.record(z.string().trim().toLowerCase().email().max(320), userSchema);
const roleSchema = z.enum(['owner', 'agent', 'operator']);

const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

const configSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(500),
  redirectUri: z.string().url(),
  /** Signs the session and sign-in cookies. At least 32 characters; changing it signs everyone out. */
  sessionSecret: z.string().min(32).max(4096),
  users: googleUsersSchema.default({}),
  /** Google Workspace domains whose verified accounts may sign in. Checked against the token's `hd` claim. */
  allowedDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(20).default([]),
  domainTenantId: principalSchema.shape.tenantId.optional(),
  domainRoles: z.array(roleSchema).min(1).max(3).default(['owner']),
  sessionTtlSeconds: z.number().int().min(300).max(30 * 86_400).default(7 * 86_400),
  /** Google's endpoints; tests point them at a local fake. */
  endpoints: z.object({
    authorize: z.string().url(), token: z.string().url(), jwks: z.string().url(), issuers: z.array(z.string().min(1)).min(1),
  }).strict().default(GOOGLE_ENDPOINTS),
  timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  clockSkewSeconds: z.number().int().min(0).max(300).default(60),
}).strict().superRefine((config, context) => {
  if (!Object.keys(config.users).length && !config.allowedDomains.length) context.addIssue({ code: 'custom', message: 'Google sign-in needs at least one allowed user or domain' });
  if (config.allowedDomains.length && !config.domainTenantId) context.addIssue({ code: 'custom', message: 'Google sign-in with allowed domains needs a tenant for those users' });
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== 'https:' && !isLoopback(redirect.hostname)) context.addIssue({ code: 'custom', message: 'Google sign-in redirect URI must use HTTPS except loopback' });
  if (redirect.pathname !== GOOGLE_CALLBACK_PATH || redirect.search || redirect.hash) context.addIssue({ code: 'custom', message: `Google sign-in redirect URI must end in ${GOOGLE_CALLBACK_PATH}` });
});
export type GoogleSignInConfig = z.input<typeof configSchema>;

export const GOOGLE_START_PATH = '/auth/google/start';
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback';
export const SESSION_COOKIE = '__Host-aeeis_session';
const SIGNIN_COOKIE = '__Host-aeeis_signin';
const SIGNIN_TTL_SECONDS = 600;

export interface SignInSession { email: string; principal: Principal }
/** Who just signed in, for the tenant's member list. `via` says whether the allow-list or the domain admitted them. */
export interface SignedIn { principal: Principal; email: string; name?: string; via: 'listed' | 'domain' }
export type CallbackResult =
  | { ok: true; location: string; cookies: string[]; signedIn: SignedIn }
  | { ok: false; status: number; message: string; cookies: string[] };

const sessionPayloadSchema = z.object({ v: z.literal(1), sub: z.string().min(1).max(500), email: z.string().min(3).max(320), hd: z.string().max(253).optional(), iat: z.number(), exp: z.number() }).strict();
const signInPayloadSchema = z.object({ v: z.literal(1), state: z.string(), nonce: z.string(), verifier: z.string(), returnTo: z.string(), exp: z.number() }).strict();

/**
 * Google sign-in for the web page, done on the server: the browser never holds a Google token. After Google
 * confirms a verified address on the allow-list, the server sets a signed, HttpOnly session cookie. Every request
 * re-checks the session's address against the current allow-list, so removing someone takes effect at once.
 */
export class GoogleSignIn {
  private readonly config: z.infer<typeof configSchema>;
  private readonly keySet: JwksKeySet;
  private readonly sessionKey: Buffer;
  private readonly signInKey: Buffer;

  constructor(config: GoogleSignInConfig) {
    this.config = configSchema.parse(config);
    this.keySet = new JwksKeySet(this.config.endpoints.jwks, { cacheTtlMs: 3_600_000, timeoutMs: this.config.timeoutMs, label: 'Google' });
    this.sessionKey = createHmac('sha256', this.config.sessionSecret).update('aeeis-session/1').digest();
    this.signInKey = createHmac('sha256', this.config.sessionSecret).update('aeeis-signin/1').digest();
  }

  /** Where to send the browser to sign in, and the short-lived cookie that ties Google's answer to this browser. */
  start(returnTo: string | undefined): { location: string; cookie: string } {
    const state = token(), nonce = token(), verifier = token(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const payload = { v: 1 as const, state, nonce, verifier, returnTo: safeReturnPath(returnTo), exp: now() + SIGNIN_TTL_SECONDS };
    const url = new URL(this.config.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      ...(this.config.allowedDomains.length === 1 && !Object.keys(this.config.users).length ? { hd: this.config.allowedDomains[0]! } : {}),
    }).toString();
    return { location: url.toString(), cookie: cookie(SIGNIN_COOKIE, seal(payload, this.signInKey), SIGNIN_TTL_SECONDS) };
  }

  async callback(query: Record<string, unknown>, cookieHeader: string | undefined): Promise<CallbackResult> {
    const clear = [cookie(SIGNIN_COOKIE, '', 0)];
    const pending = open(readCookie(cookieHeader, SIGNIN_COOKIE), this.signInKey, signInPayloadSchema);
    if (!pending || pending.exp < now()) return { ok: false, status: 400, message: '登录已过期，请重新登录。', cookies: clear };
    if (typeof query.state !== 'string' || !safeEqual(query.state, pending.state)) return { ok: false, status: 400, message: '登录请求不匹配，请重新登录。', cookies: clear };
    if (typeof query.error === 'string') return { ok: false, status: 400, message: '已取消 Google 登录。', cookies: clear };
    if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) return { ok: false, status: 400, message: 'Google 没有返回登录结果，请重新登录。', cookies: clear };
    let idToken: string;
    try {
      const response = await fetch(this.config.endpoints.token, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ code: query.code, client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: this.config.redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier }).toString(),
      });
      const body = await response.json().catch(() => undefined) as { id_token?: unknown } | undefined;
      if (!response.ok || typeof body?.id_token !== 'string') return { ok: false, status: 502, message: 'Google 登录暂时不可用，请稍后再试。', cookies: clear };
      idToken = body.id_token;
    } catch {
      return { ok: false, status: 502, message: 'Google 登录暂时不可用，请稍后再试。', cookies: clear };
    }
    const claims = await this.keySet.verify(idToken);
    const identity = claims ? this.verifiedIdentity(claims, pending.nonce) : undefined;
    if (!identity) return { ok: false, status: 401, message: 'Google 登录结果无法验证，请重新登录。', cookies: clear };
    const principal = this.principalFor(identity);
    if (!principal) {
      const listed = this.config.users[identity.email];
      const message = listed && !listed.sub && !googleAuthoritative(identity)
        ? `${identity.email} 不是 Gmail 或这个域自己的 Google Workspace 账号，Google 不能保证它现在仍属于你。请让管理员在名单里为这个地址写上 "sub": "${identity.sub}"，确认是这个 Google 账号。`
        : `${identity.email} 没有权限使用这个 AEEIS。请让管理员把这个地址加进名单。`;
      return { ok: false, status: 403, message, cookies: clear };
    }
    const issuedAt = now();
    const session = seal({ v: 1 as const, sub: identity.sub, email: identity.email, ...(identity.hd ? { hd: identity.hd } : {}), iat: issuedAt, exp: issuedAt + this.config.sessionTtlSeconds }, this.sessionKey);
    const signedIn: SignedIn = { principal, email: identity.email, ...(identity.name ? { name: identity.name } : {}), via: this.config.users[identity.email] ? 'listed' : 'domain' };
    return { ok: true, location: pending.returnTo, cookies: [...clear, cookie(SESSION_COOKIE, session, this.config.sessionTtlSeconds)], signedIn };
  }

  /** The signed-in person for this request's cookies, if the session is valid and still allowed. */
  session(cookieHeader: string | undefined): SignInSession | undefined {
    const payload = open(readCookie(cookieHeader, SESSION_COOKIE), this.sessionKey, sessionPayloadSchema);
    if (!payload || payload.exp < now()) return undefined;
    const principal = this.principalFor(payload);
    return principal ? { email: payload.email, principal } : undefined;
  }

  signOutCookie(): string { return cookie(SESSION_COOKIE, '', 0); }

  /** The allow-list as addresses and the people they sign in as. Never the pinned Google account. */
  listedUsers(): Array<{ email: string; principalId: string; tenantId: string }> {
    return Object.entries(this.config.users).map(([email, user]) => ({ email, principalId: user.id, tenantId: user.tenantId }));
  }

  private verifiedIdentity(claims: Record<string, unknown>, nonce: string): { sub: string; email: string; hd?: string; name?: string } | undefined {
    const time = now(), skew = this.config.clockSkewSeconds;
    if (typeof claims.iss !== 'string' || !this.config.endpoints.issuers.includes(claims.iss)) return undefined;
    if (!audienceContains(claims.aud, this.config.clientId)) return undefined;
    if (typeof claims.exp !== 'number' || claims.exp < time - skew) return undefined;
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > time + skew)) return undefined;
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, nonce)) return undefined;
    if (claims.email_verified !== true || typeof claims.email !== 'string' || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 500) return undefined;
    const email = claims.email.trim().toLowerCase();
    if (!z.string().email().max(320).safeParse(email).success) return undefined;
    // The Google name is only a label for the member list; it never decides access.
    const name = typeof claims.name === 'string' ? claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) : '';
    return { sub: claims.sub, email, ...(typeof claims.hd === 'string' ? { hd: claims.hd.toLowerCase() } : {}), ...(name ? { name } : {}) };
  }

  private principalFor(identity: { sub: string; email: string; hd?: string | undefined }): Principal | undefined {
    const listed = this.config.users[identity.email];
    if (listed) {
      // A pinned entry admits only that Google account; an unpinned one only an address Google vouches for today.
      if (listed.sub ? listed.sub !== identity.sub : !googleAuthoritative(identity)) return undefined;
      return principalSchema.parse({ id: listed.id, tenantId: listed.tenantId, roles: [...listed.roles] });
    }
    if (identity.hd && this.config.allowedDomains.includes(identity.hd) && identity.email.endsWith(`@${identity.hd}`)) {
      const id = `google:${identity.sub}`;
      return principalSchema.safeParse({ id, tenantId: this.config.domainTenantId, roles: this.config.domainRoles }).success
        ? principalSchema.parse({ id, tenantId: this.config.domainTenantId, roles: [...new Set(this.config.domainRoles)] })
        : undefined;
    }
    return undefined;
  }
}

/** Google is authoritative for an address only when it is a Gmail address, or a Workspace account whose `hd` is the
 * address's own domain. Any other address was verified once, when the Google account was set up. */
function googleAuthoritative(identity: { email: string; hd?: string | undefined }): boolean {
  const domain = identity.email.slice(identity.email.lastIndexOf('@') + 1);
  return domain === 'gmail.com' || domain === 'googlemail.com' || (identity.hd !== undefined && identity.hd === domain);
}
/** Only a same-site path: never another origin, a protocol-relative URL or a back-slashed path. */
export function safeReturnPath(value: string | undefined): string {
  if (!value || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return '/';
  return value.startsWith('/auth/') ? '/' : value;
}
function seal(payload: object, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}
function open<T>(value: string | undefined, key: Buffer, schema: z.ZodType<T>): T | undefined {
  if (!value || value.length > 4096) return undefined;
  const [body, mac, extra] = value.split('.');
  if (!body || !mac || extra !== undefined) return undefined;
  const expected = createHmac('sha256', key).update(body).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(mac, 'base64url'); } catch { return undefined; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  try { const parsed = schema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest(), right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
function token(bytes = 32): string { return randomBytes(bytes).toString('base64url'); }
function now(): number { return Math.floor(Date.now() / 1000); }
