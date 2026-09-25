import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DependencyHealth } from './dependency-health.js';
import type { ModelCatalog, ModelCatalogRow } from './integrations.js';

type ProviderMapping = {
  offeringId: string;
  endpointRef: string;
  requestModel: string;
  providerId: string;
  channelId: string;
  mappingVersion?: string;
  catalogArtifactRef?: string;
};

type AdapterOptions = {
  token?: string;
  mappings: readonly ProviderMapping[];
  healthUrl?: string;
  cacheTtlMs?: number;
  allowAnonymousDevelopment?: boolean;
  fetchImpl?: typeof fetch;
};

type Catalog = {
  schemaVersion: 'planprice-catalog/1';
  catalogVersion: string;
  generatedAt: string;
  effectiveAt: string;
  expiresAt: string;
  baseCurrency: 'USD';
  offerings: Array<{
    offeringId: string;
    modelId: string;
    modelVersion: string | null;
    versionStatus: 'pinned' | 'rolling' | 'unknown';
    providerId: string;
    channelId: string;
    regionSetId: string;
    pricingVariantId: string;
    regions?: string[];
    capabilities: string[];
    contextWindow?: number;
    catalogStatus: 'available' | 'degraded' | 'unavailable' | 'deprecated';
    runtimeStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
    pricing: {
      currency: string;
      effectiveAt: string;
      expiresAt: string;
      normalization: { status: 'available' | 'unavailable'; currency: 'USD'; componentPrices: Record<string, string | null> };
      components: Array<{ componentId: string; kind: string; unit: string; priceStatus: 'known' | 'unknown'; conditions: { schemaVersion: 'pricing-conditions/1'; kind: string }; pricePerMillion?: string | null; unitPrice?: string | null }>;
    };
  }>;
  digest: string;
};

const idPattern = /^[A-Za-z0-9_][A-Za-z0-9._~-]{0,119}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const isLoopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const canonicalize = createRequire(import.meta.url)('canonicalize') as (value: unknown) => string | undefined;
const sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function retryAfterMs(value: string | null): number {
  if (!value) return 250;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(10_000, Math.max(0, date - Date.now())) : 250;
}

function pricingIsFresh(offering: Catalog['offerings'][number], now: number): boolean {
  const pricing = offering.pricing as Catalog['offerings'][number]['pricing'] & { normalization: { fx?: { asOf?: string; expiresAt?: string } | null } };
  const effectiveAt = Date.parse(pricing.effectiveAt);
  const expiresAt = Date.parse(pricing.expiresAt);
  if (!Number.isFinite(effectiveAt) || !Number.isFinite(expiresAt) || effectiveAt > now || expiresAt <= now) return false;
  if (pricing.normalization.status === 'available') {
    const fx = pricing.normalization.fx;
    if (!fx || !Number.isFinite(Date.parse(fx.asOf ?? '')) || !Number.isFinite(Date.parse(fx.expiresAt ?? '')) || Date.parse(fx.asOf!) > now || Date.parse(fx.expiresAt!) <= now) return false;
  }
  return true;
}

function digestCatalog(catalog: Catalog): string {
  const { digest: _digest, ...payload } = catalog;
  const canonical = canonicalize(payload);
  if (canonical === undefined) throw new Error('Planprice v1 catalog cannot be canonicalized');
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function assertCatalog(value: unknown): Catalog {
  if (!value || typeof value !== 'object') throw new Error('Planprice v1 catalog body is not an object');
  const catalog = value as Partial<Catalog>;
  if (catalog.schemaVersion !== 'planprice-catalog/1' || typeof catalog.catalogVersion !== 'string' || !idPattern.test(catalog.catalogVersion) || !Array.isArray(catalog.offerings) || typeof catalog.digest !== 'string' || !digestPattern.test(catalog.digest)) throw new Error('Planprice v1 catalog envelope is invalid');
  if (catalog.digest !== digestCatalog(catalog as Catalog)) throw new Error('Planprice v1 catalog digest mismatch');
  return catalog as Catalog;
}

export class PlanpriceV1Catalog implements ModelCatalog {
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private readonly healthUrl: string;
  private cached?: { catalog: Catalog; expiresAt: number };
  private loading: Promise<Catalog> | undefined;
  lastRetrievedAt?: string;
  lastCatalogVersion?: string;
  lastCatalogDigest?: string;

  constructor(private readonly baseUrl: string, private readonly options: AdapterOptions) {
    const base = new URL(baseUrl);
    if (base.username || base.password || base.search || base.hash) throw new Error('Planprice v1 URL must not contain credentials, query or fragment');
    if (base.protocol !== 'https:' && !(options.allowAnonymousDevelopment && isLoopback(base.hostname))) throw new Error('Planprice v1 URL must use HTTPS');
    if (!options.token && !(options.allowAnonymousDevelopment && isLoopback(base.hostname))) throw new Error('Planprice v1 Bearer token is required');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) throw new Error('Planprice v1 cache TTL must be finite and non-negative');
    this.healthUrl = options.healthUrl ?? new URL('/v1/health/ready', base).toString();
    const health = new URL(this.healthUrl);
    if (health.origin !== base.origin || health.username || health.password || health.search || health.hash) throw new Error('Planprice v1 health URL must share the catalog origin');
  }

  private headers(): Record<string, string> {
    return { accept: 'application/json', ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) };
  }

  async health(): Promise<DependencyHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await this.fetchImpl(this.healthUrl, { method: 'GET', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(5_000) });
      const body = await response.json().catch(() => undefined) as { schemaVersion?: string; status?: string; reason?: string | null } | undefined;
      const ready = response.status === 200 && body?.schemaVersion === 'planprice-health/1' && body.status === 'ready';
      return { ready, detail: ready ? 'Planprice v1 ready probe passed' : `Planprice v1 ready probe returned HTTP ${response.status}${body?.reason ? ` (${body.reason})` : ''}`, checkedAt };
    } catch {
      return { ready: false, detail: 'Planprice v1 ready probe failed or timed out', checkedAt };
    }
  }

  async list(query: { capability?: string; minContextTokens?: number } = {}): Promise<ModelCatalogRow[]> {
    const catalog = await this.loadCatalog();
    const mappings = new Map(this.options.mappings.map(mapping => [mapping.offeringId, mapping]));
    return catalog.offerings.flatMap(offering => {
      const mapping = mappings.get(offering.offeringId);
      const standard = offering.pricing.components.filter(component => component.conditions.kind === 'standard');
      const input = standard.find(component => component.kind === 'input' && component.unit === 'token' && component.priceStatus === 'known');
      const output = standard.find(component => component.kind === 'output' && component.unit === 'token' && component.priceStatus === 'known');
      if (!mapping || offering.catalogStatus === 'unavailable' || offering.catalogStatus === 'deprecated' || !pricingIsFresh(offering, Date.now()) || !offering.capabilities.includes(query.capability ?? 'agent') || (query.minContextTokens !== undefined && (offering.contextWindow ?? 0) < query.minContextTokens) || offering.pricing.normalization.status !== 'available' || !input || !output) return [];
      const endpoint = mapping.endpointRef.replace(/\/$/, '');
      const mappingVersion = mapping.mappingVersion ?? 'mapping-1';
      if (!idPattern.test(mappingVersion)) throw new Error(`Planprice mappingVersion for ${mapping.offeringId} must be URL-safe`);
      const inputPrice = offering.pricing.normalization.componentPrices[input.componentId];
      const outputPrice = offering.pricing.normalization.componentPrices[output.componentId];
      const offeringHash = `sha256:${createHash('sha256').update(canonicalize(offering) ?? '').digest('hex')}`;
      return [{ model: mapping.requestModel, provider: offering.providerId, endpoint, capabilities: offering.capabilities, ...(offering.contextWindow === undefined ? {} : { contextTokens: offering.contextWindow }), ...(inputPrice === null || inputPrice === undefined ? {} : { inputPricePerMillion: Number(inputPrice) }), ...(outputPrice === null || outputPrice === undefined ? {} : { outputPricePerMillion: Number(outputPrice), priceCurrency: 'USD' }), availability: offering.catalogStatus, privateDataAllowed: offering.regions?.includes('private') === true,
        offeringId: offering.offeringId, modelId: offering.modelId, modelVersion: offering.modelVersion, versionStatus: offering.versionStatus,
        providerId: offering.providerId, channelId: offering.channelId, regionSetId: offering.regionSetId, pricingVariantId: offering.pricingVariantId,
        catalogVersion: catalog.catalogVersion, catalogDigest: catalog.digest, ...(this.lastRetrievedAt ? { catalogRetrievedAt: this.lastRetrievedAt } : {}), offeringHash, endpointRef: endpoint, requestModel: mapping.requestModel,
        mappingVersion, ...(mapping.catalogArtifactRef ? { catalogArtifactRef: mapping.catalogArtifactRef } : {}), pricingSnapshot: offering.pricing }];
    });
  }

  private async loadCatalog(): Promise<Catalog> {
    const now = Date.now();
    if (this.cached && this.cacheTtlMs > 0 && this.cached.expiresAt > now && Date.parse(this.cached.catalog.expiresAt) > now) return this.cached.catalog;
    if (!this.loading) {
      this.loading = (async () => {
        const url = new URL('/v1/catalog/models', this.baseUrl);
        let response: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          response = await this.fetchImpl(url, { method: 'GET', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
          if (response.status !== 429 || attempt === 2) break;
          await response.body?.cancel();
          await sleep(retryAfterMs(response.headers.get('retry-after')));
        }
        if (!response) throw new Error('Planprice v1 catalog request did not return a response');
        if (!response.ok) throw new Error(`Planprice v1 catalog returned HTTP ${response.status}`);
        const catalog = assertCatalog(await response.json());
        const retrievedAt = new Date().toISOString();
        const catalogExpiresAt = Date.parse(catalog.expiresAt);
        if (!Number.isFinite(catalogExpiresAt) || catalogExpiresAt <= Date.now()) throw new Error('Planprice v1 catalog is expired');
        this.lastRetrievedAt = retrievedAt;
        this.lastCatalogVersion = catalog.catalogVersion;
        this.lastCatalogDigest = catalog.digest;
        this.cached = { catalog, expiresAt: this.cacheTtlMs === 0 ? Date.now() : Math.min(Date.now() + this.cacheTtlMs, catalogExpiresAt) };
        return catalog;
      })().finally(() => { this.loading = undefined; });
    }
    return this.loading;
  }
}

export type { ProviderMapping };
