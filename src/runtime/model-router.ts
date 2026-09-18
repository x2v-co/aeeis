import type { ModelDecision, ModelCatalog, ModelSelectionRequest } from '../integrations.js';
import { selectModel } from '../integrations.js';
import type { ModelAdapter } from './model.js';
import { HttpModelAdapter } from './model.js';
import type { ModelPin } from './contracts.js';

export interface ModelResolution { adapter: ModelAdapter; decision?: ModelDecision }
export interface ModelResolver {
  resolve(request: ModelSelectionRequest): Promise<ModelResolution>;
  forPin(pin: ModelPin): ModelAdapter;
}

export class StaticModelResolver implements ModelResolver {
  constructor(private readonly adapter: ModelAdapter) {}
  async resolve(_request: ModelSelectionRequest): Promise<ModelResolution> { return { adapter: this.adapter }; }
  forPin(pin: ModelPin): ModelAdapter {
    if (pin.model !== this.adapter.pin.model || pin.endpoint !== this.adapter.pin.endpoint || pin.promptVersion !== this.adapter.pin.promptVersion || pin.provider !== this.adapter.pin.provider) throw new Error('Pinned model is unavailable in the configured resolver');
    return this.adapter;
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
}

export class HttpCatalogModelFactory implements CatalogModelFactory {
  constructor(private readonly apiKeys: Readonly<Record<string, string>> = {}) {}
  create(model: string, endpoint: string, provider?: string): ModelAdapter {
    if (!endpoint) throw new Error(`No provider endpoint configured for catalog model ${model}`);
    const base = endpoint.endsWith('/chat/completions') ? endpoint.slice(0, -'/chat/completions'.length) : endpoint;
    return new HttpModelAdapter(base, model, this.apiKeys[provider ?? ''] ?? this.apiKeys[model] ?? '', provider);
  }
}
function key(pin: ModelPin): string { return pin.model + '|' + pin.endpoint + '|' + pin.promptVersion; }
