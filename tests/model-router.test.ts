import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CatalogModelResolver, HttpCatalogModelFactory } from '../src/runtime/model-router.js';
import type { ModelCatalog } from '../src/integrations.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<string> {
  return new Promise(resolve => {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

describe('catalog model resolver health', () => {
  it('probes the provider selected by the same internal Agent policy', async () => {
    let healthCalls = 0;
    const provider = await listen((_request, response) => { healthCalls += 1; response.statusCode = 200; response.end('ok'); });
    const catalog: ModelCatalog = { list: async () => [{ model: 'model-a', provider: 'provider-a', endpoint: provider, capabilities: ['agent'], outputPricePerMillion: 1, priceCurrency: 'USD' }] };
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory({}, { 'provider-a': `${provider}/health` }));
    await expect(resolver.health?.()).resolves.toMatchObject({ ready: true, detail: 'provider health probe passed' });
    expect(healthCalls).toBe(1);
  });

  it('reports catalog selection failures as not ready', async () => {
    const catalog: ModelCatalog = { list: async () => [] };
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory());
    await expect(resolver.health?.()).resolves.toMatchObject({ ready: false, detail: expect.stringContaining('No model satisfies') });
  });
});
