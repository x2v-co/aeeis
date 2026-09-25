import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { validateHealthEndpoint, type DependencyHealth } from './dependency-health.js';
const execFile = promisify(execFileCallback);

export const receiptSchema = z.object({
  schemaVersion: z.literal('receipt/1'), receiptId: z.string().regex(/^receipt_[a-f0-9-]{36}$/),
  provider: z.string().min(1).max(200), operation: z.string().min(1).max(200), requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), inputRefs: z.array(z.string().max(200)).max(1000),
  outputRefs: z.array(z.string().max(200)).max(1000), capabilitiesUsed: z.array(z.string().max(100)).max(100),
  startedAt: z.string().datetime({ offset: true }), completedAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['completed', 'failed', 'unknown']), cost: z.object({ tokens: z.number().int().nonnegative().optional(), money: z.number().nonnegative().optional(), currency: z.string().max(10).optional() }).strict().optional(),
  latencyMs: z.number().nonnegative().optional(), errorCode: z.string().max(100).optional(),
  /** AEEIS-side admission decision, added only after the durable Run commit. */
  authorization: z.object({
    toolId: z.string().min(1).max(200), toolVersion: z.string().min(1).max(100), taskId: z.string().min(1).max(200),
    capabilityGrant: z.string().min(1).max(500), idempotencyKey: z.string().min(1).max(500),
    decision: z.enum(['authorized', 'isolated']),
    reason: z.enum(['admitted', 'cancelled', 'capability_mismatch', 'budget_stopped']),
    settledAt: z.string().datetime({ offset: true }), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).strict().optional(),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;

export interface ToolInvocation {
  toolId: string; toolVersion: string; taskId: string; purpose: string; input: unknown;
  capabilityGrant: string; idempotencyKey: string; timeoutMs: number;
}
export interface ToolResult { status: 'completed' | 'failed' | 'unknown'; output?: unknown; outputRefs?: string[]; receipt: Receipt; }
export interface ToolDescriptor {
  id: string; version: string; capabilities: string[]; description?: string;
  inputSchema: unknown; outputSchema: unknown;
}
export interface ToolkitPinnedTool {
  id: string;
  version: string;
  endpoint: string;
  capabilities?: string[];
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}
export interface ToolGateway {
  listTools(): Promise<ToolDescriptor[]>;
  invoke(request: ToolInvocation): Promise<ToolResult>;
  reconcile?: ((request: ToolInvocation, receipt: Receipt) => Promise<ToolResult>) | undefined;
  /** Optional read-only protocol/dependency probe. It must not invoke a tool. */
  health?(): Promise<{ ready: boolean; detail: string; checkedAt?: string }>;
}

export interface SkillGovernance {
  /** Checks the adapter protocol, not the quality of governed methods. */
  health?(): Promise<{ ready: boolean; detail: string; checkedAt: string }>;
  resolve(task: string, options?: { runtime?: string; cached?: boolean }): Promise<{ methodId?: string; version?: string; plan: unknown; receiptRef?: string }>;
  record(input: { task: string; outcome: 'success' | 'failure'; correction?: string; summary: string; evidence: string[]; runtime?: string; confidence?: 'low' | 'medium' | 'high' | 'unknown'; verifiedBy?: 'user' | 'agent' | 'automated' | 'unknown' }): Promise<{ receiptRef: string }>;
  propose(): Promise<Array<{ id: string; task: string; status: string; sourceReceiptId: string }>>;
  apply(proposalId: string): Promise<{ methodId: string; version: string }>;
  rollback(methodId: string, version: string): Promise<{ methodId: string; version: string }>;
}

export interface ModelCatalogRow {
  model: string; provider: string; endpoint: string; capabilities: string[];
  inputPricePerMillion?: number; outputPricePerMillion?: number; priceCurrency?: string;
  contextTokens?: number; availability?: string; privateDataAllowed?: boolean;
  /** Planprice v1 provenance retained for the formal AEEIS Model Pin. */
  offeringId?: string; modelId?: string; modelVersion?: string | null;
  versionStatus?: 'pinned' | 'rolling' | 'unknown'; providerId?: string; channelId?: string;
  regionSetId?: string; pricingVariantId?: string; catalogVersion?: string;
  catalogDigest?: string; offeringHash?: string; catalogRetrievedAt?: string; endpointRef?: string; requestModel?: string;
  mappingVersion?: string; catalogArtifactRef?: string; pricingSnapshot?: unknown;
}
export interface ModelCatalog {
  list(query: { capability?: string; minContextTokens?: number }): Promise<ModelCatalogRow[]>;
  /** Optional read-only catalog dependency probe. It must never invoke a model. */
  health?(): Promise<DependencyHealth>;
  /** Timestamp of the last successful upstream catalog read, when available. */
  lastRetrievedAt?: string;
}
export interface ModelSelectionRequest {
  capability: string;
  privacy: 'public' | 'internal' | 'confidential' | 'private';
  maxMoney?: number;
  minContextTokens?: number;
  /** Timestamp captured immediately before the catalog was read. */
  catalogRetrievedAt?: string;
}
export interface ModelDecision {
  schemaVersion: 'model-decision/1'; selected: { model: string; provider: string; endpoint: string; inputPricePerMillion?: number; outputPricePerMillion?: number; priceCurrency?: string; offeringId?: string };
  /** Digest of the normalized eligible catalog rows used by this decision. */
  catalogHash?: string;
  catalogRetrievedAt?: string;
  candidates: Array<{ model: string; provider: string; reason: string; accepted: boolean }>; reason: string; decidedAt: string;
}

export function selectModel(catalog: ModelCatalogRow[], request: ModelSelectionRequest): ModelDecision {
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
  const catalogHash = digestCatalog(candidates);
  return {
    schemaVersion: 'model-decision/1',
    selected: { model: selected.model, provider: selected.provider, endpoint: selected.endpoint, ...(selected.offeringId === undefined ? {} : { offeringId: selected.offeringId }), ...(selected.inputPricePerMillion === undefined ? {} : { inputPricePerMillion: selected.inputPricePerMillion }), ...(selected.outputPricePerMillion === undefined ? {} : { outputPricePerMillion: selected.outputPricePerMillion }), ...(selected.priceCurrency === undefined ? {} : { priceCurrency: selected.priceCurrency }) },
    catalogHash,
    ...(request.catalogRetrievedAt === undefined ? {} : { catalogRetrievedAt: request.catalogRetrievedAt }),
    candidates: candidates.map(item => ({ model: item.model, provider: item.provider, reason: item === selected ? selectionReason : 'eligible fallback', accepted: item === selected })), reason: 'Selected ' + selected.model + ' for ' + request.capability + '; privacy=' + request.privacy + '; ' + selectionReason, decidedAt: new Date().toISOString(),
  };
}

function digestCatalog(catalog: Array<{ model: string; provider: string; endpoint: string; inputPricePerMillion?: number; outputPricePerMillion?: number; priceCurrency?: string; contextTokens?: number; availability?: string; privateDataAllowed?: boolean }>): string {
  const normalized = catalog.map(item => ({
    model: item.model, provider: item.provider, endpoint: item.endpoint,
    ...(item.inputPricePerMillion === undefined ? {} : { inputPricePerMillion: item.inputPricePerMillion }),
    ...(item.outputPricePerMillion === undefined ? {} : { outputPricePerMillion: item.outputPricePerMillion }),
    ...(item.priceCurrency === undefined ? {} : { priceCurrency: item.priceCurrency }),
    ...(item.contextTokens === undefined ? {} : { contextTokens: item.contextTokens }),
    ...(item.availability === undefined ? {} : { availability: item.availability }),
    ...(item.privateDataAllowed === undefined ? {} : { privateDataAllowed: item.privateDataAllowed }),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function toolkitCanonicalize(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(toolkitCanonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, toolkitCanonicalize(nested)]));
  return value;
}

function toolkitDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(toolkitCanonicalize(value))).digest('hex')}`;
}

function envelopePayload(value: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, signature: _signature, ...payload } = value;
  return payload;
}

function assertToolkitEnvelope(value: Record<string, unknown>, label: string): { digest: string; signature: Record<string, unknown> } {
  const digestValue = typeof value.digest === 'string' ? value.digest : '';
  const signature = value.signature && typeof value.signature === 'object' ? value.signature as Record<string, unknown> : undefined;
  if (!/^sha256:[a-f0-9]{64}$/.test(digestValue) || toolkitDigest(envelopePayload(value)) !== digestValue) throw new Error(`${label} digest does not match its canonical payload`);
  if (!signature || signature.payloadDigest !== digestValue || signature.alg !== 'EdDSA' || typeof signature.keyId !== 'string' || typeof signature.value !== 'string') throw new Error(`${label} signature is missing or not bound to its digest`);
  return { digest: digestValue, signature };
}

function verifyToolkitDigestSignature(digestValue: string, signature: Record<string, unknown>, jwk: Record<string, unknown>, label: string): void {
  const raw = String(signature.value).replace(/^ed25519:/, '');
  try {
    const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
    if (!verifySignature(null, Buffer.from(digestValue), publicKey, Buffer.from(raw, 'base64url'))) throw new Error('invalid signature');
  } catch (error) {
    throw new Error(`${label} signature verification failed: ${error instanceof Error ? error.message : 'invalid key or signature'}`);
  }
}

export class ConfiguredHttpToolGateway implements ToolGateway {
  constructor(private readonly manifestUrl: string, private readonly invokeUrl: string, private readonly token?: string, private readonly reconcileUrl?: string) {
    for (const value of [manifestUrl, invokeUrl, reconcileUrl].filter((item): item is string => Boolean(item))) {
      const url = new URL(value);
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Tool gateway URLs must use HTTPS except loopback');
      if (url.username || url.password || url.hash) throw new Error('Tool gateway URL must not contain credentials or fragments');
    }
  }
  async health(): Promise<{ ready: boolean; detail: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    try {
      const tools = await this.listTools();
      return { ready: true, detail: `tool manifest reachable (${tools.length} tools)`, checkedAt };
    } catch (error) {
      return { ready: false, detail: `tool manifest unavailable: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 500), checkedAt };
    }
  }
  async listTools() {
    const response = await fetch(this.manifestUrl, { headers: this.token ? { authorization: 'Bearer ' + this.token } : {}, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Tool manifest returned HTTP ' + response.status);
    const body = z.object({ schemaVersion: z.literal('tool-manifest/1'), tools: z.array(z.object({ id: z.string(), version: z.string(), capabilities: z.array(z.string()), description: z.string().max(4000).optional(), inputSchema: z.unknown(), outputSchema: z.unknown() }).strict()) }).strict().parse(await response.json());
    return body.tools.map(({ description, ...tool }) => ({ ...tool, ...(description === undefined ? {} : { description }) }));
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
  private manifestCache = new Map<string, { id: string; version: string; capabilities: string[]; inputSchema: unknown; outputSchema: unknown; endpoint: string; description?: string }>();
  private verifiedManifests = new Map<string, Record<string, unknown>>();
  private loading?: Promise<ToolDescriptor[]>;
  reconcile?: ToolGateway['reconcile'];

  constructor(private readonly registryUrl: string, private readonly token?: string, private readonly options: { verifySignatures?: boolean; trustBundleUrl?: string; rootPublicJwk?: Record<string, unknown>; reconcileUrl?: string; additionalTools?: ToolkitPinnedTool[] } = {}) {
    const url = new URL(registryUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Toolkit Registry URL must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Toolkit Registry URL must use HTTPS except loopback');
    if (options.reconcileUrl) {
      const reconcile = new URL(options.reconcileUrl);
      if (reconcile.username || reconcile.password || reconcile.search || reconcile.hash) throw new Error('Toolkit reconciliation URL must not contain credentials, query or fragment');
      if (reconcile.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(reconcile.hostname)) throw new Error('Toolkit reconciliation URL must use HTTPS except loopback');
      this.reconcile = (request, receipt) => this.reconcileThroughGateway(request, receipt);
    }
    for (const extra of options.additionalTools ?? []) {
      const endpoint = this.endpointFor(extra.endpoint);
      if (!extra.id.trim() || !extra.version.trim()) throw new Error('Pinned toolkit tool id and version must be non-empty');
      this.manifestCache.set(`${extra.id}@${extra.version}`, {
        id: extra.id, version: extra.version, endpoint,
        capabilities: extra.capabilities ?? ['execute'], inputSchema: extra.inputSchema ?? {}, outputSchema: extra.outputSchema ?? {},
        ...(extra.description === undefined ? {} : { description: extra.description }),
      });
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  async health(): Promise<{ ready: boolean; detail: string; checkedAt: string }> {
    const checkedAt = new Date().toISOString();
    try {
      const tools = await this.listTools();
      return { ready: true, detail: `Toolkit Registry reachable (${tools.length} tools)`, checkedAt };
    } catch (error) {
      return { ready: false, detail: `Toolkit Registry unavailable: ${error instanceof Error ? error.message : 'unknown error'}`.slice(0, 500), checkedAt };
    }
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

  private async trust(): Promise<{ keyset: Record<string, unknown> }> {
    if (!this.options.verifySignatures) return { keyset: {} };
    const url = this.options.trustBundleUrl ?? this.registryPath('/keysets/current');
    const response = await fetch(url, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Toolkit Registry keyset returned HTTP ' + response.status);
    const keyset = z.record(z.string(), z.unknown()).parse(await response.json());
    const envelope = assertToolkitEnvelope(keyset, 'Toolkit Registry keyset');
    if (!this.options.rootPublicJwk) throw new Error('Toolkit Registry signature verification requires a trusted root public JWK');
    verifyToolkitDigestSignature(envelope.digest, envelope.signature, this.options.rootPublicJwk, 'Toolkit Registry keyset');
    const expiresAt = typeof keyset.expiresAt === 'string' ? Date.parse(keyset.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Toolkit Registry keyset is expired or missing expiry');
    return { keyset };
  }

  private verifyEnvelope(value: Record<string, unknown>, label: string, keyset: Record<string, unknown>): void {
    if (!this.options.verifySignatures) return;
    const envelope = assertToolkitEnvelope(value, label);
    const keys = Array.isArray(keyset.keys) ? keyset.keys.filter(item => item && typeof item === 'object') as Record<string, unknown>[] : [];
    const key = keys.find(item => item.kid === envelope.signature.keyId);
    const revoked = Array.isArray(keyset.revokedKeys) ? keyset.revokedKeys : [];
    if (revoked.some(item => item === envelope.signature.keyId || (item && typeof item === 'object' && ['kid', 'keyId'].some(field => (item as Record<string, unknown>)[field] === envelope.signature.keyId)))) throw new Error(`${label} signature key is revoked`);
    const jwk = key && typeof key.x === 'string' ? key : undefined;
    if (!jwk) throw new Error(`${label} signature key is not trusted by the Registry keyset`);
    verifyToolkitDigestSignature(envelope.digest, envelope.signature, jwk, label);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    if (this.loading) return this.loading;
    const loading = this.loadTools();
    this.loading = loading;
    try {
      return await loading;
    } finally {
      if (this.loading === loading) delete this.loading;
    }
  }

  private async loadTools(): Promise<ToolDescriptor[]> {
    const response = await fetch(this.registryPath('/manifest'), { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Toolkit Registry manifest returned HTTP ' + response.status);
    const index = z.object({
      schemaVersion: z.literal('toolkit.registry.index.v1'),
      tools: z.array(z.object({ slug: z.string().min(1), version: z.union([z.string(), z.number()]), manifestUrl: z.string().url(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }).passthrough()),
    }).passthrough().parse(await response.json());
    const trust = await this.trust();
    this.verifyEnvelope(index, 'Toolkit Registry index', trust.keyset);
    const loadManifest = async (entry: typeof index.tools[number]) => {
      // Only a fresh, verified index can authorize reuse of an immutable
      // manifest. An unsigned index or one without a digest always refetches.
      const endpoint = this.endpointFor(entry.manifestUrl);
      const cacheKey = this.options.verifySignatures && entry.digest ? `${entry.slug}@${entry.version}:${entry.digest}` : undefined;
      let payload = cacheKey ? this.verifiedManifests.get(cacheKey) : undefined;
      if (!payload) {
        const manifestResponse = await fetch(endpoint, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(15_000) });
        if (!manifestResponse.ok) throw new Error(`Toolkit manifest ${entry.slug} returned HTTP ${manifestResponse.status}`);
        payload = z.record(z.string(), z.unknown()).parse(await manifestResponse.json());
      }
      const manifest = z.object({
        schemaVersion: z.literal('toolkit.registry.tool.v1'), slug: z.string().min(1), version: z.union([z.string(), z.number()]),
        description: z.string().max(4000).optional(), inputSchema: z.unknown().optional(), outputSchema: z.unknown().optional(), endpoints: z.object({ rest: z.string().url() }).passthrough(), runtime: z.object({ sandbox: z.unknown().optional() }).passthrough().optional(),
      }).passthrough().parse(payload);
      this.verifyEnvelope(manifest, `Toolkit manifest ${entry.slug}`, trust.keyset);
      if (manifest.slug !== entry.slug || String(manifest.version) !== String(entry.version)) throw new Error(`Toolkit manifest ${entry.slug} disagrees with Registry index`);
      if (entry.digest && manifest.digest !== entry.digest) throw new Error(`Toolkit manifest ${entry.slug} digest disagrees with Registry index`);
      if (cacheKey) this.verifiedManifests.set(cacheKey, payload);
      return manifest;
    };
    // Bound cold-start fan-out. Subsequent checks only fetch the current index
    // and trust bundle unless a published manifest digest has changed.
    const manifests: Awaited<ReturnType<typeof loadManifest>>[] = new Array(index.tools.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, index.tools.length) }, async () => {
      while (next < index.tools.length) {
        const position = next++;
        manifests[position] = await loadManifest(index.tools[position]!);
      }
    }));
    const activeKeys = new Set(index.tools.filter(entry => entry.digest).map(entry => `${entry.slug}@${entry.version}:${entry.digest}`));
    for (const key of this.verifiedManifests.keys()) if (!activeKeys.has(key)) this.verifiedManifests.delete(key);
    const resolved: ToolDescriptor[] = [];
    for (const manifest of manifests) {
      const tool = {
        id: manifest.slug, version: String(manifest.version), capabilities: ['execute'], inputSchema: manifest.inputSchema ?? {}, outputSchema: manifest.outputSchema ?? {}, ...(manifest.description === undefined ? {} : { description: manifest.description }), endpoint: this.endpointFor(manifest.endpoints.rest),
      };
      this.manifestCache.set(`${tool.id}@${tool.version}`, tool);
      resolved.push({ id: tool.id, version: tool.version, capabilities: tool.capabilities, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, ...(tool.description === undefined ? {} : { description: tool.description }) });
    }
    for (const extra of this.options.additionalTools ?? []) {
      const tool = this.manifestCache.get(`${extra.id}@${extra.version}`)!;
      if (!resolved.some(candidate => candidate.id === tool.id && candidate.version === tool.version)) {
        resolved.push({ id: tool.id, version: tool.version, capabilities: tool.capabilities, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, ...(tool.description === undefined ? {} : { description: tool.description }) });
      }
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
      const body = z.record(z.string(), z.unknown()).parse(await response.json());
      const providerReceipt = body.receipt && typeof body.receipt === 'object' && !Array.isArray(body.receipt)
        ? (body.receipt as Record<string, unknown>).id
        : undefined;
      // toolkit_new's published REST route returns { output, receipt } on a
      // successful call, while the older gateway contract returned
      // { ok: true, output, receipt }. Accept both at this boundary. A
      // non-2xx response with a provider receipt is a completed tool failure;
      // an auth/transport response without a receipt remains unknown.
      const legacyOk = typeof body.ok === 'boolean' ? body.ok : undefined;
      const completed = legacyOk === undefined ? response.ok && body.error === undefined : legacyOk;
      if (!response.ok && providerReceipt === undefined) throw new Error('Toolkit execution returned HTTP ' + response.status);
      const status: ToolResult['status'] = completed ? 'completed' : 'failed';
      const providerReceiptId = providerReceipt === undefined ? undefined : String(providerReceipt);
      const result = completed ? (body.output ?? body.structuredContent ?? null) : { error: typeof body.error === 'string' ? body.error : 'Toolkit execution failed' };
      const receipt = makeToolkitReceipt({ request, requestHash, started, status, response: body, ...(providerReceiptId ? { providerReceipt: providerReceiptId } : {}) });
      return { status, output: result, ...(providerReceiptId ? { outputRefs: [`toolkit-receipt:${providerReceiptId}`] } : {}), receipt };
    } catch (error) {
      return { status: 'unknown', receipt: makeToolkitReceipt({ request, requestHash, started, status: 'unknown', errorCode: error instanceof Error ? 'transport_or_protocol' : 'unknown' }) };
    }
  }

  private async reconcileThroughGateway(request: ToolInvocation, receipt: Receipt): Promise<ToolResult> {
    const reference = receipt.outputRefs.find(value => value.startsWith('toolkit-receipt:'));
    if (!reference) throw new Error('Toolkit receipt does not contain a provider receipt reference');
    if (!this.options.reconcileUrl) throw new Error('Toolkit Registry reconciliation endpoint is not configured; the Registry session-only receipt route is unsupported');
    const response = await fetch(this.options.reconcileUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(request.timeoutMs),
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ schemaVersion: 'tool-reconcile/1', request, receipt }),
    });
    if (!response.ok) throw new Error('Toolkit reconciliation returned HTTP ' + response.status);
    const parsed = z.object({ schemaVersion: z.literal('tool-result/1'), status: z.enum(['completed', 'failed', 'unknown']), output: z.unknown().optional(), outputRefs: z.array(z.string()).optional(), receipt: receiptSchema }).strict().parse(await response.json());
    return { status: parsed.status, receipt: parsed.receipt, ...(parsed.output === undefined ? {} : { output: parsed.output }), ...(parsed.outputRefs === undefined ? {} : { outputRefs: parsed.outputRefs }) };
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
  constructor(private readonly executable = 'ownhow', private readonly stateDirectory?: string, private readonly defaultRuntime?: string, private readonly healthTimeoutMs = 3_000) {
    if (defaultRuntime !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(defaultRuntime)) throw new Error('OwnHow runtime must be a simple runtime identifier');
    if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) throw new Error('OwnHow health timeout must be positive and finite');
  }
  private async run(args: string[], timeoutMs = 30_000): Promise<unknown> {
    const finalArgs = [...args, '--json', ...(this.stateDirectory ? ['--state', this.stateDirectory] : [])];
    try {
      const result = await execFile(this.executable, finalArgs, { timeout: timeoutMs, maxBuffer: 2_000_000, windowsHide: true, ...(args[0] === 'status' ? { killSignal: 'SIGKILL' as const } : {}) });
      return JSON.parse(result.stdout);
    } catch (error) {
      // OwnHow treats an empty proposal queue as an informational result and
      // exits non-zero. Keep that distinction at the adapter boundary so the
      // AEEIS proposal API can return an empty list instead of an error.
      if (args[0] === 'propose') {
        const processError = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
        const output = `${processError.stderr ?? ''}\n${processError.stdout ?? ''}`;
        if (/No matching receipt with a correction found/i.test(output)) return [];
      }
      const detail = error instanceof Error ? error.message.split('\\n')[0] : 'process failed';
      throw new Error('OwnHow command failed: ' + detail);
    }
  }
  async health() {
    try {
      const value = await this.run(['status'], this.healthTimeoutMs);
      z.object({
        components: z.number().int().nonnegative(), receipts: z.number().int().nonnegative(),
        methods: z.number().int().nonnegative(), pendingImports: z.number().int().nonnegative(),
      }).parse(value);
      return { ready: true, detail: 'OwnHow status protocol check passed', checkedAt: new Date().toISOString() };
    } catch {
      // CLI errors can include arguments, local paths and state contents.
      return { ready: false, detail: 'OwnHow status command failed, timed out or returned an invalid response', checkedAt: new Date().toISOString() };
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
  async record(input: { task: string; outcome: 'success' | 'failure'; correction?: string; summary: string; evidence: string[]; runtime?: string; confidence?: 'low' | 'medium' | 'high' | 'unknown'; verifiedBy?: 'user' | 'agent' | 'automated' | 'unknown' }) {
    const args = ['record', input.task, '--outcome', input.outcome, '--summary', input.summary];
    if (input.correction) args.push('--correction', input.correction);
    for (const evidence of input.evidence) args.push('--evidence', evidence);
    if (input.confidence) args.push('--confidence', input.confidence);
    if (input.verifiedBy) args.push('--verified-by', input.verifiedBy);
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
  private readonly cacheTtlMs: number;
  private readonly privateDataAllowed: Readonly<Record<string, boolean>>;
  private cachedRows?: { rows: Array<{ model: string; provider: string; endpoint: string; capabilities: string[]; inputPricePerMillion?: number; outputPricePerMillion?: number; priceCurrency?: string; contextTokens?: number; availability?: string; privateDataAllowed?: boolean }>; expiresAt: number; retrievedAt: string };
  private loading: Promise<typeof this.cachedRows> | undefined;
  lastRetrievedAt?: string;
  private readonly healthUrl?: string;
  private readonly protocol: 'compatibility' | 'v1';
  private readonly bearerToken: string | undefined;
  constructor(private readonly baseUrl: string, private readonly providerEndpoints: Readonly<Record<string, string>> = {}, options: { cacheTtlMs?: number; allowInsecureHttp?: boolean; privateDataAllowed?: Readonly<Record<string, boolean>>; healthUrl?: string; protocol?: 'compatibility' | 'v1'; bearerToken?: string } = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Planprice URL must not contain credentials, query or fragment');
    if (url.protocol !== 'https:' && !(options.allowInsecureHttp || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Planprice URL must use HTTPS except loopback development servers');
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.privateDataAllowed = options.privateDataAllowed ?? {};
    this.protocol = options.protocol ?? 'compatibility';
    this.bearerToken = options.bearerToken;
    if (this.protocol === 'v1' && !this.bearerToken) throw new Error('Planprice v1 requires a Bearer token');
    if (options.healthUrl !== undefined) {
      validateHealthEndpoint(baseUrl, options.healthUrl);
      this.healthUrl = new URL(options.healthUrl).href;
    }
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 0) throw new Error('Planprice catalog cache TTL must be a finite non-negative number');
  }
  async health(): Promise<DependencyHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.healthUrl) return { ready: true, detail: 'Planprice catalog configured; explicit health probe not configured', checkedAt };
    try {
      const response = await fetch(this.healthUrl, { method: 'GET', redirect: 'error', headers: this.headers(), signal: AbortSignal.timeout(3_000) });
      await response.body?.cancel();
      return { ready: response.ok, detail: response.ok ? 'Planprice catalog health probe passed' : `Planprice catalog health probe returned HTTP ${response.status}`, checkedAt };
    } catch {
      return { ready: false, detail: 'Planprice catalog health probe failed or timed out', checkedAt };
    }
  }
  async list(query: { capability?: string; minContextTokens?: number } = {}) {
    const cached = await this.loadRows();
    return cached.rows.filter(row => (!query.capability || row.capabilities.includes(query.capability.toLocaleLowerCase())) && (!query.minContextTokens || (row.contextTokens !== undefined && row.contextTokens >= query.minContextTokens)) && row.availability !== 'unavailable');
  }

  private async loadRows(): Promise<NonNullable<typeof this.cachedRows>> {
    const now = Date.now();
    if (this.cachedRows && this.cacheTtlMs !== 0 && this.cachedRows.expiresAt > now) return this.cachedRows;
    if (!this.loading) {
      this.loading = (async () => {
        const url = new URL(this.protocol === 'v1' ? '/v1/catalog/models' : '/api/products/grouped', this.baseUrl);
        if (this.protocol === 'compatibility') url.searchParams.set('type', 'llm');
        const response = await fetch(url, { redirect: 'error', headers: this.headers(), signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error('Planprice catalog returned HTTP ' + response.status);
        const rows = this.protocol === 'v1' ? this.parseV1(await response.json()) : z.array(z.object({ slug: z.string().min(1), context_window: z.number().nullable().optional(), versions: z.array(z.record(z.string(), z.unknown())).default([]) }).passthrough()).parse(await response.json());
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
      const privateDataAllowed = this.privateDataAllowed[model] ?? this.privateDataAllowed[provider];
      return { model, provider, endpoint, capabilities, ...(inputPrice === undefined ? {} : { inputPricePerMillion: inputPrice }), ...(outputPrice === undefined ? {} : { outputPricePerMillion: outputPrice, priceCurrency: 'USD' }), ...(typeof row.context_window === 'number' ? { contextTokens: row.context_window } : {}), availability: version.is_available === false ? 'unavailable' : 'available', ...(privateDataAllowed === undefined ? {} : { privateDataAllowed }) };
        }));
        const retrievedAt = new Date().toISOString();
        const value = { rows: candidates, expiresAt: this.cacheTtlMs === 0 ? now : Date.now() + this.cacheTtlMs, retrievedAt };
        this.cachedRows = value;
        this.lastRetrievedAt = retrievedAt;
        return value;
      })().finally(() => { this.loading = undefined; });
    }
    const loaded = await this.loading;
    if (!loaded) throw new Error('Planprice catalog did not return a result');
    return loaded;
  }

  private async exchangeRates(): Promise<Record<string, number>> {
    try {
      const response = await fetch(new URL(this.protocol === 'v1' ? '/v1/exchange-rates' : '/api/exchange-rates', this.baseUrl), { redirect: 'error', headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return {};
      if (this.protocol === 'v1') {
        const body = z.object({ quotes: z.array(z.object({ quote: z.string(), rate: z.string().regex(/^\d+(?:\.\d+)?$/), expiresAt: z.string().datetime({ offset: true }) })) }).parse(await response.json());
        const now = Date.now();
        return Object.fromEntries(body.quotes.filter(q => Date.parse(q.expiresAt) > now).map(q => [q.quote, Number(q.rate)]));
      }
      const body = z.object({ rates: z.record(z.string(), z.number().positive()).optional() }).passthrough().parse(await response.json());
      return Object.fromEntries(Object.entries(body.rates ?? {}).map(([currency, rate]) => [currency.toUpperCase(), rate]));
    } catch {
      return {};
    }
  }
  private headers(): Record<string, string> { return this.bearerToken ? { authorization: `Bearer ${this.bearerToken}`, accept: 'application/json' } : { accept: 'application/json' }; }
  private parseV1(value: unknown) {
    const body = z.object({ offerings: z.array(z.object({ offeringId: z.string().min(1), modelId: z.string().min(1), providerId: z.string().min(1), capabilities: z.array(z.string()), contextWindow: z.number().int().positive().nullable(), catalogStatus: z.enum(['available','degraded','unavailable','deprecated']), pricing: z.object({ currency: z.string().length(3), components: z.array(z.object({ kind: z.string(), pricePerMillion: z.string().nullable(), priceStatus: z.enum(['known','unknown']) })), normalization: z.object({ status: z.enum(['available','unavailable']), componentPrices: z.record(z.string(), z.string().nullable()) }).optional() }) })) }).parse(value);
    return body.offerings.map(o => ({ slug: o.modelId, context_window: o.contextWindow, versions: [{ model_slug: o.modelId, providers: { slug: o.providerId }, is_available: o.catalogStatus === 'available', currency: 'USD', input_price_per_1m: o.pricing.normalization?.componentPrices.input ? Number(o.pricing.normalization.componentPrices.input) : undefined, output_price_per_1m: o.pricing.normalization?.componentPrices.output ? Number(o.pricing.normalization.componentPrices.output) : undefined }] }));
  }
}
function normalizedUsd(value: unknown, currency: string | undefined, rates: Readonly<Record<string, number>>): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (!currency || currency === 'USD') return value;
  const rate = rates[currency];
  return rate && Number.isFinite(rate) && rate > 0 ? value / rate : undefined;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
