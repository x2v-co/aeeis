import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { ToolkitRegistryGateway } from '../src/integrations.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function startFixture(escapeEndpoint = false): Promise<string> {
  return new Promise(resolve => {
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/v1/registry/manifest') {
        response.end(JSON.stringify({ schemaVersion: 'toolkit.registry.index.v1', tools: [{ slug: 'echo', version: 3, manifestUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/registry/tools/echo/manifest` }] }));
        return;
      }
      if (request.url === '/api/v1/registry/tools/echo/manifest') {
        response.end(JSON.stringify({ schemaVersion: 'toolkit.registry.tool.v1', slug: 'echo', version: 3, inputSchema: { type: 'object' }, endpoints: { rest: escapeEndpoint ? 'https://other.example/api/v1/t/echo' : `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/t/echo` } }));
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
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/registry`));
  });
}

describe('ToolkitRegistryGateway', () => {
  it('resolves the toolkit_new Registry manifest and translates a published tool call', async () => {
    const registry = await startFixture();
    const gateway = new ToolkitRegistryGateway(registry, 'tk_test');
    await expect(gateway.listTools()).resolves.toEqual([{ id: 'echo', version: '3', capabilities: ['execute'], inputSchema: { type: 'object' }, outputSchema: {} }]);
    const result = await gateway.invoke({ toolId: 'echo', toolVersion: '3', taskId: 'task-1', purpose: 'echo input', input: { input: 'hello', mode: 'test' }, capabilityGrant: 'run:test:echo', idempotencyKey: 'idem-1', timeoutMs: 5000 });
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ echoed: { input: 'hello', params: { mode: 'test' } } });
    expect(result.receipt.provider).toBe('toolkit_new');
    expect(result.receipt.operation).toBe('echo');
    expect(result.receipt.outputRefs).toEqual(['toolkit-receipt:provider-receipt-1']);
  });

  it('rejects registry endpoints that escape the registry origin', async () => {
    const registry = await startFixture(true);
    await expect(new ToolkitRegistryGateway(registry).listTools()).rejects.toThrow('share the Registry origin');
  });
});
