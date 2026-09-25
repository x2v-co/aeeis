import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { PlanpriceHttpCatalog, selectModel } from '../src/integrations.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function startFixture(): Promise<string> {
  return new Promise(resolve => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/products/grouped?type=llm') {
        response.end(JSON.stringify([{ slug: 'cheap', context_window: 32000, versions: [{ model_slug: 'cheap', input_price_per_1m: 6.9, output_price_per_1m: 13.8, currency: 'CNY', is_available: true, providers: { slug: 'cn-provider' } }, { model_slug: 'cheap', input_price_per_1m: 1, output_price_per_1m: 4, currency: 'USD', is_available: true, providers: { slug: 'us-provider' } }] }]));
        return;
      }
      if (request.url === '/api/exchange-rates') {
        response.end(JSON.stringify({ rates: { CNY: 6.9 } }));
        return;
      }
      response.statusCode = 404; response.end(JSON.stringify({ error: 'missing' }));
    });
    servers.push(server); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

describe('PlanpriceHttpCatalog', () => {
  it('reads the formal v1 contract with Bearer auth and rejects expired FX', async () => {
    let auth = '';
    const baseUrl = await new Promise<string>(resolve => {
      const server = createServer((request, response) => {
        auth = request.headers.authorization ?? '';
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/catalog/models') {
          response.end(JSON.stringify({ offerings: [{ offeringId: 'off_1', modelId: 'model-1', providerId: 'provider-1', capabilities: ['text', 'agent'], contextWindow: 8192, catalogStatus: 'available', pricing: { currency: 'CNY', components: [{ kind: 'input', pricePerMillion: '1', priceStatus: 'known' }, { kind: 'output', pricePerMillion: '2', priceStatus: 'known' }], normalization: { status: 'available', componentPrices: { input: '0.14', output: '0.29' } } } }] })); return;
        }
        if (request.url === '/v1/exchange-rates') {
          response.end(JSON.stringify({ quotes: [{ quote: 'CNY', rate: '7.2', expiresAt: '2000-01-01T00:00:00Z' }] })); return;
        }
        response.statusCode = 404; response.end();
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    const catalog = new PlanpriceHttpCatalog(baseUrl, { 'provider-1': 'https://provider.invalid/v1' }, { protocol: 'v1', bearerToken: 'catalog-token' });
    const rows = await catalog.list({ capability: 'agent' });
    expect(auth).toBe('Bearer catalog-token');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outputPricePerMillion).toBeCloseTo(0.29);
    expect(() => new PlanpriceHttpCatalog(baseUrl, {}, { protocol: 'v1' })).toThrow('Bearer token');
  });
  it('uses an explicit read-only health endpoint without refreshing the catalog', async () => {
    let catalogReads = 0;
    let healthReads = 0;
    const baseUrl = await new Promise<string>(resolve => {
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/health') { healthReads += 1; response.statusCode = 200; response.end('{}'); return; }
        if (request.url === '/api/products/grouped?type=llm') { catalogReads += 1; response.end('[]'); return; }
        response.statusCode = 404; response.end();
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    const catalog = new PlanpriceHttpCatalog(baseUrl, {}, { healthUrl: `${baseUrl}/health` });
    await expect(catalog.health?.()).resolves.toMatchObject({ ready: true, detail: 'Planprice catalog health probe passed' });
    expect(healthReads).toBe(1);
    expect(catalogReads).toBe(0);
  });

  it('fails closed on redirected Planprice health endpoints', async () => {
    const baseUrl = await new Promise<string>(resolve => {
      const server = createServer((request, response) => {
        if (request.url === '/health') { response.statusCode = 302; response.setHeader('location', '/other'); response.end(); return; }
        response.statusCode = 404; response.end();
      });
      servers.push(server); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    const catalog = new PlanpriceHttpCatalog(baseUrl, {}, { healthUrl: `${baseUrl}/health` });
    await expect(catalog.health?.()).resolves.toMatchObject({ ready: false, detail: 'Planprice catalog health probe failed or timed out' });
  });

  it('uses grouped channel pricing and normalizes non-USD prices before selection', async () => {
    const baseUrl = await startFixture();
    const catalog = new PlanpriceHttpCatalog(baseUrl, { 'cn-provider': 'https://cn.invalid/v1', 'us-provider': 'https://us.invalid/v1' });
    const rows = await catalog.list({ capability: 'agent', minContextTokens: 1000 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.outputPricePerMillion).toBeCloseTo(2);
    expect(rows[0]?.priceCurrency).toBe('USD');
    const decision = selectModel(rows, { capability: 'agent', privacy: 'internal', catalogRetrievedAt: '2026-09-19T00:00:00.000Z' });
    expect(decision.selected.provider).toBe('cn-provider');
    expect(decision.selected.outputPricePerMillion).toBeCloseTo(2);
    expect(decision.reason).toContain('lowest known output price');
    expect(decision.catalogHash).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.catalogRetrievedAt).toBe('2026-09-19T00:00:00.000Z');
  });

  it('applies an explicit private-data policy to catalog rows and fails closed when omitted', async () => {
    const baseUrl = await startFixture();
    const catalog = new PlanpriceHttpCatalog(baseUrl, { 'cn-provider': 'https://cn.invalid/v1', 'us-provider': 'https://us.invalid/v1' }, {
      privateDataAllowed: { 'cn-provider': false, 'us-provider': true },
    });
    const rows = await catalog.list({ capability: 'agent' });
    expect(() => selectModel(rows, { capability: 'agent', privacy: 'private' })).not.toThrow();
    expect(selectModel(rows, { capability: 'agent', privacy: 'private' }).selected.provider).toBe('us-provider');
    const failClosed = new PlanpriceHttpCatalog(baseUrl, { 'cn-provider': 'https://cn.invalid/v1', 'us-provider': 'https://us.invalid/v1' });
    const failRows = await failClosed.list({ capability: 'agent' });
    expect(() => selectModel(failRows, { capability: 'agent', privacy: 'private' })).toThrow('No model');
  });

  it('filters catalog choices by a maximum output price', () => {
    const decision = selectModel([
      { model: 'expensive', provider: 'p1', endpoint: 'https://p1.invalid', capabilities: ['agent'], outputPricePerMillion: 5, priceCurrency: 'USD' },
      { model: 'affordable', provider: 'p2', endpoint: 'https://p2.invalid', capabilities: ['agent'], outputPricePerMillion: 2, priceCurrency: 'USD' },
    ], { capability: 'agent', privacy: 'internal', maxMoney: 2 });
    expect(decision.selected.model).toBe('affordable');
    expect(decision.candidates).toEqual([{ model: 'affordable', provider: 'p2', reason: expect.stringContaining('lowest known output price'), accepted: true }]);
  });

  it('keeps the catalog snapshot hash stable when the provider changes row order', () => {
    const catalog = [
      { model: 'a', provider: 'p1', endpoint: 'https://p1.invalid', capabilities: ['agent'], outputPricePerMillion: 2, priceCurrency: 'USD' },
      { model: 'b', provider: 'p2', endpoint: 'https://p2.invalid', capabilities: ['agent'], outputPricePerMillion: 3, priceCurrency: 'USD' },
    ];
    const first = selectModel(catalog, { capability: 'agent', privacy: 'internal' });
    const second = selectModel([...catalog].reverse(), { capability: 'agent', privacy: 'internal' });
    expect(first.catalogHash).toBe(second.catalogHash);
  });

  it('coalesces concurrent reads and reuses a bounded catalog cache', async () => {
    let groupedCalls = 0;
    let rateCalls = 0;
    const baseUrl = await new Promise<string>(resolve => {
      const server = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/api/products/grouped?type=llm') {
          groupedCalls += 1;
          response.end(JSON.stringify([{ slug: 'cached', context_window: 8000, versions: [{ model_slug: 'cached', input_price_per_1m: 1, output_price_per_1m: 2, currency: 'USD', is_available: true, providers: { slug: 'provider-a' } }] }]));
          return;
        }
        if (request.url === '/api/exchange-rates') {
          rateCalls += 1;
          response.end(JSON.stringify({ rates: {} }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    });
    const catalog = new PlanpriceHttpCatalog(baseUrl, { 'provider-a': 'https://provider-a.invalid/v1' }, { cacheTtlMs: 60_000 });
    const [first, second] = await Promise.all([catalog.list({ capability: 'agent' }), catalog.list({ capability: 'agent', minContextTokens: 100 })]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(await catalog.list({ capability: 'agent' })).toHaveLength(1);
    expect(groupedCalls).toBe(1);
    expect(rateCalls).toBe(1);
    expect(catalog.lastRetrievedAt).toMatch(/T/);
  });
});
