import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { ToolkitRegistryGateway } from '../src/integrations.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function canonical(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)]));
  return value;
}
function digest(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function jwk(key: ReturnType<typeof generateKeyPairSync>['publicKey']): Record<string, unknown> { return key.export({ format: 'jwk' }) as Record<string, unknown>; }
function envelope(payload: Record<string, unknown>, key: ReturnType<typeof generateKeyPairSync>['privateKey'], keyId: string): Record<string, unknown> {
  const digestValue = digest(payload);
  const value = sign(null, Buffer.from(digestValue), key).toString('base64url');
  return { ...payload, digest: digestValue, signature: { alg: 'EdDSA', keyId, createdAt: new Date().toISOString(), payloadDigest: digestValue, value: `ed25519:${value}` } };
}

function startFixture(escapeEndpoint = false, signed = false): Promise<{ url: string; rootJwk?: Record<string, unknown> }> {
  return new Promise(resolve => {
    const artifact = signed ? generateKeyPairSync('ed25519') : undefined;
    const root = signed ? generateKeyPairSync('ed25519') : undefined;
    const wrap = (payload: Record<string, unknown>, keyId = 'artifact') => signed ? envelope(payload, keyId === 'root' ? root!.privateKey : artifact!.privateKey, keyId) : payload;
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (signed && request.url === '/api/v1/registry/keysets/current') {
        const payload = { schemaVersion: 'toolkit.registry.keyset.v1', registryId: 'test', keysetVersion: 1, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), keys: [{ ...jwk(artifact!.publicKey), kid: 'artifact', use: 'sig', alg: 'EdDSA' }], revokedKeys: [], root: { kid: 'root', publicKey: { ...jwk(root!.publicKey), kid: 'root', use: 'sig', alg: 'EdDSA' } } };
        response.end(JSON.stringify(wrap(payload, 'root'))); return;
      }
      if (request.url === '/api/v1/registry/manifest') {
        response.end(JSON.stringify(wrap({ schemaVersion: 'toolkit.registry.index.v1', tools: [{ slug: 'echo', version: 3, manifestUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/registry/tools/echo/manifest` }] })));
        return;
      }
      if (request.url === '/api/v1/registry/tools/echo/manifest') {
        response.end(JSON.stringify(wrap({ schemaVersion: 'toolkit.registry.tool.v1', slug: 'echo', version: 3, inputSchema: { type: 'object' }, endpoints: { rest: escapeEndpoint ? 'https://other.example/api/v1/t/echo' : `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/t/echo` } })));
        return;
      }
      if (request.url === '/api/v1/t/echo' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) body += chunk;
        response.end(JSON.stringify({ ok: true, output: { echoed: JSON.parse(body) }, receipt: { id: 'provider-receipt-1' } }));
        return;
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: 'missing' }));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/registry`, ...(signed ? { rootJwk: jwk(root!.publicKey) } : {}) }));
  });
}

describe('ToolkitRegistryGateway', () => {
  it('reuses only manifests bound to the fresh signed index and still rejects changed or revoked evidence', async () => {
    const root = generateKeyPairSync('ed25519');
    const signer = generateKeyPairSync('ed25519');
    let requests = 0;
    let active = 0;
    let peak = 0;
    let revision = 1;
    let mismatch = false;
    let revoked = false;
    let expired = false;
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const manifest = (slug: string) => envelope({ schemaVersion: 'toolkit.registry.tool.v1', slug, version: 1, description: `revision ${revision}`, endpoints: { rest: `${origin}/t/${slug}` } }, signer.privateKey, 'artifact');
      if (request.url === '/registry/keysets/current') {
        response.end(JSON.stringify(envelope({ keys: [{ ...jwk(signer.publicKey), kid: 'artifact' }], expiresAt: new Date(Date.now() + (expired ? -1000 : 60000)).toISOString(), revokedKeys: revoked ? [{ keyId: 'artifact' }] : [] }, root.privateKey, 'root')));
      } else if (request.url === '/registry/manifest') {
        response.end(JSON.stringify(envelope({ schemaVersion: 'toolkit.registry.index.v1', tools: Array.from({ length: 12 }, (_, i) => ({ slug: `tool-${i}`, version: 1, digest: mismatch ? `sha256:${'a'.repeat(64)}` : manifest(`tool-${i}`).digest, manifestUrl: `${origin}/registry/tools/tool-${i}` })) }, signer.privateKey, 'artifact')));
      } else if (request.url?.startsWith('/registry/tools/')) {
        requests++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        response.end(JSON.stringify(manifest(request.url.split('/').at(-1)!)));
      } else { response.statusCode = 404; response.end('{}'); }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const gateway = new ToolkitRegistryGateway(`http://127.0.0.1:${(server.address() as { port: number }).port}/registry`, undefined, { verifySignatures: true, rootPublicJwk: jwk(root.publicKey) });
    expect(await gateway.listTools()).toHaveLength(12);
    expect(requests).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
    expect(await gateway.listTools()).toHaveLength(12);
    expect(requests).toBe(12);
    revision++;
    expect((await gateway.listTools())[0]?.description).toBe('revision 2');
    expect(requests).toBe(24);
    expired = true;
    await expect(gateway.listTools()).rejects.toThrow('expired');
    expired = false; revoked = true;
    await expect(gateway.listTools()).rejects.toThrow('revoked');
    revoked = false; mismatch = true;
    await expect(gateway.listTools()).rejects.toThrow('digest disagrees');
  });

  it('resolves the toolkit_new Registry manifest and translates a published tool call', async () => {
    const registry = await startFixture();
    const gateway = new ToolkitRegistryGateway(registry.url, 'tk_test');
    await expect(gateway.health()).resolves.toMatchObject({ ready: true, detail: 'Toolkit Registry reachable (1 tools)' });
    await expect(gateway.listTools()).resolves.toEqual([{ id: 'echo', version: '3', capabilities: ['execute'], inputSchema: { type: 'object' }, outputSchema: {} }]);
    const result = await gateway.invoke({ toolId: 'echo', toolVersion: '3', taskId: 'task-1', purpose: 'echo input', input: { input: 'hello', mode: 'test' }, capabilityGrant: 'run:test:echo', idempotencyKey: 'idem-1', timeoutMs: 5000 });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ echoed: { input: 'hello', params: { mode: 'test' } } });
    expect(result.receipt.provider).toBe('toolkit_new');
    expect(result.receipt.operation).toBe('echo');
    expect(result.receipt.outputRefs).toEqual(['toolkit-receipt:provider-receipt-1']);
  });

  it('reports an unavailable Registry from its read-only health probe', async () => {
    const gateway = new ToolkitRegistryGateway('http://127.0.0.1:1/api/v1/registry');
    await expect(gateway.health()).resolves.toMatchObject({ ready: false, detail: expect.stringContaining('Toolkit Registry unavailable:') });
  });

  it('accepts toolkit_new published REST responses without the legacy ok field', async () => {
    let reconcilePayload: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      const port = (server.address() as { port: number }).port;
      if (request.url === '/api/v1/registry/manifest') {
        response.end(JSON.stringify({ schemaVersion: 'toolkit.registry.index.v1', tools: [{ slug: 'modern', version: 1, manifestUrl: `http://127.0.0.1:${port}/api/v1/registry/tools/modern/manifest` }] }));
        return;
      }
      if (request.url === '/api/v1/registry/tools/modern/manifest') {
        response.end(JSON.stringify({ schemaVersion: 'toolkit.registry.tool.v1', slug: 'modern', version: 1, endpoints: { rest: `http://127.0.0.1:${port}/api/v1/t/modern` } }));
        return;
      }
      if (request.url === '/api/v1/t/modern' && request.method === 'POST') {
        response.end(JSON.stringify({ output: { accepted: true }, receipt: { id: 'modern-receipt-1', ok: true } }));
        return;
      }
      if (request.url === '/reconcile' && request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          reconcilePayload = JSON.parse(body) as Record<string, unknown>;
          response.end(JSON.stringify({
            schemaVersion: 'tool-result/1', status: 'completed', output: { reconciled: true },
            outputRefs: ['toolkit-receipt:modern-receipt-1'],
            receipt: {
              schemaVersion: 'receipt/1', receiptId: 'receipt_00000000-0000-4000-8000-000000000001', provider: 'toolkit_new', operation: 'modern',
              requestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', inputRefs: ['task-modern'],
              outputRefs: ['toolkit-receipt:modern-receipt-1'], capabilitiesUsed: ['execute'],
              startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: 'completed',
            },
          }));
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'missing' }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const gateway = new ToolkitRegistryGateway(`http://127.0.0.1:${port}/api/v1/registry`, 'tk_test');
    const result = await gateway.invoke({ toolId: 'modern', toolVersion: '1', taskId: 'task-modern', purpose: 'modern response', input: { input: 'hello' }, capabilityGrant: 'run:test:modern', idempotencyKey: 'idem-modern', timeoutMs: 5000 });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ accepted: true });
    expect(result.receipt.outputRefs).toEqual(['toolkit-receipt:modern-receipt-1']);
    const reconciled = await new ToolkitRegistryGateway(`http://127.0.0.1:${port}/api/v1/registry`, 'tk_test', { reconcileUrl: `http://127.0.0.1:${port}/reconcile` }).reconcile!({ toolId: 'modern', toolVersion: '1', taskId: 'task-modern', purpose: 'modern response', input: { input: 'hello' }, capabilityGrant: 'run:test:modern', idempotencyKey: 'idem-modern', timeoutMs: 5000 }, result.receipt);
    expect(reconcilePayload?.schemaVersion).toBe('tool-reconcile/1');
    expect(reconciled.status).toBe('completed');
    expect(reconciled.output).toEqual({ reconciled: true });
    expect(new ToolkitRegistryGateway(`http://127.0.0.1:${port}/api/v1/registry`, 'tk_test').reconcile).toBeUndefined();
  });

  it('rejects registry endpoints that escape the registry origin', async () => {
    const registry = await startFixture(true);
    await expect(new ToolkitRegistryGateway(registry.url).listTools()).rejects.toThrow('share the Registry origin');
  });

  it('verifies the Registry keyset and signed index/manifest when enabled', async () => {
    const registry = await startFixture(false, true);
    const gateway = new ToolkitRegistryGateway(registry.url, undefined, { verifySignatures: true, rootPublicJwk: registry.rootJwk });
    await expect(gateway.listTools()).resolves.toEqual([{ id: 'echo', version: '3', capabilities: ['execute'], inputSchema: { type: 'object' }, outputSchema: {} }]);
  });
});
