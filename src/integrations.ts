import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
const execFile = promisify(execFileCallback);

export const receiptSchema = z.object({
  schemaVersion: z.literal('receipt/1'), receiptId: z.string().regex(/^receipt_[a-f0-9-]{36}$/),
  provider: z.string().min(1).max(200), operation: z.string().min(1).max(200), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), inputRefs: z.array(z.string().max(200)).max(1000),
  outputRefs: z.array(z.string().max(200)).max(1000), capabilitiesUsed: z.array(z.string().max(100)).max(100),
  startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['completed', 'failed', 'unknown']), cost: z.object({ tokens: z.number().int().nonnegative().optional(), money: z.number().nonnegative().optional(), currency: z.string().max(10).optional() }).strict().optional(),
  latencyMs: z.number().nonnegative().optional(), errorCode: z.string().max(100).optional(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;

export interface ToolInvocation {
  toolId: string; toolVersion: string; taskId: string; purpose: string; input: unknown;
  capabilityGrant: string; idempotencyKey: string; timeoutMs: number;
}
export interface ToolResult { status: 'completed' | 'failed' | 'unknown'; output?: unknown; outputRefs?: string[]; receipt: Receipt; }
export interface ToolGateway {
  listTools(): Promise<Array<{ id: string; version: string; capabilities: string[]; inputSchema: unknown; outputSchema: unknown }>>;
  invoke(request: ToolInvocation): Promise<ToolResult>;
  reconcile?(request: ToolInvocation, receipt: Receipt): Promise<ToolResult>;
}

export interface SkillGovernance {
  resolve(task: string, options?: { runtime?: string; cached?: boolean }): Promise<{ methodId?: string; version?: string; plan: unknown; receiptRef?: string }>;
  record(input: { task: string; outcome: 'success' | 'failure'; correction?: string; summary: string; evidence: string[]; runtime?: string }): Promise<{ receiptRef: string }>;
  propose(): Promise<Array<{ id: string; task: string; status: string; sourceReceiptId: string }>>;
  apply(proposalId: string): Promise<{ methodId: string; version: string }>;
  rollback(methodId: string, version: string): Promise<{ methodId: string; version: string }>;
}

export interface ModelCatalog {
  list(query: { capability?: string; minContextTokens?: number }): Promise<Array<{ model: string; provider: string; endpoint: string; capabilities: string[]; inputPricePerMillion?: number; outputPricePerMillion?: number; priceCurrency?: string; contextTokens?: number; availability?: string; privateDataAllowed?: boolean }>>;
}
export interface ModelSelectionRequest { capability: string; privacy: 'public' | 'internal' | 'confidential' | 'private'; maxMoney?: number; minContextTokens?: number; }
export interface ModelDecision {
  schemaVersion: 'model-decision/1'; selected: { model: string; provider: string; endpoint: string };
  candidates: Array<{ model: string; provider: string; reason: string; accepted: boolean }>; reason: string; decidedAt: string;
}

export function selectModel(catalog: Array<{ model: string; provider: string; endpoint: string; capabilities: string[]; outputPricePerMillion?: number; priceCurrency?: string; contextTokens?: number; privateDataAllowed?: boolean; availability?: string }>, request: ModelSelectionRequest): ModelDecision {
  const candidates = catalog.filter(model =>
    model.capabilities.includes(request.capability)
    && Boolean(model.endpoint)
    && model.availability !== 'unavailable'
    && (!request.minContextTokens || (model.contextTokens !== undefined && model.contextTokens >= request.minContextTokens))
    && (request.privacy !== 'private' || model.privateDataAllowed === true)
    && (request.maxMoney === undefined || model.outputPricePerMillion === undefined || model.outputPricePerMillion <= request.maxMoney),
  );
  if (candidates.length === 0) throw new Error('No model satisfies the requested capability and policy');
  const priced = candidates.filter(item => item.outputPricePerMillion !== undefined && Number.isFinite(item.outputPricePerMillion));
  const currencies = new Set(priced.map(item => item.priceCurrency ?? 'USD'));
  const comparable = priced.length > 0 && currencies.size === 1;
  const ranked = (comparable ? priced : candidates).slice().sort((a, b) => comparable ? (a.outputPricePerMillion! - b.outputPricePerMillion!) : a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider));
  const selected = ranked[0]!;
  const selectionReason = comparable ? 'lowest known output price within policy' : priced.length > 0 ? 'deterministic eligible choice; catalog prices use incomparable currencies' : 'deterministic eligible choice; catalog supplied no comparable output price';
  return { schemaVersion: 'model-decision/1', selected: { model: selected.model, provider: selected.provider, endpoint: selected.endpoint }, candidates: candidates.map(item => ({ model: item.model, provider: item.provider, reason: item === selected ? selectionReason : 'eligible fallback', accepted: item === selected })), reason: 'Selected ' + selected.model + ' for ' + request.capability + '; privacy=' + request.privacy + '; ' + selectionReason, decidedAt: new Date().toISOString() };
}

export class ConfiguredHttpToolGateway implements ToolGateway {
  constructor(private readonly manifestUrl: string, private readonly invokeUrl: string, private readonly token?: string, private readonly reconcileUrl?: string) {
    for (const value of [manifestUrl, invokeUrl, reconcileUrl].filter((item): item is string => Boolean(item))) {
      const url = new URL(value);
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Tool gateway URLs must use HTTPS except loopback');
      if (url.username || url.password || url.hash) throw new Error('Tool gateway URL must not contain credentials or fragments');
    }
  }
  async listTools() {
    const response = await fetch(this.manifestUrl, { headers: this.token ? { authorization: 'Bearer ' + this.token } : {}, redirect: 'error' });
    if (!response.ok) throw new Error('Tool manifest returned HTTP ' + response.status);
    const body = z.object({ schemaVersion: z.literal('tool-manifest/1'), tools: z.array(z.object({ id: z.string(), version: z.string(), capabilities: z.array(z.string()), inputSchema: z.unknown(), outputSchema: z.unknown() }).strict()) }).strict().parse(await response.json());
    return body.tools;
  }
  async invoke(request: ToolInvocation): Promise<ToolResult> {
    const started = new Date(); const requestHash = digest(request);
    try {
      const response = await fetch(this.invokeUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(request.timeoutMs), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: 'Bearer ' + this.token } : {}) }, body: JSON.stringify({ schemaVersion: 'tool-invocation/1', ...request }) });
      if (!response.ok) throw new Error('Tool gateway returned HTTP ' + response.status);
      const parsed = z.object({ schemaVersion: z.literal('tool-result/1'), status: z.enum(['completed', 'failed', 'unknown']), output: z.unknown().optional(), outputRefs: z.array(z.string()).optional(), receipt: receiptSchema }).strict().parse(await response.json());
      return { status: parsed.status, receipt: parsed.receipt, ...(parsed.output === undefined ? {} : { output: parsed.output }), ...(parsed.outputRefs === undefined ? {} : { outputRefs: parsed.outputRefs }) };
    } catch (error) {
      const receipt = receiptSchema.parse({ schemaVersion: 'receipt/1', receiptId: 'receipt_' + randomUUID(), provider: 'tool-gateway', operation: request.toolId, requestHash, inputRefs: [request.taskId], outputRefs: [], capabilitiesUsed: [], startedAt: started.toISOString(), completedAt: new Date().toISOString(), status: 'unknown', errorCode: error instanceof Error ? 'transport_or_protocol' : 'unknown' });
      return { status: 'unknown', receipt };
    }
  }
  async reconcile(request: ToolInvocation, receipt: Receipt): Promise<ToolResult> {
    if (!this.reconcileUrl) throw new Error('Toolkit reconciliation endpoint is not configured');
    const response = await fetch(this.reconcileUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(request.timeoutMs), headers: { 'content-type': 'application/json', ...(this.token ? { authorization: 'Bearer ' + this.token } : {}) }, body: JSON.stringify({ schemaVersion: 'tool-reconcile/1', request, receipt }) });
    if (!response.ok) throw new Error('Tool reconciliation returned HTTP ' + response.status);
    const parsed = z.object({ schemaVersion: z.literal('tool-result/1'), status: z.enum(['completed', 'failed', 'unknown']), output: z.unknown().optional(), outputRefs: z.array(z.string()).optional(), receipt: receiptSchema }).strict().parse(await response.json());
    return { status: parsed.status, receipt: parsed.receipt, ...(parsed.output === undefined ? {} : { output: parsed.output }), ...(parsed.outputRefs === undefined ? {} : { outputRefs: parsed.outputRefs }) };
  }
}

/**
 * Adapter for toolkit_new's public Registry and published-tool REST contract.
 *
 * AEEIS keeps its own allowlist, idempotency and Receipt semantics. The
 * toolkit registry is only used to resolve an immutable tool version and its
 * execution endpoint; the toolkit response is translated at this boundary.
 */
export class ToolkitRegistryGateway implements ToolGateway {
  private manifestCache = new Map<string, { id: string; version: string; capabilities: string[]; inputSchema: unknown; outputSchema: unknown; endpoint: string }>();

  constructor(private readonly registryUrl: string, private readonly token?: string) {
    const url = new URL(registryUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Toolkit Registry URL must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Toolkit Registry URL must use HTTPS except loopback');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  private registryPath(path: string): string {
    return new URL(path.replace(/^\//, ''), this.registryUrl.replace(/\/$/, '') + '/').toString();
  }

  private endpointFor(value: string): string {
    const endpoint = new URL(value, this.registryUrl);
    const base = new URL(this.registryUrl);
    if (endpoint.origin !== base.origin) throw new Error('Toolkit endpoint must share the Registry origin');
    if (endpoint.username || endpoint.password || endpoint.hash) throw new Error('Toolkit endpoint must not contain credentials or fragments');
    return endpoint.toString();
  }

  async listTools() {
    const response = await fetch(this.registryPath('/manifest'), { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Toolkit Registry manifest returned HTTP ' + response.status);
    const index = z.object({
      schemaVersion: z.literal('toolkit.registry.index.v1'),
      tools: z.array(z.object({ slug: z.string().min(1), version: z.union([z.string(), z.number()]), manifestUrl: z.string().url() }).passthrough()),
    }).passthrough().parse(await response.json());
    const resolved: Array<{ id: string; version: string; capabilities: string[]; inputSchema: unknown; outputSchema: unknown }> = [];
    for (const entry of index.tools) {
      const manifestResponse = await fetch(this.endpointFor(entry.manifestUrl), { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!manifestResponse.ok) throw new Error(`Toolkit manifest ${entry.slug} returned HTTP ${manifestResponse.status}`);
      const manifest = z.object({
        schemaVersion: z.literal('toolkit.registry.tool.v1'), slug: z.string().min(1), version: z.union([z.string(), z.number()]),
        inputSchema: z.unknown().optional(), endpoints: z.object({ rest: z.string().url() }).passthrough(), runtime: z.object({ sandbox: z.unknown().optional() }).passthrough().optional(),
      }).passthrough().parse(await manifestResponse.json());
      if (manifest.slug !== entry.slug || String(manifest.version) !== String(entry.version)) throw new Error(`Toolkit manifest ${entry.slug} disagrees with Registry index`);
      const tool = {
        id: manifest.slug, version: String(manifest.version), capabilities: ['execute'], inputSchema: manifest.inputSchema ?? {}, outputSchema: {}, endpoint: this.endpointFor(manifest.endpoints.rest),
      };
      this.manifestCache.set(`${tool.id}@${tool.version}`, tool);
      resolved.push({ id: tool.id, version: tool.version, capabilities: tool.capabilities, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema });
    }
    return resolved;
  }

  private async tool(request: ToolInvocation): Promise<{ id: string; version: string; endpoint: string }> {
    const cached = this.manifestCache.get(`${request.toolId}@${request.toolVersion}`);
    if (cached) return cached;
    await this.listTools();
    const resolved = this.manifestCache.get(`${request.toolId}@${request.toolVersion}`);
    if (!resolved) throw new Error(`Toolkit tool ${request.toolId}@${request.toolVersion} is not in the Registry manifest`);
    return resolved;
  }

  async invoke(request: ToolInvocation): Promise<ToolResult> {
    const started = new Date();
    const requestHash = digest(request);
    try {
      const tool = await this.tool(request);
      const payload = normalizeToolkitInput(request.input);
      const response = await fetch(tool.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(request.timeoutMs),
        headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('Toolkit execution returned HTTP ' + response.status);
      const body = z.object({ ok: z.boolean(), output: z.unknown().optional(), error: z.string().optional(), structuredContent: z.unknown().optional(), receipt: z.object({ id: z.union([z.string(), z.number()]).optional() }).passthrough().optional() }).passthrough().parse(await response.json());
      const status: ToolResult['status'] = body.ok ? 'completed' : 'failed';
      const providerReceipt = body.receipt?.id === undefined ? undefined : String(body.receipt.id);
      const result = body.ok ? (body.output ?? body.structuredContent ?? null) : { error: body.error ?? 'Toolkit execution failed' };
      const receipt = makeToolkitReceipt({ request, requestHash, started, status, response: body, ...(providerReceipt ? { providerReceipt } : {}) });
      return { status, output: result, ...(providerReceipt ? { outputRefs: [`toolkit-receipt:${providerReceipt}`] } : {}), receipt };
    } catch (error) {
      return { status: 'unknown', receipt: makeToolkitReceipt({ request, requestHash, started, status: 'unknown', errorCode: error instanceof Error ? 'transport_or_protocol' : 'unknown' }) };
    }
  }

  async reconcile(request: ToolInvocation, receipt: Receipt): Promise<ToolResult> {
    const reference = receipt.outputRefs.find(value => value.startsWith('toolkit-receipt:'));
    if (!reference) throw new Error('Toolkit receipt does not contain a provider receipt reference');
    const providerReceipt = reference.slice('toolkit-receipt:'.length);
    const response = await fetch(this.registryPath(`/../run/receipts/${encodeURIComponent(providerReceipt)}`), { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(request.timeoutMs) });
    if (!response.ok) throw new Error('Toolkit receipt reconciliation returned HTTP ' + response.status);
    const body = z.object({ receipt: z.object({ ok: z.boolean(), output: z.unknown().optional(), error: z.string().optional() }).passthrough() }).passthrough().parse(await response.json()).receipt;
    const status: ToolResult['status'] = body.ok ? 'completed' : 'failed';
    const responseHash = digest(body);
    const updated = receiptSchema.parse({ ...receipt, responseHash, completedAt: new Date().toISOString(), status, outputRefs: [`toolkit-receipt:${providerReceipt}`], errorCode: body.ok ? undefined : 'tool_failed' });
    return { status, output: body.ok ? (body.output ?? null) : { error: body.error ?? 'Toolkit execution failed' }, outputRefs: [`toolkit-receipt:${providerReceipt}`], receipt: updated };
  }
}

function normalizeToolkitInput(input: unknown): { input: string; params?: Record<string, unknown> } {
  if (typeof input === 'string') return { input };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (typeof record.input === 'string') {
      const { input: value, ...params } = record;
      return Object.keys(params).length ? { input: value, params } : { input: value };
    }
  }
  return { input: JSON.stringify(input) };
}

function makeToolkitReceipt(input: { request: ToolInvocation; requestHash: string; started: Date; status: ToolResult['status']; response?: unknown; providerReceipt?: string; errorCode?: string }): Receipt {
  return receiptSchema.parse({
    schemaVersion: 'receipt/1', receiptId: 'receipt_' + randomUUID(), provider: 'toolkit_new', operation: input.request.toolId,
    requestHash: input.requestHash, ...(input.response === undefined ? {} : { responseHash: digest(input.response) }),
    inputRefs: [input.request.taskId], outputRefs: input.providerReceipt ? [`toolkit-receipt:${input.providerReceipt}`] : [], capabilitiesUsed: ['execute'],
    startedAt: input.started.toISOString(), completedAt: new Date().toISOString(), status: input.status, ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

export class OwnHowCliGovernance implements SkillGovernance {
  constructor(private readonly executable = 'ownhow', private readonly stateDirectory?: string, private readonly defaultRuntime?: string) {
    if (defaultRuntime !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(defaultRuntime)) throw new Error('OwnHow runtime must be a simple runtime identifier');
  }
  private async run(args: string[]): Promise<unknown> {
    const finalArgs = [...args, '--json', ...(this.stateDirectory ? ['--state', this.stateDirectory] : [])];
    try {
      const result = await execFile(this.executable, finalArgs, { timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true });
      return JSON.parse(result.stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message.split('\\n')[0] : 'process failed';
      throw new Error('OwnHow command failed: ' + detail);
    }
  }
  async resolve(task: string, options: { runtime?: string; cached?: boolean } = {}) {
    const args = ['resolve', task];
    const runtime = options.runtime ?? this.defaultRuntime;
    if (!runtime) throw new Error('OwnHow runtime is required; set skillRuntime on the Run or AEEIS_OWNHOW_RUNTIME');
    args.push('--runtime', runtime);
    if (options.cached) args.push('--cached');
    const value = await this.run(args) as { methodId?: string; methodVersion?: string; plan?: unknown; digest?: string };
    return { ...(value.methodId ? { methodId: value.methodId } : {}), ...(value.methodVersion ? { version: value.methodVersion } : {}), plan: value.plan ?? value, ...(value.digest ? { receiptRef: value.digest } : {}) };
  }
  async record(input: { task: string; outcome: 'success' | 'failure'; correction?: string; summary: string; evidence: string[]; runtime?: string }) {
    const args = ['record', input.task, '--outcome', input.outcome, '--summary', input.summary];
    if (input.correction) args.push('--correction', input.correction);
    for (const evidence of input.evidence) args.push('--evidence', evidence);
    const runtime = input.runtime ?? this.defaultRuntime;
    if (!runtime) throw new Error('OwnHow runtime is required; set skillRuntime on the Run or AEEIS_OWNHOW_RUNTIME');
    args.push('--runtime', runtime);
    const value = await this.run(args) as { id?: string; receiptId?: string };
    const receiptRef = value.receiptId ?? value.id;
    if (!receiptRef) throw new Error('OwnHow record response did not contain a receipt reference');
    return { receiptRef };
  }
  async propose() {
    const value = await this.run(['propose']);
    const proposals = Array.isArray(value) ? value : (value as { proposals?: unknown[] }).proposals ?? [];
    return z.array(z.object({ id: z.string(), task: z.string(), status: z.string(), sourceReceiptId: z.string() }).strict()).parse(proposals);
  }
  async apply(proposalId: string) {
    const value = await this.run(['apply', proposalId]) as { id?: string; methodId?: string; version?: string };
    if (!value.methodId || !value.version) throw new Error('OwnHow apply response did not contain a method version');
    return { methodId: value.methodId, version: value.version };
  }
  async rollback(methodId: string, version: string) {
    const value = await this.run(['rollback', methodId, '--version', version]) as { methodId?: string; version?: string };
    if (!value.methodId || !value.version) throw new Error('OwnHow rollback response did not contain a method version');
    return { methodId: value.methodId, version: value.version };
  }
}

export class PlanpriceHttpCatalog implements ModelCatalog {
  constructor(private readonly baseUrl: string, private readonly providerEndpoints: Readonly<Record<string, string>> = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Planprice URL must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Planprice URL must use HTTPS except loopback');
  }
  async list(query: { capability?: string; minContextTokens?: number } = {}) {
    const url = new URL('/api/products/grouped', this.baseUrl);
    url.searchParams.set('type', 'llm');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Planprice catalog returned HTTP ' + response.status);
    const rows = z.array(z.object({ slug: z.string().min(1), context_window: z.number().nullable().optional(), versions: z.array(z.record(z.string(), z.unknown())).default([]) }).passthrough()).parse(await response.json());
    const rates = await this.exchangeRates();
    const candidates = rows.flatMap(row => row.versions.map(version => {
      const providerRecord = version.providers;
      const provider = typeof providerRecord === 'object' && providerRecord && 'slug' in providerRecord ? String(providerRecord.slug) : 'unknown-provider';
      const model = typeof version.model_slug === 'string' ? version.model_slug : row.slug;
      const capabilities = ['text', 'agent'];
      const endpoint = this.providerEndpoints[provider] ?? this.providerEndpoints[provider.toLocaleLowerCase()] ?? '';
      const currency = typeof version.currency === 'string' ? version.currency.toUpperCase() : undefined;
      const inputPrice = normalizedUsd(version.input_price_per_1m, currency, rates);
      const outputPrice = normalizedUsd(version.output_price_per_1m, currency, rates);
      return { model, provider, endpoint, capabilities, ...(inputPrice === undefined ? {} : { inputPricePerMillion: inputPrice }), ...(outputPrice === undefined ? {} : { outputPricePerMillion: outputPrice, priceCurrency: 'USD' }), ...(typeof row.context_window === 'number' ? { contextTokens: row.context_window } : {}), availability: version.is_available === false ? 'unavailable' : 'available' };
    }));
    return candidates.filter(row => (!query.capability || row.capabilities.includes(query.capability.toLocaleLowerCase())) && (!query.minContextTokens || (row.contextTokens !== undefined && row.contextTokens >= query.minContextTokens)) && row.availability !== 'unavailable');
  }

  private async exchangeRates(): Promise<Record<string, number>> {
    try {
      const response = await fetch(new URL('/api/exchange-rates', this.baseUrl), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return {};
      const body = z.object({ rates: z.record(z.string(), z.number().positive()).optional() }).passthrough().parse(await response.json());
      return Object.fromEntries(Object.entries(body.rates ?? {}).map(([currency, rate]) => [currency.toUpperCase(), rate]));
    } catch {
      return {};
    }
  }
}
function normalizedUsd(value: unknown, currency: string | undefined, rates: Readonly<Record<string, number>>): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (!currency || currency === 'USD') return value;
  const rate = rates[currency];
  return rate && Number.isFinite(rate) && rate > 0 ? value / rate : undefined;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
