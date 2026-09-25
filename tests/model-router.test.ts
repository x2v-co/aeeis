import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CatalogModelResolver, HttpCatalogModelFactory } from '../src/runtime/model-router.js';
import type { ModelCatalog } from '../src/integrations.js';
import type { ModelPin } from '../src/runtime/contracts.js';

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
  it('separates catalog health failure from provider health and skips provider calls', async () => {
    let listCalls = 0;
    let providerHealthCalls = 0;
    const catalog: ModelCatalog = {
      list: async () => { listCalls += 1; return [{ model: 'model-a', provider: 'provider-a', endpoint: 'https://provider.invalid/v1', capabilities: ['agent'] }]; },
      health: async () => ({ ready: false, detail: 'Planprice catalog health probe returned HTTP 503', checkedAt: new Date().toISOString() }),
    };
    const factory = { create: () => ({ pin: { model: 'model-a', provider: 'provider-a', endpoint: 'https://provider.invalid/v1/chat/completions', promptVersion: 'aeeis-project-agent/1' }, complete: async () => ({ value: {} }), health: async () => { providerHealthCalls += 1; return { ready: true, detail: 'provider ready', checkedAt: new Date().toISOString() }; } }) };
    const resolver = new CatalogModelResolver(catalog, factory);
    await expect(resolver.health?.()).resolves.toMatchObject({ ready: false, detail: 'model catalog unavailable: Planprice catalog health probe returned HTTP 503', catalog: { ready: false }, });
    expect(listCalls).toBe(0);
    expect(providerHealthCalls).toBe(0);
  });

  it('probes the provider selected by the same internal Agent policy', async () => {
    let healthCalls = 0;
    const provider = await listen((_request, response) => { healthCalls += 1; response.statusCode = 200; response.end('ok'); });
    const catalog: ModelCatalog = { list: async () => [{ model: 'model-a', provider: 'provider-a', endpoint: provider, capabilities: ['agent'], outputPricePerMillion: 1, priceCurrency: 'USD' }] };
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory({}, { 'provider-a': `${provider}/health` }));
    await expect(resolver.health?.()).resolves.toMatchObject({ ready: true, detail: expect.stringContaining('catalog selected provider-a/model-a; provider health probe passed'), catalog: { ready: true }, provider: { ready: true } });
    expect(healthCalls).toBe(1);
  });

  it('reports catalog selection failures as not ready', async () => {
    const catalog: ModelCatalog = { list: async () => [] };
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory());
    await expect(resolver.health?.()).resolves.toMatchObject({ ready: false, detail: expect.stringContaining('model catalog has no eligible model: No model satisfies'), catalog: { ready: true } });
  });

  it('reports provider failure separately after a healthy catalog selection', async () => {
    const provider = await listen((_request, response) => { response.statusCode = 503; response.end('down'); });
    const catalog: ModelCatalog = { list: async () => [{ model: 'model-a', provider: 'provider-a', endpoint: provider, capabilities: ['agent'] }], health: async () => ({ ready: true, detail: 'catalog probe passed', checkedAt: new Date().toISOString() }) };
    const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory({}, { 'provider-a': `${provider}/health` }));
    await expect(resolver.health?.()).resolves.toMatchObject({ ready: false, detail: expect.stringContaining('catalog selected provider-a/model-a; provider health probe returned HTTP 503'), catalog: { ready: true }, provider: { ready: false } });
  });
});

describe('catalog model recovery', () => {
  it('persists the complete Planprice catalog identity and restores it after restart', async () => {
    const catalog: ModelCatalog = {
      list: async () => [{
        model: 'vendor-model', provider: 'provider-a', endpoint: 'https://provider.example/v1', capabilities: ['agent'],
        inputPricePerMillion: 1, outputPricePerMillion: 2, priceCurrency: 'USD',
        offeringId: 'offering-a', modelId: 'model-a', modelVersion: '2026-09', versionStatus: 'pinned',
        providerId: 'provider-a', channelId: 'channel-a', regionSetId: 'global', pricingVariantId: 'standard',
        catalogVersion: 'cat_test_unique', catalogDigest: `sha256:${'1'.repeat(64)}`,
        offeringHash: `sha256:${'2'.repeat(64)}`, catalogRetrievedAt: '2026-09-24T00:00:00.000Z',
        endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model', mappingVersion: 'mapping-7',
        catalogArtifactRef: 'https://catalog.example/v1/catalog/models/snapshots/cat_test_unique',
        pricingSnapshot: { currency: 'USD', effectiveAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-25T00:00:00.000Z', components: [], provenance: {}, normalization: {} },
      }],
    };
    const factory = new HttpCatalogModelFactory({ 'provider-a': 'credential-a' }, {}, false, [{ offeringId: 'offering-a', endpointRef: 'https://provider.example/v1', requestModel: 'vendor-model', providerId: 'provider-a', channelId: 'channel-a', mappingVersion: 'mapping-7' }]);
    const first = await new CatalogModelResolver(catalog, factory).resolve({ capability: 'agent', privacy: 'internal' });
    expect(first.adapter.pin).toMatchObject({ schemaVersion: 'aeeis-model-pin/1', routingMode: 'catalog', offeringId: 'offering-a', modelId: 'model-a', modelVersion: '2026-09', providerId: 'provider-a', channelId: 'channel-a', regionSetId: 'global', pricingVariantId: 'standard', catalogVersion: 'cat_test_unique', catalogDigest: `sha256:${'1'.repeat(64)}`, mappingVersion: 'mapping-7', requestModel: 'vendor-model', endpointRef: 'https://provider.example/v1', resolvedEndpointHash: expect.stringMatching(/^sha256:/), pricingSnapshot: expect.any(Object) });
    expect(first.adapter.pin.candidateOfferings).toEqual([{ offeringId: 'offering-a', offeringHash: `sha256:${'2'.repeat(64)}` }]);
    const restored = new CatalogModelResolver(catalog, factory).forPin(JSON.parse(JSON.stringify(first.adapter.pin)) as ModelPin);
    expect(restored.pin).toEqual(first.adapter.pin);
    const changedFactory = new HttpCatalogModelFactory({ 'provider-a': 'credential-a' }, {}, false, [{ offeringId: 'offering-a', endpointRef: 'https://provider.example/changed', requestModel: 'vendor-model', providerId: 'provider-a', channelId: 'channel-a', mappingVersion: 'mapping-8' }]);
    expect(() => new CatalogModelResolver(catalog, changedFactory).forPin(JSON.parse(JSON.stringify(first.adapter.pin)) as ModelPin)).toThrow('Pinned model mapping changed');
  });

  it('keeps provider credentials isolated when models share a gateway, including after restart', async () => {
    const authorizations: Array<string | undefined> = [];
    const endpoint = await listen((request, response) => {
      authorizations.push(request.headers.authorization);
      request.resume();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
    });
    let catalogReads = 0;
    const catalog: ModelCatalog = { list: async () => {
      catalogReads++;
      return ['provider-a', 'provider-b'].map(provider => ({ model: 'shared-model', provider, endpoint, capabilities: [provider] }));
    } };
    const factory = new HttpCatalogModelFactory({ 'provider-a': 'credential-a', 'provider-b': 'credential-b' });
    const resolver = new CatalogModelResolver(catalog, factory);
    const first = await resolver.resolve({ capability: 'provider-a', privacy: 'internal' });
    const second = await resolver.resolve({ capability: 'provider-b', privacy: 'internal' });
    for (const activeResolver of [resolver, new CatalogModelResolver(catalog, factory)]) {
      for (const original of [first, second, first]) {
        const restored = activeResolver.forPin(JSON.parse(JSON.stringify(original.adapter.pin)) as ModelPin);
        // Verify the actual wire credentials, rather than only pin metadata.
        await restored.complete({ system: 'test', input: {} });
        expect(restored.pin).toEqual(original.adapter.pin);
      }
    }
    expect(authorizations).toEqual(['Bearer credential-a', 'Bearer credential-b', 'Bearer credential-a', 'Bearer credential-a', 'Bearer credential-b', 'Bearer credential-a']);
    expect(catalogReads).toBe(2);
  });

  it.each(['model', 'endpoint', 'provider', 'promptVersion'] as const)('refuses to restore a changed %s without calling the model', field => {
    const pin: ModelPin = { model: 'frozen-model', endpoint: 'https://gateway.invalid/v1/chat/completions', provider: 'provider-a', promptVersion: 'frozen/1' };
    let changed = true;
    let calls = 0;
    const factory = { create: () => ({ pin: { ...pin, ...(changed ? { [field]: `${pin[field]}-changed` } : {}) }, complete: async () => { calls++; return { value: {} }; } }) };
    const resolver = new CatalogModelResolver({ list: async () => { throw new Error('Recovery must not select from a new catalog'); } }, factory);
    expect(() => resolver.forPin(pin)).toThrow('Pinned model configuration changed');
    expect(calls).toBe(0);
    // A failed reconstruction must not poison the cache: restoration can be
    // retried once the operator restores the required model configuration.
    changed = false;
    expect(resolver.forPin(pin).pin).toEqual(pin);
  });
});
