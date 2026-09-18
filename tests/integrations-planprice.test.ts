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
  it('uses grouped channel pricing and normalizes non-USD prices before selection', async () => {
    const baseUrl = await startFixture();
    const catalog = new PlanpriceHttpCatalog(baseUrl, { 'cn-provider': 'https://cn.invalid/v1', 'us-provider': 'https://us.invalid/v1' });
    const rows = await catalog.list({ capability: 'agent', minContextTokens: 1000 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.outputPricePerMillion).toBeCloseTo(2);
    expect(rows[0]?.priceCurrency).toBe('USD');
    const decision = selectModel(rows, { capability: 'agent', privacy: 'internal' });
    expect(decision.selected.provider).toBe('cn-provider');
    expect(decision.reason).toContain('lowest known output price');
  });
});
