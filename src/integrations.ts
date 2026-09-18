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
  list(query: { capability?: string; minContextTokens?: number }): Promise<Array<{ model: string; provider: string; endpoint: string; capabilities: string[]; inputPricePerMillion?: number; outputPricePerMillion?: number; contextTokens?: number; availability?: string; privateDataAllowed?: boolean }>>;
}
export interface ModelSelectionRequest { capability: string; privacy: 'public' | 'internal' | 'confidential' | 'private'; maxMoney?: number; minContextTokens?: number; }
export interface ModelDecision {
  schemaVersion: 'model-decision/1'; selected: { model: string; provider: string; endpoint: string };
  candidates: Array<{ model: string; provider: string; reason: string; accepted: boolean }>; reason: string; decidedAt: string;
}

export function selectModel(catalog: Array<{ model: string; provider: string; endpoint: string; capabilities: string[]; outputPricePerMillion?: number; contextTokens?: number; privateDataAllowed?: boolean; availability?: string }>, request: ModelSelectionRequest): ModelDecision {
  const candidates = catalog.filter(model =>
    model.capabilities.includes(request.capability)
    && Boolean(model.endpoint)
    && model.availability !== 'unavailable'
    && (!request.minContextTokens || (model.contextTokens !== undefined && model.contextTokens >= request.minContextTokens))
    && (request.privacy !== 'private' || model.privateDataAllowed === true)
    && (request.maxMoney === undefined || model.outputPricePerMillion === undefined || model.outputPricePerMillion <= request.maxMoney),
  );
  if (candidates.length === 0) throw new Error('No model satisfies the requested capability and policy');
  const selected = candidates.slice().sort((a, b) => (a.outputPricePerMillion ?? Number.MAX_SAFE_INTEGER) - (b.outputPricePerMillion ?? Number.MAX_SAFE_INTEGER))[0]!;
  return { schemaVersion: 'model-decision/1', selected: { model: selected.model, provider: selected.provider, endpoint: selected.endpoint }, candidates: candidates.map(item => ({ model: item.model, provider: item.provider, reason: item === selected ? 'lowest known output price within policy' : 'eligible fallback', accepted: item === selected })), reason: 'Selected ' + selected.model + ' for ' + request.capability + '; privacy=' + request.privacy, decidedAt: new Date().toISOString() };
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

export class OwnHowCliGovernance implements SkillGovernance {
  constructor(private readonly executable = 'ownhow', private readonly stateDirectory?: string) {}
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
    if (options.runtime) args.push('--runtime', options.runtime);
    if (options.cached) args.push('--cached');
    const value = await this.run(args) as { methodId?: string; methodVersion?: string; plan?: unknown; digest?: string };
    return { ...(value.methodId ? { methodId: value.methodId } : {}), ...(value.methodVersion ? { version: value.methodVersion } : {}), plan: value.plan ?? value, ...(value.digest ? { receiptRef: value.digest } : {}) };
  }
  async record(input: { task: string; outcome: 'success' | 'failure'; correction?: string; summary: string; evidence: string[]; runtime?: string }) {
    const args = ['record', input.task, '--outcome', input.outcome, '--summary', input.summary];
    if (input.correction) args.push('--correction', input.correction);
    for (const evidence of input.evidence) args.push('--evidence', evidence);
    if (input.runtime) args.push('--runtime', input.runtime);
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
    const url = new URL('/api/products', this.baseUrl);
    url.searchParams.set('type', 'llm');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('Planprice catalog returned HTTP ' + response.status);
    const rows = z.array(z.record(z.string(), z.unknown())).parse(await response.json());
    return rows.map(row => {
      const slug = z.string().parse(row.slug);
      const providerRecord = row.providers ?? row.provider;
      const provider = typeof providerRecord === 'object' && providerRecord && 'slug' in providerRecord ? String(providerRecord.slug) : typeof row.provider_slug === 'string' ? row.provider_slug : 'unknown-provider';
      const rawCapabilities = [
        ...(Array.isArray(row.capabilities) ? row.capabilities.map(String) : []),
        ...(Array.isArray(row.features) ? row.features.map(String) : []),
        ...(typeof row.model_category === 'string' ? [row.model_category] : []),
        ...(row.type === 'llm' ? ['agent'] : []),
      ];
      const capabilities = [...new Set(rawCapabilities.map(value => value.toLocaleLowerCase()))];
      const endpoint = this.providerEndpoints[provider] ?? this.providerEndpoints[provider.toLocaleLowerCase()] ?? '';
      return { model: slug, provider, endpoint, capabilities, ...(typeof row.input_price_per_1m === 'number' ? { inputPricePerMillion: row.input_price_per_1m } : {}), ...(typeof row.output_price_per_1m === 'number' ? { outputPricePerMillion: row.output_price_per_1m } : {}), ...(typeof row.context_window === 'number' ? { contextTokens: row.context_window } : {}), availability: row.is_active === false ? 'unavailable' : 'available' };
    }).filter(row => (!query.capability || row.capabilities.includes(query.capability.toLocaleLowerCase())) && (!query.minContextTokens || (row.contextTokens !== undefined && row.contextTokens >= query.minContextTokens)) && row.availability !== 'unavailable');
  }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
