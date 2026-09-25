import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanpriceV1Catalog } from '../src/planprice-v1-adapter.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function catalogBody(expiresAt = new Date(Date.now() + 60_000).toISOString()) {
  const effectiveAt = new Date(Date.parse(expiresAt) - 60_000).toISOString();
  const body: Record<string, unknown> = {
    schemaVersion: 'planprice-catalog/1', catalogVersion: 'cat_test_001', generatedAt: effectiveAt, effectiveAt, expiresAt, baseCurrency: 'USD',
    offerings: [{ offeringId: 'off_test_001', modelId: 'mdl_test', modelVersion: '2026-09', versionStatus: 'pinned', providerId: 'provider_test', channelId: 'default', regionSetId: 'global', pricingVariantId: 'standard', regions: ['public'], capabilities: ['agent', 'text'], contextWindow: 8192, catalogStatus: 'available', runtimeStatus: 'unknown', runtimeObservedAt: null, runtimeEvidenceRef: null, pricing: { currency: 'USD', effectiveAt, expiresAt, components: [{ componentId: 'input', kind: 'input', unit: 'token', currency: 'USD', priceStatus: 'known', pricePerMillion: '1', conditions: { schemaVersion: 'pricing-conditions/1', kind: 'standard' } }, { componentId: 'output', kind: 'output', unit: 'token', currency: 'USD', priceStatus: 'known', pricePerMillion: '2', conditions: { schemaVersion: 'pricing-conditions/1', kind: 'standard' } }], provenance: { sourceId: 'test', sourceUrl: 'https://provider.example/pricing', observedAt: effectiveAt, evidenceDigest: `sha256:${'0'.repeat(64)}` }, normalization: { status: 'available', currency: 'USD', componentPrices: { input: '1', output: '2' }, fx: { base: 'USD', quote: 'USD', rate: '1', direction: 'quote_per_base', asOf: effectiveAt, expiresAt, sourceId: 'identity', evidenceDigest: `sha256:${'0'.repeat(64)}` }, rounding: { scale: 8, mode: 'half_even', stage: 'converted_unit_price' } } } }],
  };
  body.digest = `sha256:${createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex')}`;
  return body;
}

function startServer(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void): Promise<string> {
  const server = createServer(handler); servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`)));
}

describe('Planprice v1 adapter', () => {
  it('sends Bearer authentication, verifies digest, and maps offering to request model', async () => {
    const seen: string[] = [];
    const base = await startServer((request, response) => {
      seen.push(`${request.url}:${request.headers.authorization ?? ''}`);
      if (request.url === '/v1/health/ready') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ schemaVersion: 'planprice-health/1', status: 'ready' })); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(catalogBody()));
    });
    const catalog = new PlanpriceV1Catalog(base, { token: 'catalog-token', allowAnonymousDevelopment: true, mappings: [{ offeringId: 'off_test_001', providerId: 'provider_test', channelId: 'default', endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model-2026-09' }] });
    await expect(catalog.health()).resolves.toMatchObject({ ready: true });
    await expect(catalog.list({ capability: 'agent' })).resolves.toMatchObject([{ model: 'vendor-model-2026-09', provider: 'provider_test', endpoint: 'https://provider.example/v1', inputPricePerMillion: 1, outputPricePerMillion: 2 }]);
    expect(seen.every(entry => entry.endsWith(':Bearer catalog-token'))).toBe(true);
    expect(catalog.lastCatalogVersion).toBe('cat_test_001');
  });

  it('backs off a bounded number of times on 429 and honors Retry-After', async () => {
    let calls = 0;
    const base = await startServer((_request, response) => {
      calls += 1;
      if (calls === 1) { response.statusCode = 429; response.setHeader('retry-after', '0'); response.end(); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(catalogBody()));
    });
    const catalog = new PlanpriceV1Catalog(base, { token: 'catalog-token', allowAnonymousDevelopment: true, mappings: [{ offeringId: 'off_test_001', providerId: 'provider_test', channelId: 'default', endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model-2026-09' }] });
    await expect(catalog.list({ capability: 'agent' })).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('never serves a cached catalog after its upstream expiresAt', async () => {
    let calls = 0;
    const base = await startServer((_request, response) => {
      calls += 1;
      const expiresAt = calls === 1 ? new Date(Date.now() + 50).toISOString() : new Date(Date.now() + 60_000).toISOString();
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(catalogBody(expiresAt)));
    });
    const catalog = new PlanpriceV1Catalog(base, { token: 'catalog-token', allowAnonymousDevelopment: true, cacheTtlMs: 60_000, mappings: [{ offeringId: 'off_test_001', providerId: 'provider_test', channelId: 'default', endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model-2026-09' }] });
    await expect(catalog.list({ capability: 'agent' })).resolves.toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 70));
    await expect(catalog.list({ capability: 'agent' })).resolves.toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('rejects an already expired upstream catalog', async () => {
    const base = await startServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(catalogBody('2020-01-01T00:00:00Z'))); });
    const catalog = new PlanpriceV1Catalog(base, { token: 'catalog-token', allowAnonymousDevelopment: true, mappings: [{ offeringId: 'off_test_001', providerId: 'provider_test', channelId: 'default', endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model-2026-09' }] });
    await expect(catalog.list({ capability: 'agent' })).rejects.toThrow('expired');
  });

  it('does not select an offering whose embedded pricing window has expired', async () => {
    const body = catalogBody(new Date(Date.now() + 60_000).toISOString());
    const offering = body.offerings[0] as { pricing: { expiresAt: string } };
    offering.pricing.expiresAt = '2020-01-01T00:00:00Z';
    body.digest = `sha256:${createHash('sha256').update(canonicalJson(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'digest'))), 'utf8').digest('hex')}`;
    const base = await startServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(body)); });
    const catalog = new PlanpriceV1Catalog(base, { token: 'catalog-token', allowAnonymousDevelopment: true, mappings: [{ offeringId: 'off_test_001', providerId: 'provider_test', channelId: 'default', endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model-2026-09' }] });
    await expect(catalog.list({ capability: 'agent' })).resolves.toEqual([]);
  });

  it('fails closed without a token outside explicit development mode', async () => {
    expect(() => new PlanpriceV1Catalog('https://catalog.example', { mappings: [] })).toThrow('Bearer token is required');
  });
});
