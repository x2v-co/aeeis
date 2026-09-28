import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DockerSandbox, SandboxError, sandboxConfigSchema } from './docker-sandbox.js';
import { readSnapshot, commitSnapshot } from './sandbox-workspace.js';
import { z } from 'zod';
import { digestProtocol } from './protocol.js';
import type { Receipt, ToolDescriptor, ToolGateway, ToolInvocation, ToolResult } from './integrations.js';

const names = ['read', 'write', 'diff', 'glob', 'grep', 'python', 'shell', 'process', 'web-fetch'] as const;
export const localToolsConfigSchema = z.object({
  schemaVersion: z.literal('local-tools/1'),
  workspaceRoot: z.string().min(1),
  stateDirectory: z.string().min(1),
  tools: z.array(z.enum(names)).min(1).refine(items => new Set(items).size === items.length, 'Duplicate tools'),
  defaultAllowedTools: z.array(z.enum(names)).default([]),
  sandbox: sandboxConfigSchema.prefault({}),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  webHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default([]),
}).strict().refine(config => config.defaultAllowedTools.every(name => config.tools.includes(name)), 'Default tools must be enabled');
export type LocalToolsConfig = z.infer<typeof localToolsConfigSchema>;
const pathInput = z.string().min(1).max(1000);
const hashInput = z.string().regex(/^[a-f0-9]{64}$/);
const schemas = {
  read: z.object({ path: pathInput, startLine: z.number().int().min(1).default(1), maxLines: z.number().int().min(1).max(500).default(200) }).strict(),
  write: z.object({ path: pathInput, content: z.string().max(1_000_000), expectedHash: hashInput.optional() }).strict(),
  diff: z.object({ path: pathInput, content: z.string().max(1_000_000) }).strict(),
  glob: z.object({ pattern: z.string().min(1).max(200).default('**/*'), limit: z.number().int().min(1).max(500).default(100) }).strict(),
  grep: z.object({ pattern: z.string().min(1).max(500), glob: z.string().min(1).max(200).default('**/*'), ignoreCase: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  python: z.object({ code: z.string().min(1).max(100_000) }).strict(),
  shell: z.object({ command: z.string().min(1).max(100_000) }).strict(),
  process: z.discriminatedUnion('action', [
    z.object({ action: z.literal('start'), command: z.string().min(1).max(100_000) }).strict(),
    z.object({ action: z.enum(['list', 'ports']) }).strict(),
    z.object({ action: z.enum(['logs', 'stop']), processId: z.string().regex(/^proc_[a-f0-9]{32}$/) }).strict(),
  ]),
  'web-fetch': z.object({ input: z.string().url().max(8000) }).strict(),
};
const descriptions: Record<typeof names[number], string> = {
  read: 'Read UTF-8 text in this Run workspace with line numbers and SHA-256. Paths are relative; use glob to discover files.',
  write: 'Create a UTF-8 file in this Run workspace. To replace an existing file, first read it and supply its expectedHash. Parent directories are created.',
  diff: 'Preview a unified diff between an existing workspace file (or empty new file) and proposed content. Does not modify files.',
  glob: 'Find files in this Run workspace by glob pattern, e.g. **/*.csv. Returns relative paths. Does not follow symlinks.',
  grep: 'Search literal text (not regex) in workspace files with optional glob and case-insensitivity. Returns paths, line numbers and bounded excerpts.',
  python: 'Run Python 3.12 in this Run persistent Linux container. Installed packages and files persist between calls and AEEIS restarts. Network follows sandbox policy. Put final deliverable files under artifacts/ to export them to the host. No host files or credentials are mounted.',
  shell: 'Execute Bash in /workspace inside this Run persistent Linux container. Can use git, apt, pip, install dependencies and run system commands. Container root is available; no host mounts or Docker socket. Put deliverables in artifacts/. Use process start for persistent services. Foreground timeout stops ALL processes in this Run but preserves its files.',
  process: 'Manage background commands in this Run container: start, list, logs (last 24 KB per stream), stop, ports (host loopback mappings). Use returned processId. Services persist between tool calls and AEEIS restarts, until Run completion, idle expiry, timeout or explicit stop. Listen on 0.0.0.0 inside the container to use configured published ports.',
  'web-fetch': 'Fetch an allowlisted HTTPS URL and return bounded text evidence with source URL, fetch time and content hash. Redirects are rejected.',
};
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fingerprint = digestProtocol;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
class ToolError extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown' = 'failed', readonly output?: unknown) { super(message); }
}

/** Local, single-owner gateway. All file/code execution uses persistent Run containers. */
export class LocalToolGateway implements ToolGateway {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sandbox: DockerSandbox;
  private closing = false;
  private constructor(readonly config: LocalToolsConfig) { this.sandbox = new DockerSandbox(config.sandbox, config.stateDirectory); }
  async close() { this.closing = true; await this.sandbox.close(); await this.queue; }
  private async saveArtifacts(runId: string, files: import('./sandbox-workspace.js').WorkspaceFile[]) {
    const workspace = join(this.config.workspaceRoot, runId);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await commitSnapshot(join(workspace, 'artifacts'), files, this.config.sandbox.snapshotMiB * 1024 * 1024);
  }
  release(runId: string): Promise<void> {
    const result = this.queue.then(() => this.sandbox.release(runId, files => this.saveArtifacts(runId, files)));
    this.queue = result.catch(() => undefined); return result;
  }
  async reap(status: (runId: string) => Promise<string>) {
    for (const run of await this.sandbox.pendingRuns()) {
      if (run.expired || ['succeeded', 'failed', 'cancelled'].includes(await status(run.runId))) await this.release(run.runId);
    }
  }
  static async load(filename: string): Promise<LocalToolGateway> {
    const config = localToolsConfigSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    config.workspaceRoot = resolve(dirname(filename), config.workspaceRoot);
    config.stateDirectory = resolve(dirname(filename), config.stateDirectory);
    const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
    if (inside(config.workspaceRoot, config.stateDirectory) || inside(config.stateDirectory, config.workspaceRoot)) throw new Error('Local tool state and workspaces must use separate directories');
    await mkdir(config.workspaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
    config.workspaceRoot = await realpath(config.workspaceRoot);
    config.stateDirectory = await realpath(config.stateDirectory);
    if (inside(config.workspaceRoot, config.stateDirectory) || inside(config.stateDirectory, config.workspaceRoot)) throw new Error('Local tool state and workspaces must use separate directories');
    return new LocalToolGateway(config);
  }
  async listTools(): Promise<ToolDescriptor[]> {
    const image = this.config.tools.some(id => id !== 'web-fetch') ? await this.sandbox.imageId() : null;
    return this.config.tools.map(id => ({ id, version: id === 'web-fetch' ? '1' : '3', description: `${descriptions[id]}${id === 'web-fetch' ? ` Allowed hosts: ${this.config.webHosts.join(', ') || '(none)'}.` : ''}`, capabilities: ['python', 'shell', 'process'].includes(id) ? ['execute', 'read', 'write', ...(this.config.sandbox.network === 'none' ? [] : ['network'])] : id === 'write' ? ['write'] : id === 'web-fetch' ? ['read', 'network'] : ['read'], inputSchema: { ...z.toJSONSchema(schemas[id], { io: 'input' }), $comment: `Local policy ${fingerprint({ config: this.config, image })}` }, outputSchema: { type: 'object' } }));
  }
  async health() {
    if (this.config.tools.some(id => id !== 'web-fetch')) return this.sandbox.health();
    return { ready: !this.closing, detail: 'Allowlisted HTTPS tools ready', checkedAt: new Date().toISOString() };
  }

  invoke(request: ToolInvocation): Promise<ToolResult> {
    const result = this.queue.then(() => this.execute(request));
    this.queue = result.catch(() => undefined);
    return result;
  }
  async reconcile(request: ToolInvocation, _receipt: Receipt): Promise<ToolResult> {
    const record = await this.readRecord(request);
    return record?.result ?? this.result(request, 'unknown', { error: 'No completed local receipt. Inspect the workspace before deciding to retry.' });
  }
  private recordPath(request: ToolInvocation) { return join(this.config.stateDirectory, `${sha(request.idempotencyKey)}.json`); }
  private requestHash(request: ToolInvocation) {
    // Runtime bookkeeping fields must not change the provider idempotency identity.
    return fingerprint({ toolId: request.toolId, toolVersion: request.toolVersion, taskId: request.taskId, input: request.input, purpose: request.purpose, capabilityGrant: request.capabilityGrant, idempotencyKey: request.idempotencyKey });
  }
  private async readRecord(request: ToolInvocation): Promise<{ requestHash: string; result?: ToolResult } | undefined> {
    let record;
    try { record = JSON.parse(await readFile(this.recordPath(request), 'utf8')) as { requestHash: string; result?: ToolResult }; }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    if (record.requestHash !== this.requestHash(request)) throw new ToolError('Idempotency key conflicts with an earlier invocation');
    return record;
  }
  private result(request: ToolInvocation, status: ToolResult['status'], output: unknown, startedAt = new Date().toISOString()): ToolResult {
    const receiptId = `receipt_${randomUUID()}`;
    return { status, output, outputRefs: status === 'completed' ? [receiptId] : [], receipt: {
      schemaVersion: 'receipt/1', receiptId, provider: 'aeeis-local-tools', operation: request.toolId,
      requestHash: this.requestHash(request), responseHash: fingerprint(output), inputRefs: [request.taskId], outputRefs: status === 'completed' ? [receiptId] : [],
      capabilitiesUsed: this.config.tools.includes(request.toolId as typeof names[number]) ? ['python', 'shell', 'process'].includes(request.toolId) ? ['execute', 'read', 'write', ...(this.config.sandbox.network === 'none' ? [] : ['network'])] : request.toolId === 'write' ? ['write'] : request.toolId === 'web-fetch' ? ['read', 'network'] : ['read'] : [],
      startedAt, completedAt: new Date().toISOString(), status,
      cost: { tokens: 0, money: 0, currency: 'USD' },
      ...(status === 'completed' ? {} : { errorCode: status === 'unknown' ? 'execution_unknown' : 'tool_failed' }),
    } };
  }
  private async execute(request: ToolInvocation): Promise<ToolResult> {
    const startedAt = new Date().toISOString();
    let journalStarted = false;
    try {
      if (this.closing) throw new ToolError('Local tool service is closing');
      if (request.toolVersion !== (request.toolId === 'web-fetch' ? '1' : '3') || !this.config.tools.includes(request.toolId as typeof names[number])) throw new ToolError('Tool/version is not enabled');
      const grant = /^run:(run_[a-f0-9-]{36}):([a-z-]+)$/.exec(request.capabilityGrant);
      if (!grant || grant[2] !== request.toolId || !request.idempotencyKey.startsWith(grant[1] + ':')) throw new ToolError('Invalid Run capability grant');
      const previous = await this.readRecord(request);
      if (previous) return previous.result ?? this.result(request, 'unknown', { error: 'A previous invocation was interrupted; reconcile before retrying.' }, startedAt);
      const id = request.toolId as typeof names[number];
      const input = schemas[id].parse(request.input);
      const workspace = join(this.config.workspaceRoot, grant[1]!);
      // Validate host state before recording a possibly side-effecting invocation.
      const files = id === 'web-fetch' ? [] : await readSnapshot(workspace, this.config.sandbox.snapshotMiB * 1024 * 1024);
      await this.durableWrite(this.recordPath(request), JSON.stringify({ requestHash: this.requestHash(request) }));
      journalStarted = true;
      const timeout = Math.max(100, Math.min(request.timeoutMs, this.config.timeoutMs));
      const response = id === 'web-fetch'
        ? { status: 'completed' as const, output: await this.webFetch(input, timeout), files: null }
        : await this.sandbox.execute(grant[1]!, id, input, files, timeout);
      if (response.files !== null) await this.saveArtifacts(grant[1]!, response.files);
      const result = this.result(request, response.status, response.output, startedAt);
      await this.saveResult(request, result);
      return result;
    } catch (error) {
      const result = this.result(request, error instanceof ToolError || error instanceof SandboxError ? error.outcome : journalStarted ? 'unknown' : 'failed', {
        error: error instanceof z.ZodError ? 'Invalid tool arguments: ' + error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : error instanceof Error ? error.message : 'Local tool failed',
        ...(error instanceof ToolError && error.output ? { details: error.output } : {}),
      }, startedAt);
      if (journalStarted) await this.saveResult(request, result);
      return result;
    }
  }
  private async saveResult(request: ToolInvocation, result: ToolResult) {
    const target = this.recordPath(request), temporary = `${target}.${randomUUID()}.tmp`;
    await this.durableWrite(temporary, JSON.stringify({ requestHash: this.requestHash(request), result }));
    await rename(temporary, target);
  }
  private async durableWrite(path: string, content: string) {
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  }
  private async webFetch(value: unknown, timeoutMs: number): Promise<unknown> {
    const input = schemas['web-fetch'].parse(value), url = new URL(input.input);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !this.config.webHosts.includes(url.hostname)) throw new ToolError('URL is outside the configured HTTPS host allowlist');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new ToolError(`HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw new ToolError('Empty HTTP response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 1_000_000) throw new ToolError('Web response exceeds 1 MB'); chunks.push(item.value); } }
    finally { await reader.cancel().catch(() => undefined); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const text = (response.headers.get('content-type') ?? '').includes('html') ? raw.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') : raw;
    if (/人机识别|验证码|captcha|challenge/i.test(text)) throw new ToolError('Page requires human verification');
    return { url: url.href, fetchedAt: new Date().toISOString(), sha256: sha(raw), content: text.slice(0, 24_000), truncated: text.length > 24_000 };
  }

}

/** Keeps remote tools available alongside local tools, rejecting ambiguous IDs. */
export class CombinedToolGateway implements ToolGateway {
  constructor(private readonly gateways: ToolGateway[]) {}
  async listTools(): Promise<ToolDescriptor[]> {
    const tools = (await Promise.all(this.gateways.map(gateway => gateway.listTools()))).flat();
    if (new Set(tools.map(tool => tool.id)).size !== tools.length) throw new Error('Duplicate tool IDs across local and remote gateways');
    return tools;
  }
  private async gateway(request: ToolInvocation) {
    await this.listTools();
    for (const gateway of this.gateways) if ((await gateway.listTools()).some(tool => tool.id === request.toolId && tool.version === request.toolVersion)) return gateway;
    throw new Error('Tool is not configured');
  }
  async invoke(request: ToolInvocation) { return (await this.gateway(request)).invoke(request); }
  async reconcile(request: ToolInvocation, receipt: Receipt) {
    const gateway = await this.gateway(request);
    if (!gateway.reconcile) throw new Error('Provider does not support reconciliation');
    return gateway.reconcile(request, receipt);
  }
  async health() { try { const tools = await this.listTools(); const health = await Promise.all(this.gateways.map(gateway => gateway.health?.())); return { ready: health.every(item => item?.ready !== false), detail: `${tools.length} configured tools; ${health.map(item => item?.detail ?? '').join('; ')}` }; } catch (error) { return { ready: false, detail: error instanceof Error ? error.message : 'Tool discovery failed' }; } }
}
