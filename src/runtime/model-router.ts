import type { ModelDecision, ModelCatalog, ModelSelectionRequest } from '../integrations.js';
import { selectModel } from '../integrations.js';
import type { ModelAdapter, ModelHealth } from './model.js';
import { HttpModelAdapter } from './model.js';
import type { ModelPin } from './contracts.js';
import { createHash } from 'node:crypto';

export interface ModelResolution { adapter: ModelAdapter; decision?: ModelDecision }
export interface ModelResolver {
  resolve(request: ModelSelectionRequest): Promise<ModelResolution>;
  forPin(pin: ModelPin): ModelAdapter;
  /** Probe the provider that would be selected for a normal internal Agent run. */
  health?(): Promise<ModelHealth>;
}

export class StaticModelResolver implements ModelResolver {
  constructor(private readonly adapter: ModelAdapter) {}
  async resolve(_request: ModelSelectionRequest): Promise<ModelResolution> { return { adapter: this.adapter }; }
  forPin(pin: ModelPin): ModelAdapter {
    if (pin.model !== this.adapter.pin.model || pin.endpoint !== this.adapter.pin.endpoint || pin.promptVersion !== this.adapter.pin.promptVersion || pin.provider !== this.adapter.pin.provider) throw new Error('Pinned model is unavailable in the configured resolver');
    return this.adapter;
  }
  async health(): Promise<ModelHealth> {
    if (this.adapter.health) return this.adapter.health();
    return { ready: true, detail: 'model configured; provider health probe not configured', checkedAt: new Date().toISOString() };
  }
}

export interface CatalogModelFactory { create(model: string, endpoint: string, provider?: string, pin?: ModelPin): ModelAdapter }
export class CatalogModelResolver implements ModelResolver {
  private readonly adapters = new Map<string, ModelAdapter>();
  constructor(private readonly catalog: ModelCatalog, private readonly factory: CatalogModelFactory) {}
  async resolve(request: ModelSelectionRequest): Promise<ModelResolution> {
    const rows = await this.catalog.list({ capability: request.capability, ...(request.minContextTokens === undefined ? {} : { minContextTokens: request.minContextTokens }) });
    const catalogRetrievedAt = this.catalog.lastRetrievedAt ?? new Date().toISOString();
    const decision = selectModel(rows, { ...request, catalogRetrievedAt });
    if (!decision.selected.endpoint) throw new Error(`Selected model ${decision.selected.model} has no configured provider endpoint`);
    const baseAdapter = this.factory.create(decision.selected.model, decision.selected.endpoint, decision.selected.provider);
    const selectedRow = rows.find(row => row.model === decision.selected.model && row.provider === decision.selected.provider && row.endpoint === decision.selected.endpoint && row.offeringId === decision.selected.offeringId)
      ?? rows.find(row => row.model === decision.selected.model && row.provider === decision.selected.provider && row.endpoint === decision.selected.endpoint && row.offeringId);
    const pin = selectedRow ? formalCatalogPin(selectedRow, rows.filter(row => decision.candidates.some(candidate => candidate.accepted || (candidate.model === row.model && candidate.provider === row.provider))), decision) : undefined;
    const adapter = pin ? withPin(baseAdapter, pin) : baseAdapter;
    this.adapters.set(key(adapter.pin), adapter);
    return { adapter, decision };
  }
  forPin(pin: ModelPin): ModelAdapter {
    const existing = this.adapters.get(key(pin));
    const adapter = existing ?? this.factory.create(pin.model, pin.endpoint, pin.provider, pin);
    // Recovery must preserve the full identity, including the credentials'
    // provider and prompt version. Never silently migrate a persisted attempt.
    if (key(adapter.pin) !== key(pin)) throw new Error('Pinned model configuration changed; restore it to resume this run');
    this.adapters.set(key(pin), adapter);
    return adapter;
  }
  async health(): Promise<ModelHealth> {
    const checkedAt = new Date().toISOString();
    let catalogHealth: NonNullable<ModelHealth['catalog']> = {
      ready: true,
      detail: 'model catalog health probe not configured',
      checkedAt,
    };
    try {
      if (this.catalog.health) {
        const result = await this.catalog.health();
        catalogHealth = { ...result, checkedAt: result.checkedAt ?? checkedAt };
        if (!catalogHealth.ready) {
          return {
            ready: false,
            detail: `model catalog unavailable: ${catalogHealth.detail}`,
            checkedAt,
            catalog: catalogHealth,
          };
        }
      }
      const rows = await this.catalog.list({ capability: 'agent' });
      const readDetail = `catalog returned ${rows.length} model row${rows.length === 1 ? '' : 's'}`;
      catalogHealth = { ...catalogHealth, detail: `${catalogHealth.detail}; ${readDetail}` };
      let decision: ModelDecision;
      try {
        decision = selectModel(rows, { capability: 'agent', privacy: 'internal' });
      } catch (error) {
        return {
          ready: false,
          detail: error instanceof Error ? `model catalog has no eligible model: ${error.message}` : 'model catalog has no eligible model',
          checkedAt,
          catalog: catalogHealth,
        };
      }
      if (!decision.selected.endpoint) return { ready: false, detail: `Selected catalog model ${decision.selected.model} has no provider endpoint`, checkedAt, catalog: catalogHealth };
      let adapter: ModelAdapter;
      try {
        adapter = this.factory.create(decision.selected.model, decision.selected.endpoint, decision.selected.provider);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'provider adapter configuration is invalid';
        const provider = { ready: false, detail: `selected provider configuration failed: ${detail}`, checkedAt };
        return { ready: false, detail: provider.detail, checkedAt, catalog: catalogHealth, provider };
      }
      const selected = `catalog selected ${decision.selected.provider}/${decision.selected.model}`;
      if (adapter.health) {
        let health: ModelHealth;
        try {
          health = await adapter.health();
        } catch {
          const provider = { ready: false, detail: 'provider health probe failed or timed out', checkedAt };
          return { ready: false, detail: `${selected}; ${provider.detail}`, checkedAt, catalog: catalogHealth, provider };
        }
        return { ...health, detail: `${selected}; ${health.detail}`, catalog: catalogHealth, provider: { ready: health.ready, detail: health.detail, checkedAt: health.checkedAt } };
      }
      const provider = { ready: true, detail: 'provider health probe not configured', checkedAt };
      return { ready: true, detail: `${selected}; ${provider.detail}`, checkedAt, catalog: catalogHealth, provider };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      return { ready: false, detail: `model catalog read failed: ${detail}`, checkedAt, catalog: { ready: false, detail: `catalog read failed: ${detail}`, checkedAt } };
    }
  }
}

export class HttpCatalogModelFactory implements CatalogModelFactory {
  constructor(private readonly apiKeys: Readonly<Record<string, string>> = {}, private readonly healthUrls: Readonly<Record<string, string>> = {}, private readonly allowInsecureHttp = false, private readonly mappings: readonly { offeringId: string; endpointRef: string; requestModel: string; providerId: string; channelId: string; mappingVersion?: string }[] = []) {}
  create(model: string, endpoint: string, provider?: string, pin?: ModelPin): ModelAdapter {
    if (!endpoint) throw new Error(`No provider endpoint configured for catalog model ${model}`);
    let requestedEndpoint = endpoint;
    if (pin?.routingMode === 'catalog' && pin.offeringId) {
      const mapping = this.mappings.find(item => item.offeringId === pin.offeringId);
      if (!mapping) throw new Error('Pinned model mapping is unavailable; restore it to resume this run');
      const normalizedMappingEndpoint = new URL(mapping.endpointRef).href;
      if (mapping.requestModel !== pin.requestModel || normalizedMappingEndpoint !== new URL(pin.endpointRef ?? '').href || (mapping.mappingVersion ?? 'mapping-1') !== pin.mappingVersion || mapping.providerId !== pin.providerId || mapping.channelId !== pin.channelId) throw new Error('Pinned model mapping changed; migrate the run before resuming');
      requestedEndpoint = normalizedMappingEndpoint;
      model = mapping.requestModel;
      provider = mapping.providerId;
    }
    const base = requestedEndpoint.endsWith('/chat/completions') ? requestedEndpoint.slice(0, -'/chat/completions'.length) : requestedEndpoint;
    const adapter = new HttpModelAdapter(base, model, this.apiKeys[provider ?? ''] ?? this.apiKeys[model] ?? '', provider, 60_000, this.healthUrls[provider ?? ''] ?? this.healthUrls[model], this.allowInsecureHttp, pin);
    if (pin?.routingMode === 'catalog' && adapter.pin.endpoint !== pin.endpoint) throw new Error('Pinned model endpoint changed; migrate the run before resuming');
    return adapter;
  }
}

function withPin(adapter: ModelAdapter, pin: ModelPin): ModelAdapter {
  return { pin, complete: request => adapter.complete(request), ...(adapter.health ? { health: () => adapter.health!() } : {}) };
}

function endpointHash(endpoint: string): string {
  return `sha256:${createHash('sha256').update(new URL(endpoint).href, 'utf8').digest('hex')}`;
}

function formalCatalogPin(row: import('../integrations.js').ModelCatalogRow, rows: import('../integrations.js').ModelCatalogRow[], decision: ModelDecision): ModelPin | undefined {
  // Compatibility catalogs predate the formal Planprice metadata. They keep
  // the legacy transport pin; only a complete v1 row opts into the strict
  // catalog identity required for restart-safe routing.
  if (!row.offeringId || !row.modelId || !row.providerId || !row.channelId || !row.regionSetId || !row.pricingVariantId || !row.catalogVersion || !row.catalogDigest || !row.offeringHash || !row.endpointRef || !row.requestModel || !row.mappingVersion || !row.pricingSnapshot) return undefined;
  const candidateOfferings = rows.filter(item => item.offeringId && item.offeringHash).map(item => ({ offeringId: item.offeringId!, offeringHash: item.offeringHash! })).sort((a, b) => a.offeringId.localeCompare(b.offeringId));
  const catalogHash = `sha256:${createHash('sha256').update(JSON.stringify(candidateOfferings), 'utf8').digest('hex')}`;
  const selectedAt = decision.decidedAt;
  const endpoint = `${new URL(row.endpointRef).href.replace(/\/$/, '')}/chat/completions`;
  return {
    model: row.requestModel, endpoint, provider: row.providerId, promptVersion: 'aeeis-project-agent/1',
    schemaVersion: 'aeeis-model-pin/1', routingMode: 'catalog', offeringId: row.offeringId, modelId: row.modelId,
    modelVersion: row.modelVersion ?? null, versionStatus: row.versionStatus ?? 'unknown', providerId: row.providerId,
    channelId: row.channelId, regionSetId: row.regionSetId, pricingVariantId: row.pricingVariantId,
    catalogVersion: row.catalogVersion, catalogDigest: row.catalogDigest, catalogHash, candidateOfferings,
    ...(row.catalogRetrievedAt ? { catalogRetrievedAt: row.catalogRetrievedAt } : {}),
    catalogArtifactRef: row.catalogArtifactRef ?? `planprice://catalog/${row.catalogVersion}`, endpointRef: new URL(row.endpointRef).href,
    requestModel: row.requestModel, mappingVersion: row.mappingVersion, resolvedEndpointHash: endpointHash(endpoint),
    routingPolicyVersion: 'aeeis-model-routing/1', selectedAt, pricingSnapshot: row.pricingSnapshot,
  };
}

function key(pin: ModelPin): string {
  return JSON.stringify(Object.fromEntries(Object.keys(pin).sort().map(field => [field, (pin as unknown as Record<string, unknown>)[field]])));
}
