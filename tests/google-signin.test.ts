import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { GoogleSignIn, SESSION_COOKIE, safeReturnPath, type GoogleSignInConfig } from '../src/security/google-signin.js';
import { validateRuntimeConfig } from '../src/config-validation.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const REDIRECT = 'http://localhost:4323/auth/google/callback';
const SECRET = 'a-session-secret-that-is-long-enough-1234';

function idToken(claims: Record<string, unknown>, kid = 'k1'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.${sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url')}`;
}

/** A stand-in for Google's token and key endpoints. `claims` decides what the next ID token says. */
let fake: { server: Server; origin: string; tokenRequests: URLSearchParams[]; claims: (nonce: string) => Record<string, unknown> | undefined };
beforeEach(async () => {
  const state = { tokenRequests: [] as URLSearchParams[], claims: (nonce: string): Record<string, unknown> | undefined => validClaims(nonce) };
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/certs') { response.end(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'k1', use: 'sig', alg: 'RS256', n: jwk.n, e: jwk.e }] })); return; }
    if (request.url === '/token' && request.method === 'POST') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const form = new URLSearchParams(raw); state.tokenRequests.push(form);
      const claims = fake.claims(pendingNonce);
      if (!claims) { response.statusCode = 400; response.end(JSON.stringify({ error: 'invalid_grant' })); return; }
      response.end(JSON.stringify({ id_token: idToken(claims), access_token: 'unused' })); return;
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  fake = { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, ...state };
});
afterEach(async () => { await new Promise<void>(resolve => fake.server.close(() => resolve())); });

let pendingNonce = '';
function validClaims(nonce: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1001', email: 'Owner@X2V.co', email_verified: true, hd: 'x2v.co', nonce, iat: now, exp: now + 3600, ...extra };
}
function config(overrides: Partial<GoogleSignInConfig> = {}): GoogleSignInConfig {
  return {
    clientId: CLIENT_ID, clientSecret: 'client-secret', redirectUri: REDIRECT, sessionSecret: SECRET,
    users: { 'owner@x2v.co': { id: 'owner', tenantId: 'local', roles: ['owner', 'operator'] } },
    endpoints: { authorize: 'https://accounts.example/auth', token: `${fake.origin}/token`, jwks: `${fake.origin}/certs`, issuers: ['https://accounts.google.com'] },
    ...overrides,
  };
}
/** Start a sign-in, remember the nonce Google would echo, and return what the browser holds. */
function begin(signIn: GoogleSignIn, returnTo?: string) {
  const { location, cookie } = signIn.start(returnTo);
  const url = new URL(location);
  pendingNonce = url.searchParams.get('nonce')!;
  return { url, cookie: cookie.split(';')[0]!, state: url.searchParams.get('state')! };
}
const sessionFrom = (cookies: string[]) => cookies.find(item => item.startsWith(`${SESSION_COOKIE}=`) && !item.startsWith(`${SESSION_COOKIE}=;`))?.split(';')[0];

describe('Google sign-in', () => {
  it('sends the browser to Google with PKCE, state and nonce, and signs in a listed, verified address', async () => {
    const signIn = new GoogleSignIn(config());
    const { url, cookie, state } = begin(signIn, '/#room=abc');
    expect(url.origin + url.pathname).toBe('https://accounts.example/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email profile', code_challenge_method: 'S256' });
    expect(cookie.startsWith('__Host-aeeis_signin=')).toBe(true);

    fake.claims = nonce => validClaims(nonce, { name: ' Owner\u0007 Name ' });
    const result = await signIn.callback({ code: 'auth-code', state }, cookie);
    expect(result).toMatchObject({ ok: true, location: '/#room=abc', signedIn: { email: 'owner@x2v.co', name: 'Owner Name', via: 'listed', principal: { id: 'owner', tenantId: 'local' } } });
    expect(signIn.listedUsers()).toEqual([{ email: 'owner@x2v.co', principalId: 'owner', tenantId: 'local' }]);
    const form = fake.tokenRequests[0]!;
    expect(Object.fromEntries(form)).toMatchObject({ code: 'auth-code', client_id: CLIENT_ID, client_secret: 'client-secret', redirect_uri: REDIRECT, grant_type: 'authorization_code' });
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    const session = sessionFrom(result.cookies)!;
    expect(result.cookies.find(item => item.startsWith(SESSION_COOKIE))).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(signIn.session(session)).toEqual({ email: 'owner@x2v.co', principal: { id: 'owner', tenantId: 'local', roles: ['owner', 'operator'] } });
  });

  it('refuses a sign-in whose state, nonce, audience, issuer or verification does not match', async () => {
    const signIn = new GoogleSignIn(config());
    let attempt = begin(signIn);
    expect(await signIn.callback({ code: 'c', state: 'other' }, attempt.cookie)).toMatchObject({ ok: false, status: 400 });
    expect(await signIn.callback({ code: 'c', state: attempt.state }, undefined)).toMatchObject({ ok: false, status: 400 });
    for (const bad of [{ nonce: 'replayed' }, { aud: 'someone-else' }, { iss: 'https://evil.example' }, { email_verified: false }, { exp: Math.floor(Date.now() / 1000) - 3600 }]) {
      attempt = begin(signIn);
      fake.claims = nonce => validClaims(nonce, bad);
      expect(await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).toMatchObject({ ok: false, status: 401 });
    }
    attempt = begin(signIn);
    fake.claims = () => undefined;
    expect(await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).toMatchObject({ ok: false, status: 502 });
  });

  it('refuses an address that is not on the list, and admits a Workspace domain only by its hd claim', async () => {
    let signIn = new GoogleSignIn(config());
    let attempt = begin(signIn);
    fake.claims = nonce => validClaims(nonce, { email: 'stranger@gmail.com', hd: undefined });
    expect(await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).toMatchObject({ ok: false, status: 403 });

    signIn = new GoogleSignIn(config({ users: {}, allowedDomains: ['x2v.co'], domainTenantId: 'x2v', domainRoles: ['owner'] }));
    attempt = begin(signIn);
    fake.claims = nonce => validClaims(nonce, { sub: '2002', email: 'pm@x2v.co' });
    const admitted = await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie);
    expect(signIn.session(sessionFrom(admitted.cookies))?.principal).toEqual({ id: 'google:2002', tenantId: 'x2v', roles: ['owner'] });
    expect(admitted).toMatchObject({ ok: true, signedIn: { email: 'pm@x2v.co', via: 'domain', principal: { id: 'google:2002', tenantId: 'x2v' } } });
    // A personal account whose address merely ends in the domain has no hd claim.
    attempt = begin(signIn);
    fake.claims = nonce => validClaims(nonce, { sub: '3003', email: 'fake@x2v.co', hd: undefined });
    expect(await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).toMatchObject({ ok: false, status: 403 });
  });

  it('admits a listed third-party address only when the entry pins its Google account', async () => {
    // Google vouches for this address only as of when the Google account verified it; it may have changed hands since.
    const listedThirdParty = { 'owner@x2v.co': { id: 'owner', tenantId: 'local', roles: ['owner', 'operator'] as Array<'owner' | 'operator'> } };
    let signIn = new GoogleSignIn(config({ users: listedThirdParty }));
    let attempt = begin(signIn);
    fake.claims = nonce => validClaims(nonce, { sub: '9999', hd: undefined });
    const refused = await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie);
    expect(refused).toMatchObject({ ok: false, status: 403 });
    expect(refused.ok ? '' : refused.message).toContain('"sub": "9999"');

    signIn = new GoogleSignIn(config({ users: { 'owner@x2v.co': { ...listedThirdParty['owner@x2v.co'], sub: '1001' } } }));
    attempt = begin(signIn);
    expect(await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).toMatchObject({ ok: false, status: 403 });
    attempt = begin(signIn);
    fake.claims = nonce => validClaims(nonce, { sub: '1001', hd: undefined });
    const pinned = await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie);
    expect(signIn.session(sessionFrom(pinned.cookies))?.principal.id).toBe('owner');

    // A Gmail address needs no pin: Google is authoritative for it.
    signIn = new GoogleSignIn(config({ users: { 'someone@gmail.com': { id: 'someone', tenantId: 'local', roles: ['owner'] } } }));
    attempt = begin(signIn);
    fake.claims = nonce => validClaims(nonce, { sub: '4004', email: 'someone@gmail.com', hd: undefined });
    expect(await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).toMatchObject({ ok: true });
  });

  it('re-checks a pinned account on every request', async () => {
    const signIn = new GoogleSignIn(config());
    const attempt = begin(signIn);
    const session = sessionFrom((await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).cookies)!;
    expect(new GoogleSignIn(config({ users: { 'owner@x2v.co': { id: 'owner', tenantId: 'local', roles: ['owner'], sub: '1001' } } })).session(session)?.principal.id).toBe('owner');
    expect(new GoogleSignIn(config({ users: { 'owner@x2v.co': { id: 'owner', tenantId: 'local', roles: ['owner'], sub: 'someone-else' } } })).session(session)).toBeUndefined();
  });

  it('rejects a tampered or expired session and drops someone removed from the list', async () => {
    const signIn = new GoogleSignIn(config());
    const attempt = begin(signIn);
    const session = sessionFrom((await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).cookies)!;
    const [name, value] = session.split('=');
    const [body, mac] = value!.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), email: 'other@x2v.co' })).toString('base64url');
    expect(signIn.session(`${name}=${forged}.${mac}`)).toBeUndefined();
    expect(new GoogleSignIn(config({ sessionSecret: 'another-secret-that-is-long-enough-5678' })).session(session)).toBeUndefined();
    expect(new GoogleSignIn(config({ users: { 'someone@x2v.co': { id: 'someone', tenantId: 'local', roles: ['owner'] } } })).session(session)).toBeUndefined();
    const realNow = Date.now;
    try { Date.now = () => realNow() + 8 * 86_400_000; expect(signIn.session(session)).toBeUndefined(); }
    finally { Date.now = realNow; }
  });

  it('only returns to a path on this site', () => {
    expect(safeReturnPath('/#room=1')).toBe('/#room=1');
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil', 'javascript:alert(1)', '/auth/signout', undefined]) expect(safeReturnPath(bad)).toBe('/');
  });

  it('needs an allow-list and an HTTPS callback outside loopback', () => {
    expect(() => new GoogleSignIn(config({ users: {} }))).toThrow(/allowed user or domain/);
    expect(() => new GoogleSignIn(config({ redirectUri: 'http://aeeis.example/auth/google/callback' }))).toThrow(/HTTPS/);
    expect(() => new GoogleSignIn(config({ redirectUri: 'https://aeeis.example/callback' }))).toThrow(/auth\/google\/callback/);
    expect(() => new GoogleSignIn(config({ sessionSecret: 'short' }))).toThrow();
  });
});

describe('Google sign-in over HTTP', () => {
  it('signs in through the callback, then the session cookie alone opens the API; a bearer header does not', async () => {
    const app = buildApp({ repository: new InMemoryRunRepository(), googleSignIn: new GoogleSignIn(config()), authMode: 'google-principal-scoped' });
    try {
      expect((await app.inject({ method: 'GET', url: '/auth/session' })).json()).toEqual({ mode: 'google', signedIn: false });
      const denied = await app.inject({ method: 'GET', url: '/api/status' });
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: 'Sign-in required' });
      expect((await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer anything' } })).statusCode).toBe(401);

      const started = await app.inject({ method: 'GET', url: '/auth/google/start?return=%2F%23room%3D1' });
      expect(started.statusCode).toBe(302);
      const google = new URL(started.headers.location as string);
      pendingNonce = google.searchParams.get('nonce')!;
      const signinCookie = String(started.headers['set-cookie']).split(';')[0]!;
      // Google sends the browser back with a cross-site top-level navigation.
      const callback = await app.inject({ method: 'GET', url: `/auth/google/callback?code=abc&state=${google.searchParams.get('state')}`,
        headers: { cookie: signinCookie, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
      // A redirect would carry the cross-site mark on to `/` and be refused; a page of our own moves on instead.
      expect(callback.statusCode).toBe(200);
      expect(callback.headers.location).toBeUndefined();
      expect(callback.body).toContain('<meta http-equiv="refresh" content="0;url=/#room=1">');
      // The request that follows is a same-origin navigation and reaches the page; a cross-site one still does not.
      expect((await app.inject({ method: 'GET', url: '/', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).statusCode).toBe(403);
      const session = sessionFrom([callback.headers['set-cookie']].flat() as string[])!;

      const status = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: session } });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ principal: 'owner', tenantId: 'local', mode: 'google-principal-scoped' });
      expect((await app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: session } })).json()).toEqual({ mode: 'google', signedIn: true, email: 'owner@x2v.co' });
      // The sign-in is now in the tenant's member list, with the address it came from.
      expect((await app.inject({ method: 'GET', url: '/api/members', headers: { cookie: session } })).json()).toMatchObject({ signIn: 'google', members: [{ principalId: 'owner', email: 'owner@x2v.co', source: 'listed', isSelf: true, lastSignInAt: expect.any(String) }] });
      // A cross-site request never rides on the cookie.
      expect((await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: session, 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);

      const out = await app.inject({ method: 'POST', url: '/auth/signout', headers: { cookie: session } });
      expect(out.statusCode).toBe(204);
      expect(String(out.headers['set-cookie'])).toMatch(/^__Host-aeeis_session=; Path=\/; Max-Age=0/);
    } finally { await app.close(); }
  });

  it('shows a plain page when the address is not allowed', async () => {
    const app = buildApp({ repository: new InMemoryRunRepository(), googleSignIn: new GoogleSignIn(config()) });
    try {
      const started = await app.inject({ method: 'GET', url: '/auth/google/start' });
      const google = new URL(started.headers.location as string);
      pendingNonce = google.searchParams.get('nonce')!;
      fake.claims = nonce => validClaims(nonce, { email: 'stranger@gmail.com', hd: undefined });
      const page = await app.inject({ method: 'GET', url: `/auth/google/callback?code=abc&state=${google.searchParams.get('state')}`, headers: { cookie: String(started.headers['set-cookie']).split(';')[0]! } });
      expect(page.statusCode).toBe(403);
      expect(page.headers['content-type']).toMatch(/text\/html/);
      expect(page.body).toContain('stranger@gmail.com 没有权限');
      expect(sessionFrom([page.headers['set-cookie']].flat() as string[])).toBeUndefined();
    } finally { await app.close(); }
  });

  it('reports the access-token mode to the page when Google sign-in is off', async () => {
    const app = buildApp({ repository: new InMemoryRunRepository(), token: 'local-token' });
    try {
      expect((await app.inject({ method: 'GET', url: '/auth/session' })).json()).toEqual({ mode: 'token' });
      expect((await app.inject({ method: 'GET', url: '/auth/google/start' })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('refuses to combine Google sign-in with a shared token', () => {
    expect(() => buildApp({ repository: new InMemoryRunRepository(), token: 't', googleSignIn: new GoogleSignIn(config()) })).toThrow(/cannot be combined/);
  });

  it('lets a machine use its own principal token beside Google sign-in, without falling back to a cookie', async () => {
    const signIn = new GoogleSignIn(config());
    const app = buildApp({ repository: new InMemoryRunRepository(), googleSignIn: signIn, principalTokens: { 'scraper-token': { id: 'metrics', tenantId: 'local', roles: ['operator'] } } });
    try {
      expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer scraper-token' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
      const attempt = begin(signIn);
      const session = sessionFrom((await signIn.callback({ code: 'c', state: attempt.state }, attempt.cookie)).cookies)!;
      expect((await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: session } })).json()).toMatchObject({ principal: 'owner' });
      // A wrong bearer is refused even next to a valid session cookie.
      expect((await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: session, authorization: 'Bearer wrong' } })).statusCode).toBe(401);
      // The scraper's principal has no owner role: it cannot act as a person.
      expect((await app.inject({ method: 'GET', url: '/api/bots', headers: { authorization: 'Bearer scraper-token' } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});

describe('Google sign-in configuration', () => {
  const base = { AEEIS_GOOGLE_CLIENT_ID: CLIENT_ID, AEEIS_GOOGLE_CLIENT_SECRET: 's', AEEIS_GOOGLE_REDIRECT_URI: REDIRECT, AEEIS_SESSION_SECRET: SECRET, AEEIS_GOOGLE_USERS: '{"owner@x2v.co":{"id":"owner","tenantId":"local","roles":["owner"]}}' };
  it('accepts Google sign-in as the only sign-in method and checks its settings', () => {
    expect(() => validateRuntimeConfig(base)).not.toThrow();
    expect(() => validateRuntimeConfig({ ...base, AEEIS_ACCESS_TOKEN: 'x' })).toThrow(/cannot be combined/);
    expect(() => validateRuntimeConfig({ ...base, AEEIS_PRINCIPAL_TOKENS: '{"scraper-token":{"id":"metrics","tenantId":"local","roles":["operator"]}}' })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...base, AEEIS_SESSION_SECRET: 'short' })).toThrow(/32 characters/);
    expect(() => validateRuntimeConfig({ ...base, AEEIS_GOOGLE_USERS: undefined })).toThrow(/nobody else may sign in/);
    expect(() => validateRuntimeConfig({ ...base, AEEIS_GOOGLE_CLIENT_SECRET: undefined })).toThrow(/AEEIS_GOOGLE_CLIENT_SECRET/);
    expect(() => validateRuntimeConfig({ ...base, AEEIS_GOOGLE_USERS: undefined, AEEIS_GOOGLE_ALLOWED_DOMAINS: 'x2v.co' })).toThrow(/DOMAIN_TENANT/);
  });
});
