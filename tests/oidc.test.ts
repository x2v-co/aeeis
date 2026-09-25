import { afterEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OidcPrincipalResolver } from '../src/security/oidc.js';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function jwt(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], payload: Record<string, unknown>, kid = 'fixture-key'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid, typ: 'JWT' }); const body = encode(payload); const input = `${header}.${body}`;
  const signer = createSign('RSA-SHA256'); signer.update(input); signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}

describe('OIDC principal resolver', () => {
  it('verifies RS256 tokens against cached JWKS and maps claims to a scoped Principal', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = keys.publicKey.export({ format: 'jwk' });
    let jwksCalls = 0;
    const server = createServer((_request, response) => { jwksCalls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ keys: [{ ...jwk, kty: 'RSA', kid: 'fixture-key', use: 'sig', alg: 'RS256' }] })); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const resolver = new OidcPrincipalResolver({ issuer: `http://127.0.0.1:${port}/issuer`, audience: 'aeeis', jwksUrl: `http://127.0.0.1:${port}/jwks` });
    const token = jwt(keys.privateKey, { iss: `http://127.0.0.1:${port}/issuer`, aud: 'aeeis', sub: 'auth0|user-1', tenant_id: 'org/acme', roles: ['owner'], exp: Math.floor(Date.now() / 1000) + 300 });
    const principal = await resolver.resolve(`Bearer ${token}`);
    expect(principal).toMatchObject({ roles: ['owner'] });
    expect(principal?.id).toMatch(/^oidc_/);
    expect(principal?.tenantId).toMatch(/^oidc_tenant_/);
    expect(await resolver.resolve(`Bearer ${token}`)).toEqual(principal);
    expect(jwksCalls).toBe(1);
    expect(await resolver.resolve(`Bearer ${jwt(keys.privateKey, { iss: `http://127.0.0.1:${port}/issuer`, aud: 'wrong', sub: 'user', tenant_id: 'tenant', roles: ['owner'], exp: Math.floor(Date.now() / 1000) + 300 })}`)).toBeUndefined();
  });

  it('works as the asynchronous HTTP authentication boundary and fails closed for expired tokens', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 }); const jwk = keys.publicKey.export({ format: 'jwk' });
    const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ keys: [{ ...jwk, kty: 'RSA', kid: 'key', use: 'sig', alg: 'RS256' }] })); });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port; const issuer = `http://127.0.0.1:${port}/issuer`;
    const resolver = new OidcPrincipalResolver({ issuer, audience: 'aeeis', jwksUrl: `http://127.0.0.1:${port}/jwks` });
    const valid = jwt(keys.privateKey, { iss: issuer, aud: 'aeeis', sub: 'user', tenant_id: 'tenant', roles: ['owner'], exp: Math.floor(Date.now() / 1000) + 300 }, 'key');
    const expired = jwt(keys.privateKey, { iss: issuer, aud: 'aeeis', sub: 'user', tenant_id: 'tenant', roles: ['owner'], exp: Math.floor(Date.now() / 1000) - 600 }, 'key');
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-oidc-runs-'))); await repo.init();
    const app = buildApp({ repository: repo, principalResolver: resolver.resolver() });
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: `Bearer ${valid}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/runs', headers: { authorization: `Bearer ${expired}` } })).statusCode).toBe(401);
    await app.close(); await repo.close();
  });
});
