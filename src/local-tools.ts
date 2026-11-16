import { createHash, randomUUID } from 'node:crypto';
import { savedSiteFile } from './saved-site.js';
import { lstat, mkdir, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { DEFAULT_HOST, DockerSandbox, SandboxError, sandboxConfigSchema, type HostWait, type MachineView, type RunMachineRecord, type SandboxConfig } from './docker-sandbox.js';
import { readSnapshot, commitSnapshot } from './sandbox-workspace.js';
import { ClaudeCodeTransport, executorConfigSchema } from './executor.js';
import { EXPORT_LIMITS, EXPORT_SKIP, REPO_PUSH_TOOL, REPO_PUSH_VERSION, RepoConnector, reposConfigSchema } from './repo-connector.js';
import { z } from 'zod';
import { digestProtocol } from './protocol.js';
import type { MachineInterrupt, MachineInterruptResult, Receipt, ToolCallContext, ToolDescriptor, ToolGateway, ToolInvocation, ToolResult } from './integrations.js';

const hostId = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'Use a short lowercase host name such as instabox or vps-sg');
/** What may differ between sandbox hosts: how to reach the machine, how it shares previews, and its size. What a Run
 * may do (network, egress, image, relay, workspaces, lifetimes) stays the deployment's, the same on every host. */
const hostOverrideSchema = z.object({
  ssh: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/),
  sshLoginCommand: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
  sshWaitSeconds: z.number().int().min(0).max(3600).optional(),
  previewPorts: z.array(z.number().int().min(1024).max(65535)).max(5).optional(),
  previewCommand: z.object({ publish: z.array(z.string().min(1).max(500)).min(1).max(20), unpublish: z.array(z.string().min(1).max(500)).min(1).max(20) }).strict().optional(),
  memoryMiB: z.number().int().min(128).max(16384).optional(),
  cpus: z.number().min(0.25).max(16).optional(),
  pids: z.number().int().min(16).max(4096).optional(),
}).strict();
/** Which host each user's machines run on. A key is "<tenant>/<principal>", or "<principal>" for any tenant. */
const assignSchema = z.object({
  default: hostId,
  principals: z.record(z.string().regex(/^[^\s/]{1,200}(?:\/[^\s/]{1,200})?$/), hostId).default({}),
  /** The host whose machines were made before hosts had names. Defaults to `default`. */
  existing: hostId.optional(),
}).strict();
const names = ['read', 'write', 'diff', 'glob', 'grep', 'python', 'shell', 'process', 'browser', 'web-fetch'] as const;
/** Tools that run code in the Run container: what they can reach is whatever the container's network allows. */
const runsCode = (id: string) => ['python', 'shell', 'process', 'browser'].includes(id);
export const localToolsConfigSchema = z.object({
  schemaVersion: z.literal('local-tools/1'),
  workspaceRoot: z.string().min(1),
  stateDirectory: z.string().min(1),
  tools: z.array(z.enum(names)).min(1).refine(items => new Set(items).size === items.length, 'Duplicate tools'),
  defaultAllowedTools: z.array(z.enum(names)).default([]),
  sandbox: sandboxConfigSchema.prefault({}),
  timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  webHosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default([]),
  /** A coding executor as an AEEIS Agent, running in each Run's container. Needs sandbox.modelRelay. */
  executor: executorConfigSchema.optional(),
  /** Named sandbox hosts, each `sandbox` with that host's own access and size. Without it, `sandbox` is the one host. */
  hosts: z.record(hostId, hostOverrideSchema).optional(),
  assign: assignSchema.optional(),
  /** Limits per user, across every host. Required before several users may share the tools (config-validation.ts). */
  perPrincipal: z.object({ maxMachines: z.number().int().min(1).max(50) }).strict().optional(),
  /** GitHub repositories Bots may publish to through `repo-push`. AEEIS holds each token; Run machines never see it. */
  repos: reposConfigSchema.optional(),
}).strict().refine(config => config.defaultAllowedTools.every(name => config.tools.includes(name)), 'Default tools must be enabled')
  .refine(config => !config.executor || config.sandbox.modelRelay, 'The executor needs sandbox.modelRelay')
  .refine(config => !config.hosts === !config.assign, 'hosts and assign go together')
  .refine(config => !config.hosts || !config.assign || [config.assign.default, config.assign.existing ?? config.assign.default, ...Object.values(config.assign.principals)].every(host => host in config.hosts!), 'assign names a host that is not in hosts');
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
    z.object({ action: z.literal('preview'), port: z.number().int().min(1024).max(65535) }).strict(),
  ]),
  browser: z.object({
    url: z.string().url().max(2000).refine(value => /^https?:\/\//.test(value), 'Use an http:// or https:// URL'),
    steps: z.array(z.discriminatedUnion('action', [
      z.object({ action: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
      z.object({ action: z.literal('type'), selector: z.string().min(1).max(500), text: z.string().max(10_000) }).strict(),
      z.object({ action: z.literal('press'), key: z.string().min(1).max(50) }).strict(),
      z.object({ action: z.literal('wait'), selector: z.string().min(1).max(500).optional(), ms: z.number().int().min(0).max(10_000).optional() }).strict(),
    ])).max(30).default([]),
    screenshot: z.boolean().default(true),
    fullPage: z.boolean().default(false),
    width: z.number().int().min(320).max(2560).default(1280),
    height: z.number().int().min(320).max(2560).default(800),
  }).strict(),
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
  process: 'Manage background commands in this Run container: start, list, logs (last 24 KB per stream), stop, ports (host loopback mappings). Use returned processId. Services persist between tool calls and AEEIS restarts, until Run completion, idle expiry, timeout or explicit stop. Listen on 0.0.0.0 inside the container to use configured published ports. preview returns a private link to a running dev server, for the configured preview ports; share it with the people reviewing the work.',
  browser: 'Open a page in headless Chromium inside this Run container, optionally click, type, press keys or wait, then return the title, HTTP status, visible text, console errors and failed requests. A screenshot is saved under artifacts/screenshots/ and its path and SHA-256 are returned. Use http://127.0.0.1:<port> for a dev server started with process start. Each call opens a fresh page.',
  'web-fetch': 'Fetch an allowlisted HTTPS URL and return bounded text evidence with source URL, fetch time and content hash. Redirects are rejected.',
};
const screenshotName = /^\d{8}T\d{6}-[a-f0-9]{6}\.png$/;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fingerprint = digestProtocol;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
class ToolError extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown' = 'failed', readonly output?: unknown) { super(message); }
}

/** The user a Run belongs to. */
export interface RunPrincipal { owner: string; tenantId?: string | undefined }
/** Each named host's sandbox settings: the deployment's `sandbox`, with the host's own access and size on top. */
export function hostConfigs(config: LocalToolsConfig): Map<string, SandboxConfig> {
  if (!config.hosts) return new Map([[DEFAULT_HOST, config.sandbox]]);
  return new Map(Object.entries(config.hosts).map(([id, host]) => {
    const merged = { ...config.sandbox, ...host };
    // A host that publishes no previews shares none, whatever the deployment lists.
    if (!host.previewCommand) { delete (merged as Partial<SandboxConfig>).previewCommand; merged.previewPorts = host.previewPorts ?? []; }
    const parsed = sandboxConfigSchema.safeParse(merged);
    if (!parsed.success) throw new Error(`Sandbox host ${id}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
    return [id, parsed.data];
  }));
}

/** Local tools gateway. All file/code execution uses persistent Run containers on a sandbox host. With several users,
 * each user's machines run on the host `assign` gives them, are labelled as theirs, count against their own limit,
 * and wait only behind their own calls on that host. */
const REPO_PUSH_CAPABILITIES = ['write', 'network'];
export class LocalToolGateway implements ToolGateway {
  /** One queue per user per host: one person's long call or waiting host never holds up another's tools. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly sandboxes: Map<string, DockerSandbox>;
  private readonly defaultHost: string;
  private readonly runHosts = new Map<string, string>();
  private readonly formerNames: readonly string[];
  private closing = false;
  /** Who each Run belongs to; the server sets it. Without it every Run is the single owner's. */
  principalOf: ((runId: string) => Promise<RunPrincipal | undefined>) | undefined;
  /** Publishes workspace folders to the configured repos. Its effect is outside the Run, so it is never contained. */
  repoConnector: RepoConnector | undefined;
  private constructor(readonly config: LocalToolsConfig) {
    this.repoConnector = config.repos ? new RepoConnector(config.repos) : undefined;
    const existing = config.assign?.existing ?? config.assign?.default ?? DEFAULT_HOST;
    this.defaultHost = config.assign?.default ?? DEFAULT_HOST;
    const hosts = hostConfigs(config);
    // Machines made while the configuration had no hosts are recorded on "default"; once hosts are named, unless one
    // of them is called that, they are the existing host's.
    this.formerNames = config.hosts && !hosts.has(DEFAULT_HOST) ? [DEFAULT_HOST] : [];
    this.sandboxes = new Map([...hosts].map(([id, sandbox]) => [id, new DockerSandbox(sandbox, config.stateDirectory, {
      host: id, unlabeled: id === existing, formerNames: this.formerNames, ...(config.perPrincipal ? { maxRunsPerPrincipal: config.perPrincipal.maxMachines } : {}),
    })]));
  }
  /** The default host's sandbox, for what is the same on every host. */
  private get sandbox(): DockerSandbox { return this.sandboxes.get(this.defaultHost)!; }
  /** Host names and their sandboxes, for checks and operator scripts. */
  hosts(): [string, DockerSandbox][] { return [...this.sandboxes]; }
  async close() {
    this.closing = true;
    await Promise.all([...this.sandboxes.values()].map(sandbox => sandbox.close()));
    await Promise.all([...this.queues.values()]);
  }
  /** A hash of the Run's user, stored and labelled instead of the user's identity. Without `principalOf` the
   * deployment has one owner. With it, a Run whose user cannot be read right now gets no machine at all: running it
   * as someone else would put one user's code on another's host, queue and limit. */
  private async principalKey(runId: string): Promise<{ key: string; hash: string; owner: string; tenant: string }> {
    let principal: RunPrincipal | undefined;
    if (this.principalOf) {
      try { principal = await this.principalOf(runId); } catch { principal = undefined; }
      if (!principal?.owner) throw new ToolError('Could not tell whose task this is right now, so nothing ran; try again shortly');
    }
    const owner = principal?.owner ?? 'owner', tenant = principal?.tenantId ?? 'local';
    const key = `${tenant}/${owner}`;
    return { key, hash: sha(key).slice(0, 16), owner, tenant };
  }
  /** The host a Run's machine is on: where its record says, else where its user is assigned. Fixed once chosen. */
  async hostFor(runId: string): Promise<string> {
    const known = this.runHosts.get(runId);
    if (known) return known;
    let host: string | undefined;
    if (/^run_[a-f0-9-]{36}$/.test(runId)) {
      try {
        const record = JSON.parse(await readFile(join(this.config.stateDirectory, 'sandboxes', `${runId}.json`), 'utf8')) as { host?: unknown };
        const named = typeof record.host === 'string' ? record.host : undefined;
        // The same rule each host uses to claim a record: no name, or a former name, means the existing host.
        if (!named || this.formerNames.includes(named)) host = this.config.assign?.existing ?? this.defaultHost;
        else if (this.sandboxes.has(named)) host = named;
        else throw new ToolError(`This task's machine is on sandbox host "${named}", which is no longer configured`);
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    if (!host) {
      const { owner, tenant } = await this.principalKey(runId);
      const principals = this.config.assign?.principals ?? {};
      host = principals[`${tenant}/${owner}`] ?? principals[owner] ?? this.defaultHost;
    }
    this.runHosts.set(runId, host);
    return host;
  }
  private async sandboxFor(runId: string): Promise<DockerSandbox> { return this.sandboxes.get(await this.hostFor(runId))!; }
  /** Runs `work` after the calls already queued for this Run's user on this Run's host. */
  private async enqueue<T>(runId: string, work: (sandbox: DockerSandbox, principal: string) => Promise<T>): Promise<T> {
    return this.enqueueOn(await this.hostFor(runId), (await this.principalKey(runId)).hash, work);
  }
  private enqueueOn<T>(host: string, hash: string, work: (sandbox: DockerSandbox, principal: string) => Promise<T>): Promise<T> {
    const lane = `${host}:${hash}`;
    const result = (this.queues.get(lane) ?? Promise.resolve()).then(() => work(this.sandboxes.get(host)!, hash));
    const settled = result.catch(() => undefined);
    this.queues.set(lane, settled);
    void settled.then(() => { if (this.queues.get(lane) === settled) this.queues.delete(lane); });
    return result;
  }
  private async saveArtifacts(runId: string, files: import('./sandbox-workspace.js').WorkspaceFile[]) {
    const workspace = join(this.config.workspaceRoot, runId);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await commitSnapshot(join(workspace, 'artifacts'), files, this.config.sandbox.snapshotMiB * 1024 * 1024);
  }
  release(runId: string): Promise<void> {
    return this.enqueue(runId, sandbox => sandbox.release(runId, files => this.saveArtifacts(runId, files)));
  }
  /** When each kept machine was last woken; a machine's own idle timer would otherwise end it before its keep does. */
  private readonly touched = new Map<string, number>();
  async reap(status: (runId: string) => Promise<string>) {
    for (const [host, sandbox] of this.sandboxes) for (const run of await sandbox.pendingRuns()) {
      this.runHosts.set(run.runId, host);
      if (run.keepUntil && run.keepUntil > Date.now() && !run.expired) {
        const last = this.touched.get(run.runId) ?? 0;
        if (Date.now() - last >= Math.min(600, sandbox.config.idleSeconds / 3) * 1000) {
          this.touched.set(run.runId, Date.now());
          await sandbox.touch(run.runId).catch(() => false);
        }
        continue;
      }
      this.touched.delete(run.runId);
      if (run.expired || ['succeeded', 'failed', 'cancelled'].includes(await status(run.runId))) await this.release(run.runId);
    }
  }
  async describe(runId: string): Promise<RunMachineRecord | undefined> { return (await this.sandboxFor(runId)).describe(runId); }
  /** Reaches the container directly: the queue may be held by the very call this has to stop. */
  async interruptRun(runId: string, action: MachineInterrupt): Promise<MachineInterruptResult> { return (await this.sandboxFor(runId)).interrupt(runId, action); }
  async observe(runId: string, live: boolean): Promise<MachineView> { return (await this.sandboxFor(runId)).observe(runId, live); }
  /** Whether the host this Run's machine is on is being waited for. Another host's wait is not this Run's business. */
  async hostWait(runId?: string): Promise<HostWait | undefined> { return (runId ? await this.sandboxFor(runId) : this.sandbox).hostWait(); }
  /** The executor, when configured. It uses the sandbox directly: a session lasts far longer than the tool queue should wait. */
  executorTransport(): ClaudeCodeTransport | undefined {
    if (!this.config.executor) return undefined;
    const snapshotBytes = this.config.sandbox.snapshotMiB * 1024 * 1024, root = this.config.workspaceRoot;
    const on = (runId: string) => this.sandboxFor(runId);
    return new ClaudeCodeTransport({
      startExecutor: async (runId, session, workspace) => {
        const { hash } = await this.principalKey(runId);
        return (await on(runId)).startExecutor(runId, session, await readSnapshot(join(root, runId), snapshotBytes), workspace, hash);
      },
      executorRecord: async runId => (await on(runId)).executorRecord(runId), pollExecutor: async (runId, session, offset) => (await on(runId)).pollExecutor(runId, session, offset),
      relayUsage: async (runId, token) => (await on(runId)).relayUsage(runId, token), closeRelay: async (runId, token) => (await on(runId)).closeRelay(runId, token),
      stopExecutor: async (runId, pid) => (await on(runId)).stopExecutor(runId, pid), observe: async (runId, live) => (await on(runId)).observe(runId, live),
      exportArtifacts: async runId => { await this.saveArtifacts(runId, await (await on(runId)).snapshotArtifacts(runId)); },
      screenshots: runId => this.screenshots(runId),
      runShell: async (runId, command) => { const { hash } = await this.principalKey(runId); const response = await (await on(runId)).execute(runId, 'shell', { command }, [], 60_000, undefined, hash); return { ok: response.status === 'completed', output: response.output }; },
      preview: async (runId, port) => { const { hash } = await this.principalKey(runId); const response = await (await on(runId)).execute(runId, 'process', { action: 'preview', port }, [], 120_000, undefined, hash); return response.status === 'completed' ? (response.output as { url?: string }).url : undefined; },
      keepMachine: async (runId, hours) => (await on(runId)).keepMachine(runId, hours),
    }, this.config.executor, join(this.config.stateDirectory, 'executor-evidence'));
  }
  private screenshotDirectory(runId: string) {
    if (!/^run_[a-f0-9-]{36}$/.test(runId)) throw new ToolError('Invalid Run identity');
    return join(this.config.workspaceRoot, runId, 'artifacts', 'screenshots');
  }
  /** Screenshots already exported to this host, newest first. Reading them never touches the sandbox host. */
  async screenshots(runId: string): Promise<{ name: string; bytes: number; capturedAt: string }[]> {
    let names: string[];
    try { names = await readdir(this.screenshotDirectory(runId)); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const listed = [];
    for (const name of names.filter(item => screenshotName.test(item)).sort().reverse().slice(0, 24)) {
      const info = await lstat(join(this.screenshotDirectory(runId), name)).catch(() => undefined);
      if (info?.isFile()) listed.push({ name, bytes: info.size, capturedAt: info.mtime.toISOString() });
    }
    return listed;
  }
  async sourceArchive(runId: string): Promise<Buffer | undefined> {
    const path = join(this.screenshotDirectory(runId), '..', 'source.tar.gz');
    const info = await lstat(path).catch(() => undefined);
    return info?.isFile() ? readFile(path) : undefined;
  }
  /** What a finished Run left on this host. It outlives the machine, unlike the live preview. */
  async deliverables(runId: string): Promise<{ savedSite: boolean; sourceArchive: boolean }> {
    const artifacts = join(this.screenshotDirectory(runId), '..');
    const [site, source] = await Promise.all([lstat(join(artifacts, 'site', 'index.html')).catch(() => undefined), lstat(join(artifacts, 'source.tar.gz')).catch(() => undefined)]);
    return { savedSite: Boolean(site?.isFile()), sourceArchive: Boolean(source?.isFile()) };
  }
  savedSiteFile(runId: string, path: string) { return savedSiteFile(this.config.workspaceRoot, runId, path); }
  async screenshot(runId: string, name: string): Promise<Buffer | undefined> {
    if (!screenshotName.test(name)) return undefined;
    const path = join(this.screenshotDirectory(runId), name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > 8 * 1024 * 1024) return undefined;
    return readFile(path);
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
  /** The configured tools and versions, without reaching the sandbox host. */
  toolRefs(): { id: string; version: string }[] { return [...this.config.tools.map(id => ({ id, version: id === 'web-fetch' ? '1' : '3' })), ...(this.repoConnector ? [{ id: REPO_PUSH_TOOL, version: REPO_PUSH_VERSION }] : [])]; }
  async listTools(): Promise<ToolDescriptor[]> {
    const image = this.config.tools.some(id => id !== 'web-fetch') ? await this.sandbox.imageId() : null;
    const tools: ToolDescriptor[] = this.config.tools.map(id => ({ id, version: id === 'web-fetch' ? '1' : '3', description: `${descriptions[id]}${id === 'web-fetch' ? ` Allowed hosts: ${this.config.webHosts.join(', ') || '(none)'}.` : ''}${runsCode(id) ? this.networkNote() : ''}`, capabilities: this.capabilities(id), inputSchema: { ...z.toJSONSchema(schemas[id], { io: 'input' }), $comment: `Local policy ${fingerprint({ config: this.config, image })}` }, outputSchema: { type: 'object' } }));
    if (this.repoConnector) tools.push({ id: REPO_PUSH_TOOL, version: REPO_PUSH_VERSION, description: this.repoConnector.description(), capabilities: REPO_PUSH_CAPABILITIES, inputSchema: this.repoConnector.inputSchema(), outputSchema: { type: 'object' } });
    return tools;
  }
  /** What an outward call would do and which grant entry may pre-approve it. Only this gateway's own connector answers,
   * never tool metadata, so a remote toolkit cannot make its tool look pre-approved. */
  outwardAction(toolId: string, input: unknown): { scope: string; summary: string } | undefined {
    return toolId === REPO_PUSH_TOOL ? this.repoConnector?.describe(input) : undefined;
  }
  private capabilities(id: string): string[] {
    if (runsCode(id)) return ['execute', 'read', 'write', ...(this.config.sandbox.network === 'none' ? [] : ['network'])];
    return id === 'write' ? ['write'] : id === 'web-fetch' ? ['read', 'network'] : ['read'];
  }
  private networkNote(): string {
    const { network, egressHosts } = this.config.sandbox;
    if (network === 'none') return ' The container has no network.';
    if (network === 'proxied') return ` Outbound traffic goes through a proxy that allows only: ${egressHosts.join(', ') || '(none)'}; other hosts get HTTP 403.`;
    return '';
  }
  /** File tools only touch this Run's container workspace. Code-running tools are confined when the container has
   * no network, or when its only way out is the Run's proxy, which reaches just the operator's egressHosts and no
   * private address. On the open bridge network they can reach any host, so a Work Grant does not let them run unasked. */
  async workspaceContainedTools(): Promise<string[]> {
    const confined = this.config.sandbox.network !== 'bridge';
    return this.config.tools.filter(id => id !== 'web-fetch' && (!runsCode(id) || confined));
  }
  async health(options: { probe?: boolean } = {}) {
    if (!this.config.tools.some(id => id !== 'web-fetch')) return { ready: !this.closing, detail: 'Allowlisted HTTPS tools ready', checkedAt: new Date().toISOString() };
    if (!this.config.hosts) return this.sandbox.health(options);
    const checked = await Promise.all([...this.sandboxes].map(async ([host, sandbox]) => ({ host, ...await sandbox.health(options) })));
    return { ready: checked.every(item => item.ready), detail: checked.map(item => `${item.host}: ${item.detail}`).join(' | '), checkedAt: new Date().toISOString() };
  }

  async invoke(request: ToolInvocation, context?: ToolCallContext): Promise<ToolResult> {
    const workspace = this.config.sandbox.workspaceVolumes ? context?.workspace : undefined;
    const runId = /^run:(run_[a-f0-9-]{36}):/.exec(request.capabilityGrant)?.[1];
    if (request.toolId === REPO_PUSH_TOOL) return this.pushRepo(request, runId, workspace);
    // Without a valid Run there is no host or user to queue for; execute refuses it.
    if (!runId) return this.execute(request, this.sandbox, workspace);
    let host: string, hash: string;
    try {
      host = await this.hostFor(runId); hash = (await this.principalKey(runId)).hash;
    } catch (error) {
      // Only finding the host or the user is turned into a plain failure here: nothing was recorded or ran yet.
      return this.result(request, 'failed', { error: error instanceof Error ? error.message : 'Local tool failed' });
    }
    // A finished Run's release goes through the queue, so waiting for it must happen outside.
    if (workspace) await this.sandboxes.get(host)!.waitForWorkspace(workspace, runId, 60_000).catch(() => undefined);
    // Whatever goes wrong from here on, such as a receipt that cannot be saved after the tool ran, is execute's to
    // report or to throw, so the engine keeps treating it as possibly done.
    return this.enqueueOn(host, hash, (sandbox, principal) => this.execute(request, sandbox, workspace, principal));
  }
  /** Reading the files out goes through the Run's queue like any tool call; the push itself happens here in AEEIS,
   * journaled first so an interrupted push is checked on GitHub, never repeated blind. */
  private async pushRepo(request: ToolInvocation, runId: string | undefined, workspace: string | undefined): Promise<ToolResult> {
    const startedAt = new Date().toISOString();
    const connector = this.repoConnector;
    if (!connector || request.toolVersion !== REPO_PUSH_VERSION) return this.result(request, 'failed', { error: 'Tool/version is not enabled' }, startedAt);
    if (!runId || request.capabilityGrant !== `run:${runId}:${REPO_PUSH_TOOL}` || !request.idempotencyKey.startsWith(runId + ':')) return this.result(request, 'failed', { error: 'Invalid Run capability grant' }, startedAt);
    let previous;
    try { previous = await this.readRecord(request); }
    catch (error) { return this.result(request, 'failed', { error: error instanceof Error ? error.message : 'Local tool failed' }, startedAt); }
    if (previous) return previous.result && previous.result.status !== 'unknown' ? previous.result : this.reconcilePush(request);
    let host: string, hash: string;
    try { host = await this.hostFor(runId); hash = (await this.principalKey(runId)).hash; }
    catch (error) { return this.result(request, 'failed', { error: error instanceof Error ? error.message : 'Local tool failed' }, startedAt); }
    let journalStarted = false;
    try {
      const outcome = await connector.push(request.input, request.idempotencyKey, runId, async path => {
        const files = await this.enqueueOn(host, hash, (sandbox, principal) => sandbox.exportFiles(runId, path, { ...EXPORT_LIMITS, skip: EXPORT_SKIP }, workspace, principal));
        // Recorded only now: from here on the push may reach GitHub.
        await this.durableWrite(this.recordPath(request), JSON.stringify({ requestHash: this.requestHash(request) }));
        journalStarted = true;
        return files;
      });
      const result = this.result(request, outcome.status, outcome.output, startedAt);
      if (journalStarted) await this.saveResult(request, result);
      return result;
    } catch (error) {
      const result = this.result(request, journalStarted ? 'unknown' : 'failed', { error: error instanceof Error ? error.message : 'Local tool failed' }, startedAt);
      if (journalStarted) await this.saveResult(request, result).catch(() => undefined);
      return result;
    }
  }
  /** GitHub, not the journal, says whether an interrupted push landed. A settled answer is saved over the journal. */
  private async reconcilePush(request: ToolInvocation): Promise<ToolResult> {
    const record = await this.readRecord(request);
    if (record?.result && record.result.status !== 'unknown') return record.result;
    if (!this.repoConnector) return this.result(request, 'unknown', { error: 'repo-push is no longer configured, so AEEIS cannot check GitHub' });
    const outcome = await this.repoConnector.reconcile(request.input, request.idempotencyKey);
    const result = this.result(request, outcome.status, outcome.output);
    if (record && outcome.status !== 'unknown') await this.saveResult(request, result);
    return result;
  }
  async reconcile(request: ToolInvocation, _receipt: Receipt): Promise<ToolResult> {
    if (request.toolId === REPO_PUSH_TOOL) return this.reconcilePush(request);
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
      capabilitiesUsed: request.toolId === REPO_PUSH_TOOL ? REPO_PUSH_CAPABILITIES : this.config.tools.includes(request.toolId as typeof names[number]) ? this.capabilities(request.toolId) : [],
      startedAt, completedAt: new Date().toISOString(), status,
      cost: { tokens: 0, money: 0, currency: 'USD' },
      ...(status === 'completed' ? {} : { errorCode: status === 'unknown' ? 'execution_unknown' : 'tool_failed' }),
    } };
  }
  private async execute(request: ToolInvocation, sandbox: DockerSandbox, sharedWorkspace?: string, principal?: string): Promise<ToolResult> {
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
      if (id === 'browser') this.checkBrowserUrl((input as z.infer<typeof schemas.browser>).url);
      const workspace = join(this.config.workspaceRoot, grant[1]!);
      // Validate host state before recording a possibly side-effecting invocation.
      const files = id === 'web-fetch' ? [] : await readSnapshot(workspace, this.config.sandbox.snapshotMiB * 1024 * 1024);
      await this.durableWrite(this.recordPath(request), JSON.stringify({ requestHash: this.requestHash(request) }));
      journalStarted = true;
      const timeout = Math.max(100, Math.min(request.timeoutMs, this.config.timeoutMs));
      const response = id === 'web-fetch'
        ? { status: 'completed' as const, output: await this.webFetch(input, timeout), files: null }
        : await sandbox.execute(grant[1]!, id, input, files, timeout, sharedWorkspace, principal);
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
  /** The page itself is checked here for a clear error; the proxy (or no network) is what actually enforces it. */
  private checkBrowserUrl(value: string) {
    const url = new URL(value), { network, egressHosts } = this.config.sandbox;
    if (url.username || url.password) throw new ToolError('URLs with credentials are not allowed');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || network === 'bridge') return;
    const host = url.hostname.toLowerCase();
    const allowed = network === 'proxied' && egressHosts.some(rule => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule);
    if (!allowed) throw new ToolError(network === 'none' ? 'The container has no network; open a local port such as http://127.0.0.1:3000' : `${host} is not in the sandbox's allowed hosts`);
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
  /** One gateway may offer several versions of a tool; two gateways offering the same ID would make routing ambiguous. */
  async listTools(): Promise<ToolDescriptor[]> {
    const lists = await Promise.all(this.gateways.map(gateway => gateway.listTools()));
    const owner = new Map<string, number>();
    lists.forEach((tools, index) => { for (const tool of tools) {
      if ((owner.get(tool.id) ?? index) !== index) throw new Error(`Duplicate tool ID across local and remote gateways: ${tool.id}`);
      owner.set(tool.id, index);
    } });
    return lists.flat();
  }
  private async gateway(request: ToolInvocation) {
    await this.listTools();
    for (const gateway of this.gateways) if ((await gateway.listTools()).some(tool => tool.id === request.toolId && tool.version === request.toolVersion)) return gateway;
    throw new Error('Tool is not configured');
  }
  async invoke(request: ToolInvocation, context?: ToolCallContext) { return (await this.gateway(request)).invoke(request, context); }
  async workspaceContainedTools(): Promise<string[]> {
    return (await Promise.all(this.gateways.map(gateway => gateway.workspaceContainedTools?.() ?? Promise.resolve([])))).flat();
  }
  /** Tool IDs are unique across gateways (listTools refuses duplicates), so at most one gateway answers. */
  outwardAction(toolId: string, input: unknown): { scope: string; summary: string } | undefined {
    for (const gateway of this.gateways) { const found = gateway.outwardAction?.(toolId, input); if (found) return found; }
    return undefined;
  }
  async interruptRun(runId: string, action: MachineInterrupt): Promise<MachineInterruptResult> {
    const results = await Promise.all(this.gateways.map(gateway => gateway.interruptRun?.(runId, action) ?? Promise.resolve({ confirmed: true })));
    return results.find(result => !result.confirmed) ?? { confirmed: true };
  }
  async reconcile(request: ToolInvocation, receipt: Receipt) {
    const gateway = await this.gateway(request);
    if (!gateway.reconcile) throw new Error('Provider does not support reconciliation');
    return gateway.reconcile(request, receipt);
  }
  async health() {
    try {
      const health = await Promise.all(this.gateways.map(async gateway => gateway.health
        ? gateway.health()
        : { ready: true, detail: `${(await gateway.listTools()).length} configured tools` }));
      return { ready: health.every(item => item.ready), detail: health.map(item => item.detail).join('; ') };
    } catch (error) { return { ready: false, detail: error instanceof Error ? error.message : 'Tool discovery failed' }; }
  }
}
