import type { ModelDecision, ModelCatalog, ModelSelectionRequest } from '../integrations.js';
import { selectModel } from '../integrations.js';
import type { ModelAdapter, ModelHealth } from './model.js';
import { HttpModelAdapter } from './model.js';
import type { ModelPin } from './contracts.js';

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

export interface CatalogModelFactory { create(model: string, endpoint: string, provider?: string): ModelAdapter }
export class CatalogModelResolver implements ModelResolver {
  private readonly adapters = new Map<string, ModelAdapter>();
  constructor(private readonly catalog: ModelCatalog, private readonly factory: CatalogModelFactory) {}
  async resolve(request: ModelSelectionRequest): Promise<ModelResolution> {
    const rows = await this.catalog.list({ capability: request.capability, ...(request.minContextTokens === undefined ? {} : { minContextTokens: request.minContextTokens }) });
    const decision = selectModel(rows, request);
    if (!decision.selected.endpoint) throw new Error(`Selected model ${decision.selected.model} has no configured provider endpoint`);
    const adapter = this.factory.create(decision.selected.model, decision.selected.endpoint, decision.selected.provider);
    this.adapters.set(key(adapter.pin), adapter);
    return { adapter, decision };
  }
  forPin(pin: ModelPin): ModelAdapter {
    const existing = this.adapters.get(key(pin));
    if (existing) return existing;
    const adapter = this.factory.create(pin.model, pin.endpoint, pin.provider);
    this.adapters.set(key(pin), adapter);
    return adapter;
  }
  async health(): Promise<ModelHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const rows = await this.catalog.list({ capability: 'agent' });
      const decision = selectModel(rows, { capability: 'agent', privacy: 'internal' });
      if (!decision.selected.endpoint) return { ready: false, detail: `Selected catalog model ${decision.selected.model} has no provider endpoint`, checkedAt };
      const adapter = this.factory.create(decision.selected.model, decision.selected.endpoint, decision.selected.provider);
      if (adapter.health) return adapter.health();
      return { ready: true, detail: `catalog selected ${decision.selected.provider}/${decision.selected.model}; provider health probe not configured`, checkedAt };
    } catch (error) {
      return { ready: false, detail: error instanceof Error ? `model catalog/provider probe failed: ${error.message}` : 'model catalog/provider probe failed', checkedAt };
    }
  }
}

export class HttpCatalogModelFactory implements CatalogModelFactory {
  constructor(private readonly apiKeys: Readonly<Record<string, string>> = {}, private readonly healthUrls: Readonly<Record<string, string>> = {}) {}
  create(model: string, endpoint: string, provider?: string): ModelAdapter {
    if (!endpoint) throw new Error(`No provider endpoint configured for catalog model ${model}`);
    const base = endpoint.endsWith('/chat/completions') ? endpoint.slice(0, -'/chat/completions'.length) : endpoint;
    return new HttpModelAdapter(base, model, this.apiKeys[provider ?? ''] ?? this.apiKeys[model] ?? '', provider, 60_000, this.healthUrls[provider ?? ''] ?? this.healthUrls[model]);
  }
}
function key(pin: ModelPin): string { return pin.model + '|' + pin.endpoint + '|' + pin.promptVersion; }
