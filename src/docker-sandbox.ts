import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digestProtocol } from './protocol.js';
import { snapshotSchema, validateSnapshot, type WorkspaceFile } from './sandbox-workspace.js';
import { PACK_DELIVERABLES } from './saved-site.js';

export const sandboxConfigSchema = z.object({
  runtime: z.literal('docker').default('docker'),
  context: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/).default('auto'),
  /** A Host alias from the operator's ~/.ssh/config. Docker then runs on that machine over SSH, e.g. a test VPS. */
  ssh: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/).optional(),
  /** Run (no shell) when the SSH host refuses the login, then try once more — e.g. hosts whose SSH certificates
   * expire hourly: ["npx", "-y", "instabox@latest", "ssh-cert", "my-machine"]. Nothing remote ran on a refused login. */
  sshLoginCommand: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
  /** How long a call waits for an unreachable SSH host before giving up. Only the preparation before the tool
   * runs is retried, so waiting never repeats work. The default covers one round of a 10-minute keep-alive. */
  sshWaitSeconds: z.number().int().min(0).max(3600).default(720),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/).default('aeeis-sandbox:3'),
  memoryMiB: z.number().int().min(128).max(16384).default(1024),
  cpus: z.number().min(0.25).max(16).default(2),
  pids: z.number().int().min(16).max(4096).default(256),
  /** bridge: open internet. none: no network. proxied: an internal network whose only way out is a per-Run proxy
   * that allows `egressHosts` over HTTPS (and HTTP on port 80) and refuses private addresses. */
  network: z.enum(['bridge', 'none', 'proxied']).default('bridge'),
  egressHosts: z.array(z.string().regex(/^(?:\*\.)?[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62})*\.[a-z][a-z0-9-]{0,62}$/, 'Use a host name such as registry.npmjs.org or *.example.com; IP addresses are not allowed')).max(100).default([]),
  snapshotMiB: z.number().int().min(1).max(32).default(16),
  idleSeconds: z.number().int().min(60).max(86400).default(3600),
  maxLifetimeSeconds: z.number().int().min(300).max(604800).default(86400),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([]),
  /** Give each Work Grant a persistent Docker volume at /workspace, used by one Run at a time. Runs without a grant
   * keep the normal per-Run filesystem. Volumes outlive Runs and grants; deleting one is an operator decision. */
  workspaceVolumes: z.boolean().default(false),
  /** Run the model relay in each Run's proxy container, so that an executor never holds a real API key. */
  modelRelay: z.boolean().default(false),
  /** Ports a dev server may share through a link. The Run's proxy forwards them inbound; its container stays internal. */
  previewPorts: z.array(z.number().int().min(1024).max(65535)).max(5).default([]),
  /** Run (no shell, on the AEEIS host) to share a port and to stop sharing it; `{port}` is the port on the sandbox
   * host. `publish` must print the link. Example: ["npx","-y","instabox@latest","port","publish","my-machine","{port}","--private"]. */
  previewCommand: z.object({ publish: z.array(z.string().min(1).max(500)).min(1).max(20), unpublish: z.array(z.string().min(1).max(500)).min(1).max(20) }).strict().optional(),
}).strict()
  .refine(config => new Set(config.ports).size === config.ports.length && (config.network === 'bridge' || config.ports.length === 0), 'Ports must be unique and need the bridge network')
  .refine(config => config.network === 'proxied' || config.egressHosts.length === 0, 'egressHosts need the proxied network')
  .refine(config => !config.ssh || config.context === 'auto', 'Use either ssh or a Docker context')
  .refine(config => !config.sshLoginCommand || config.ssh, 'sshLoginCommand needs ssh')
  .refine(config => !config.modelRelay || config.network === 'proxied', 'modelRelay needs the proxied network')
  .refine(config => new Set(config.previewPorts).size === config.previewPorts.length && (config.previewPorts.length === 0 || (config.network === 'proxied' && config.previewCommand)), 'previewPorts must be unique and need the proxied network and previewCommand');
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
const observationSchema = z.object({
  foreground: z.object({ command: z.string(), startedAt: z.string().nullable().optional(), finishedAt: z.string().nullable().optional(), output: z.string() }).nullable(),
  processes: z.array(z.object({ processId: z.string(), command: z.string(), running: z.boolean(), output: z.string() })).max(8),
  repository: z.object({ status: z.string(), diff: z.string(), truncated: z.boolean() }).nullable(),
  files: z.array(z.object({ path: z.string(), modifiedAt: z.string() })).max(30),
}).strict();
export type MachineObservation = z.infer<typeof observationSchema>;
/** What a look at the machine found. `live` is present only when the container was read just now. */
export interface MachineView {
  state: 'absent' | 'released' | 'running' | 'frozen' | 'stopped' | 'unreachable' | 'unknown';
  detail?: string;
  live?: MachineObservation;
  previews: { port: number; url: string }[];
}
export interface ExecutorPoll { state: 'running' | 'frozen' | 'stopped' | 'unreachable' | 'missing'; output: string; offset: number; more: boolean; exitCode: number | null; errors: string }
export interface RelayUsage { calls: number; input: number; output: number; cacheWrite: number; cacheRead: number; refused: number; tokens: number; budget: number }
export interface HostWait { since: string; message: string; availableAt?: string }
const responseSchema = z.object({
  schemaVersion: z.literal('sandbox-output/2'), status: z.enum(['completed', 'failed', 'unknown']), output: z.unknown(), files: snapshotSchema.nullable(),
}).strict();
const stateSchema = z.object({ runId: z.string(), name: z.string(), network: z.string(), image: z.string(), policy: z.string(), createdAt: z.number(), ready: z.boolean(), released: z.boolean().default(false), containerId: z.string().optional(), proxyId: z.string().optional(), volume: z.string().optional(), keepUntil: z.number().optional(), executor: z.object({ session: z.string(), token: z.string(), pid: z.number() }).optional(), previews: z.record(z.string(), z.object({ hostPort: z.string(), url: z.string() })).optional() });
type State = z.infer<typeof stateSchema>;
export class SandboxError extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown' = 'failed') { super(message); }
}
/** ssh itself failed (exit 255): the remote host is paused, stopped, unreachable or refused the login.
 * Whether anything ran depends on the step, so callers decide the outcome; preparing a container ran nothing. */
export class SandboxUnreachable extends SandboxError {
  /** ssh's own "Permission denied (publickey,…)": authentication failed, so no remote command started. */
  readonly loginRefused: boolean;
  /** ssh could not resolve the host name. With an alias that sshLoginCommand writes (a fresh deployment has none
   * yet) running the login command fixes it; otherwise it is a name-service outage and is waited on. */
  readonly unresolved: boolean;
  /** When the host says it will accept connections again, e.g. instabox's "cooling down until <time>". */
  readonly availableAt: number | undefined;
  constructor(host: string, stderr: string) {
    const refused = /Permission denied \(/.test(stderr);
    const cooling = /cooling down until (\S+)/.exec(stderr)?.[1];
    const availableAt = cooling ? Date.parse(cooling) : NaN;
    super(!Number.isNaN(availableAt) ? `Sandbox host ${host} is cooling down until ${cooling}` : refused || /certificate|publickey/i.test(stderr)
      ? `Sandbox host ${host} refused the SSH login; its certificate may have expired`
      : `Sandbox host ${host} is unreachable over SSH; it may be paused or stopped`);
    this.loginRefused = refused;
    this.unresolved = /Could not resolve hostname/i.test(stderr);
    this.availableAt = Number.isNaN(availableAt) ? undefined : availableAt;
  }
}
/** Life-thread record of one Run's machine. Looking this up does not create or start the container. */
export type RunMachineRecord = { state: 'present'; ready: boolean } | { state: 'released'; ready: false };
const PROXY_PORT = 3128;
/** The proxy's name on the Run's internal network. Container names are too long for one DNS label. */
const PROXY_ALIAS = 'aeeis-proxy';
/** The Run container's name on its internal network, where the proxy forwards preview traffic. */
const RUN_ALIAS = 'aeeis-run';
/** Each docker call over SSH opens a connection through the remote gateway first. */
const SSH_ALLOWANCE_MS = 20_000;
/** POSIX single-quote one argument for the remote shell that ssh hands the command to. */
export const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** How to run `docker <args>`: locally, or on the configured SSH host. */
export function dockerInvocation(config: SandboxConfig, args: string[], local: string[] = dockerContextArgs(config), controlDirectory?: string): { command: string; args: string[] } {
  if (!config.ssh) return { command: 'docker', args: [...local, ...args] };
  // One SSH connection per host, reused by every docker call: a new login costs seconds through a remote gateway.
  const reuse = controlDirectory ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlDirectory}/%C`, '-o', `ControlPersist=${SSH_PERSIST_SECONDS}`] : [];
  return { command: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', ...reuse, config.ssh, '--', 'docker', ...args.map(shellQuote)] };
}
const SSH_PERSIST_SECONDS = 300;
/** Short, per-user directory for SSH control sockets (a socket path must stay under about 100 bytes). */
export const sshControlDirectory = (uid = process.getuid?.() ?? 0) => `/tmp/aeeis-ssh-${uid}`;
export function dockerContextArgs(config: SandboxConfig, platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (config.context !== 'auto') return ['--context', config.context];
  if (env.DOCKER_HOST) return ['--host', env.DOCKER_HOST];
  if (env.DOCKER_CONTEXT) return ['--context', env.DOCKER_CONTEXT];
  return platform === 'darwin' ? ['--context', 'colima-aeeis'] : [];
}

/** Full Linux userspace, isolated from host files/devices and other Run networks. */
export function sandboxCreateArgs(config: SandboxConfig, name: string, imageId: string, owner: string, runId = 'test', volume?: string): string[] {
  return ['create', '--pull=never', '--name', name,
    '--label', 'aeeis.sandbox=2', '--label', `aeeis.owner=${owner}`, '--label', `aeeis.run=${runId}`,
    `--network=${config.network === 'none' ? 'none' : `${name}-net`}`, '--cap-drop=NET_RAW', '--security-opt=no-new-privileges:true',
    ...(config.network === 'proxied' ? [...proxyEnvArgs(name), `--network-alias=${RUN_ALIAS}`] : []),
    ...(volume ? ['--volume', `${volume}:/workspace`] : []),
    '--user=0:0', '--workdir=/workspace', '--restart=no', '--stop-timeout=3',
    `--memory=${config.memoryMiB}m`, `--memory-swap=${config.memoryMiB}m`, `--cpus=${config.cpus}`, `--pids-limit=${config.pids}`,
    '--ulimit=nofile=4096:4096', '--log-driver=none',
    '--env', `AEEIS_SANDBOX_IDLE_SECONDS=${config.idleSeconds}`, '--env', `AEEIS_SANDBOX_LIFETIME_SECONDS=${config.maxLifetimeSeconds}`,
    ...config.ports.flatMap(port => ['--publish', `127.0.0.1::${port}`]), imageId];
}

function proxyEnvArgs(_name: string): string[] {
  const proxy = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
  return ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].flatMap(key => ['--env', `${key}=${proxy}`])
    .concat(['--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1']);
}
/** The Run's only route out: a small, locked-down container on both the Run's internal network and an egress network. */
export function proxyCreateArgs(config: SandboxConfig, name: string, imageId: string, owner: string, runId = 'test'): string[] {
  return ['create', '--pull=never', '--name', `${name}-proxy`,
    '--label', 'aeeis.sandbox=2', '--label', `aeeis.owner=${owner}`, '--label', `aeeis.run=${runId}`, '--label', 'aeeis.role=proxy',
    `--network=${name}-egress`, '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--read-only', '--user=65534:65534',
    '--restart=unless-stopped', '--memory=128m', '--memory-swap=128m', '--cpus=0.5', '--pids-limit=64',
    '--log-driver=json-file', '--log-opt=max-size=1m', '--log-opt=max-file=2',
    '--env', `AEEIS_EGRESS_HOSTS=${config.egressHosts.join(',')}`, '--env', `AEEIS_PROXY_PORT=${PROXY_PORT}`,
    ...(config.previewPorts.length ? ['--env', `AEEIS_PREVIEW_PORTS=${config.previewPorts.join(',')}`, '--env', `AEEIS_PREVIEW_TARGET=${RUN_ALIAS}`] : []),
    ...config.previewPorts.flatMap(port => ['--publish', `127.0.0.1::${port}`]),
    ...(config.modelRelay ? ['--env', 'AEEIS_RELAY=1', '--tmpfs', '/run/aeeis:rw,size=1m,uid=65534,gid=65534,mode=0700'] : []),
    '--entrypoint', 'python3', imageId, '-I', '-u', '/opt/aeeis/proxy.py'];
}

export class DockerSandbox {
  private endpoint: string | undefined;
  private pinnedImage: string | undefined;
  private preparing: Promise<string> | undefined;
  private active = new Set<string>();
  private closing = false;
  private blocked = false;
  /** Run containers whose stop could not be confirmed because the SSH host was unreachable. Only those Runs wait;
   * their next call retries the stop first. A failed stop on a reachable engine still blocks everything. */
  private unstopped = new Set<string>();
  private controlReady: Promise<string | undefined> | undefined;
  /** Runs told to stop while no container was there to stop, such as during creation. Their next tool must not start. */
  private held = new Set<string>();
  private loginRefresh: Promise<void> | undefined;
  private lastLoginRefresh = 0;
  private readonly owner: string;
  private readonly directory: string;
  constructor(readonly config: SandboxConfig, stateDirectory: string) {
    this.owner = createHash('sha256').update(stateDirectory).digest('hex').slice(0, 16);
    this.directory = join(stateDirectory, 'sandboxes');
  }
  /** The control socket directory must be this user's alone: whoever can open the socket can use the connection.
   * If it cannot be made private, calls fall back to a fresh SSH login each time. */
  private controlDirectory(): Promise<string | undefined> {
    if (!this.config.ssh) return Promise.resolve(undefined);
    this.controlReady ??= (async () => {
      const directory = sshControlDirectory();
      try {
        await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        const info = await lstat(directory);
        const uid = process.getuid?.();
        if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) return undefined;
        return directory;
      } catch { return undefined; }
    })();
    return this.controlReady;
  }
  private async command(args: string[], timeoutMs: number, input?: string, maxBytes = 64_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
    try { return await this.transport(args, timeoutMs, input, maxBytes); }
    catch (error) {
      if (!(error instanceof SandboxUnreachable) || !(error.loginRefused || error.unresolved) || !this.config.sshLoginCommand) throw error;
      // A refused login or an unknown host ran nothing remotely, so logging in and trying once more is safe for any command.
      if (!await this.refreshLogin()) throw error;
      return this.transport(args, timeoutMs, input, maxBytes);
    }
  }
  /** Runs sshLoginCommand at most once per minute; concurrent refusals share one run. True if it succeeded. */
  private async refreshLogin(): Promise<boolean> {
    if (!this.loginRefresh) {
      if (Date.now() - this.lastLoginRefresh < 60_000) return false;
      this.lastLoginRefresh = Date.now();
      const [command, ...args] = this.config.sshLoginCommand!;
      this.loginRefresh = new Promise<void>((resolve, reject) => {
        const child = spawn(command!, args, { stdio: 'ignore', env: process.env });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')); }, 120_000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exited ${code}`)); });
      }).finally(() => { this.loginRefresh = undefined; });
    }
    return this.loginRefresh.then(() => true, () => false);
  }
  private async transport(args: string[], timeoutMs: number, input?: string, maxBytes = 64_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const control = await this.controlDirectory();
    return new Promise((resolve, reject) => {
      const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'DOCKER_CONFIG', ...(this.config.ssh ? ['SSH_AUTH_SOCK'] : [])].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
      const invocation = dockerInvocation(this.config, args, this.endpoint ? ['--host', this.endpoint] : dockerContextArgs(this.config), control);
      const child = spawn(invocation.command, invocation.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { child.kill('SIGKILL'); reject(error); }
        else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? null });
      };
      const timer = setTimeout(() => finish(new SandboxError('Docker operation timed out')), timeoutMs + (this.config.ssh ? SSH_ALLOWANCE_MS : 0));
      const collect = (target: Buffer[], chunk: Buffer) => { size += chunk.length; if (size > maxBytes) finish(new SandboxError('Sandbox output exceeded its limit', 'unknown')); else target.push(chunk); };
      child.stdout.on('data', chunk => collect(stdout, chunk)); child.stderr.on('data', chunk => collect(stderr, chunk));
      child.once('error', () => finish(new SandboxError(this.config.ssh ? 'ssh executable is unavailable' : 'Docker executable is unavailable')));
      child.once('close', code => {
        if (this.config.ssh && code === 255 && !settled) { settled = true; clearTimeout(timer); reject(new SandboxUnreachable(this.config.ssh, Buffer.concat(stderr).toString('utf8'))); return; }
        finish(undefined, code);
      });
      child.stdin.on('error', () => { /* exit status/output decides whether the operation completed */ });
      child.stdin.end(input);
    });
  }
  async imageId(): Promise<string> {
    if (this.blocked) throw new SandboxError('Sandbox stop could not be confirmed; recover Docker and restart AEEIS');
    if (this.closing) throw new SandboxError('Sandbox service is closing');
    if (this.pinnedImage) return this.pinnedImage;
    if (!this.preparing) this.preparing = this.prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }
  private async prepare(): Promise<string> {
    if (!this.endpoint && !this.config.ssh) {
      const selected = dockerContextArgs(this.config);
      const context = selected[0] === '--host' ? { code: 0, stdout: selected[1]! } : await this.command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], 5000);
      if (context.code !== 0 || !/^unix:\/\/\/[^\r\n]+$/.test(context.stdout.trim())) throw new SandboxError('Sandbox requires a local Unix Docker socket; run npm run sandbox:up');
      this.endpoint = context.stdout.trim();
    }
    const image = await this.command(['image', 'inspect', this.config.image, '--format', '{{.Id}} {{.Os}}'], 8000);
    const match = /^(sha256:[a-f0-9]{64}) linux$/.exec(image.stdout.trim());
    if (image.code !== 0 || !match) throw new SandboxError('Sandbox image unavailable; run npm run sandbox:build');
    this.pinnedImage = match[1]!;
    return this.pinnedImage;
  }
  /** A remote host is only contacted while a Run uses it, unless `probe` asks: the readiness monitor calls this every
   * minute, and contacting a host that pauses when idle (instabox) would keep it awake until it hits its run limit. */
  async health(options: { probe?: boolean } = {}) {
    if (this.config.ssh && !options.probe && !(await this.pendingRuns().catch(() => [{}])).length) {
      return { ready: true, detail: `Remote sandbox on ${this.config.ssh}, not checked while no Run uses it (so it can pause when idle)`, checkedAt: new Date().toISOString() };
    }
    try {
      const image = await this.imageId();
      const probe = await this.command(['info', '--format', '{{.OSType}}'], 3000);
      if (probe.code !== 0 || probe.stdout.trim() !== 'linux') throw new SandboxError('Docker Linux engine unavailable');
      const network = this.config.network === 'proxied' ? `proxied network (${this.config.egressHosts.length} allowed hosts)` : `${this.config.network} network`;
      return { ready: true, detail: `Persistent Linux sandbox${this.config.ssh ? ` on ${this.config.ssh}` : ''} · ${network} · ${this.config.memoryMiB} MiB · ${this.config.cpus} CPU · ${image.slice(0, 19)}`, checkedAt: new Date().toISOString() };
    } catch (error) { return { ready: false, detail: error instanceof Error ? error.message : 'Docker sandbox unavailable', checkedAt: new Date().toISOString() }; }
  }
  private name(runId: string) {
    if (!/^run_[a-f0-9-]{36}$/.test(runId)) throw new SandboxError('Invalid Run sandbox identity');
    return `aeeis-${this.owner}-${runId.slice(4)}`;
  }
  /** Read the state file for this Run. A missing file or an invalid id is absent. Identity mismatch still throws. */
  async describe(runId: string): Promise<RunMachineRecord | undefined> {
    let record: State | undefined;
    try { record = await this.state(runId); }
    catch (error) {
      if (error instanceof SandboxError && error.message === 'Invalid Run sandbox identity') return undefined;
      throw error;
    }
    if (!record) return undefined;
    if (record.released) return { state: 'released', ready: false };
    return { state: 'present', ready: record.ready };
  }
  private async state(runId: string): Promise<State | undefined> {
    const name = this.name(runId);
    try {
      const record = stateSchema.parse(JSON.parse(await readFile(join(this.directory, `${runId}.json`), 'utf8')));
      if (record.name !== name || record.runId !== runId || record.network !== `${name}-net`) throw new SandboxError('Sandbox identity mismatch');
      return record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async save(state: State) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${state.runId}.json`), temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await rename(temp, file);
  }
  private async inspect(state: State): Promise<{ Id: string; Image: string; State: { Running: boolean; Paused?: boolean }; Config: { Labels: Record<string, string> } } | null> {
    const result = await this.command(['inspect', '--type=container', state.name], 5000);
    if (result.code !== 0) {
      if (/No such (object|container)/i.test(result.stderr)) return null;
      throw new SandboxError('Cannot inspect Run sandbox', 'unknown');
    }
    const info = JSON.parse(result.stdout)[0];
    if (!info || info.Config?.Labels?.['aeeis.owner'] !== this.owner || info.Config?.Labels?.['aeeis.run'] !== state.runId
      || info.Config?.Labels?.['aeeis.sandbox'] !== '2' || info.Image !== state.image || (state.containerId && info.Id !== state.containerId)) throw new SandboxError('Container ownership or identity mismatch', 'unknown');
    return info;
  }
  private async start(state: State) {
    const inspected = await this.inspect(state);
    if (!inspected) throw new SandboxError('Run environment was removed externally; create a new Run instead of silently losing installed dependencies', 'unknown');
    // A tool call on a frozen container means someone is working in it again, such as a person who took over.
    if (inspected.State.Paused) {
      const thawed = await this.command(['unpause', state.name], 8000);
      if (thawed.code !== 0) throw new SandboxError('Could not resume Run sandbox', 'unknown');
      return;
    }
    // A running container means its tool service is up: the container exits when the service does.
    if (inspected.State.Running) return;
    if (this.config.network === 'proxied' && state.proxyId) {
      // The proxy restarts on its own after a crash or daemon restart; start it in case someone stopped it.
      const proxy = await this.command(['start', `${state.name}-proxy`], 8000);
      if (proxy.code !== 0) throw new SandboxError('Run egress proxy unavailable', 'unknown');
    }
    const started = await this.command(['start', state.name], 8000);
    if (started.code !== 0) throw new SandboxError('Could not start Run sandbox', 'unknown');
    // Wait for the Unix tool socket, including after a daemon restart. Never replay a tool here.
    const probe = `import socket,time\nfor _ in range(100):\n try:\n  s=socket.socket(socket.AF_UNIX); s.settimeout(1); s.connect("/run/aeeis.sock"); s.sendall(b'{"tool":"__ping"}'); s.shutdown(socket.SHUT_WR); assert s.recv(100)==b'{"ready":true}'; s.close(); break\n except (OSError,AssertionError): time.sleep(.05)\nelse: raise SystemExit(1)`;
    const ready = await this.command(['exec', state.name, 'python3', '-I', '-c', probe], 8000);
    if (ready.code !== 0) throw new SandboxError('Run sandbox tool service unavailable', 'unknown');
  }
  private async exchange(state: State, tool: string, input: unknown, timeoutMs: number, files: WorkspaceFile[] = []) {
    const snapshotBytes = this.config.snapshotMiB * 1024 * 1024;
    const result = await this.command(['exec', '--interactive', state.name, '/usr/bin/timeout', '--signal=KILL', `${Math.ceil(timeoutMs / 1000) + 10}s`, 'python3', '-I', '-u', '/opt/aeeis/client.py'], timeoutMs + 12000,
      JSON.stringify({ tool, input, files, timeoutMs, snapshotBytes }), Math.ceil(snapshotBytes * 1.5) + 2_000_000);
    if (result.code !== 0) throw new SandboxError('Sandbox transport failed; execution may have completed', 'unknown');
    const response = responseSchema.parse(JSON.parse(result.stdout));
    if (response.files !== null) validateSnapshot(response.files, snapshotBytes);
    return response;
  }
  private volumeName(grantId: string) {
    if (!/^wg_[a-f0-9]{32}$/.test(grantId)) throw new SandboxError('Invalid workspace identity');
    return `aeeis-${this.owner}-${grantId}`;
  }
  /** The unfinished Run currently using this grant's workspace, read from state files without touching Docker. */
  private async workspaceHolder(volume: string, runId: string): Promise<string | undefined> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    for (const name of names.filter(item => /^run_[a-f0-9-]{36}\.json$/.test(item) && item !== `${runId}.json`)) {
      const other = await this.state(name.slice(0, -5));
      if (other && !other.released && other.volume === volume) return other.runId;
    }
    return undefined;
  }
  /** Waits for a finished Run to be released. Callers must not hold the gateway's queue, which that release needs. */
  async waitForWorkspace(grantId: string, runId: string, timeoutMs: number): Promise<void> {
    const volume = this.volumeName(grantId), deadline = Date.now() + timeoutMs;
    if (await this.state(runId)) return;
    while (await this.workspaceHolder(volume, runId) && Date.now() < deadline && !this.closing) await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
  }
  private async prepareVolume(volume: string, runId: string) {
    const holder = await this.workspaceHolder(volume, runId);
    if (holder) throw new SandboxError(`This grant's workspace is in use by ${holder}; only one Run can use it at a time`);
    const found = await this.command(['volume', 'inspect', volume], 8000);
    if (found.code === 0) {
      if (JSON.parse(found.stdout)[0]?.Labels?.['aeeis.owner'] !== this.owner) throw new SandboxError('Workspace volume ownership mismatch');
      return;
    }
    if (!/no such volume/i.test(found.stderr)) throw new SandboxError('Cannot inspect workspace volume');
    const created = await this.command(['volume', 'create', '--label', `aeeis.owner=${this.owner}`, '--label', 'aeeis.sandbox=2', volume], 8000);
    if (created.code !== 0) throw new SandboxError('Cannot create workspace volume');
  }
  private async ensure(runId: string, files: WorkspaceFile[], workspace?: string): Promise<State> {
    if (this.blocked) throw new SandboxError('Sandbox stop could not be confirmed; recover Docker and restart AEEIS', 'unknown');
    let state = await this.state(runId);
    const image = state ? state.image : await this.imageId();
    const policy = digestProtocol({ config: this.config, image });
    if (state) {
      if (state.released) throw new SandboxError('Run sandbox was released; start a new Run');
      if (!state.ready) throw new SandboxError('Sandbox initialization was interrupted; inspect/release this environment before retrying', 'unknown');
      if (state.policy !== policy) throw new SandboxError('Run sandbox policy or image changed; start a new Run');
      if (Date.now() - state.createdAt > this.config.maxLifetimeSeconds * 1000) throw new SandboxError('Run sandbox lifetime expired; start a new Run');
    } else {
      validateSnapshot(files, this.config.snapshotMiB * 1024 * 1024);
      // Reach the host before recording anything, so a paused host does not leave a half-created Run behind.
      if (this.config.ssh) await this.command(['version', '--format', '{{.Server.Version}}'], 8000);
      const volume = workspace && this.config.workspaceVolumes ? this.volumeName(workspace) : undefined;
      if (volume) await this.prepareVolume(volume, runId);
      const name = this.name(runId);
      state = { runId, name, network: `${name}-net`, image, policy, ready: false, released: false, createdAt: Date.now(), ...(volume ? { volume } : {}) };
      await this.save(state);
      if (this.config.network !== 'none') {
        const internal = this.config.network === 'proxied' ? ['--internal'] : [];
        const network = await this.command(['network', 'create', '--label', `aeeis.owner=${this.owner}`, '--label', 'aeeis.sandbox=2', ...internal, state.network], 8000);
        if (network.code !== 0) throw new SandboxError('Cannot create isolated Run network');
      }
      if (this.config.network === 'proxied') {
        const egress = await this.command(['network', 'create', '--label', `aeeis.owner=${this.owner}`, '--label', 'aeeis.sandbox=2', `${name}-egress`], 8000);
        if (egress.code !== 0) throw new SandboxError('Cannot create Run egress network');
        const proxy = await this.command(proxyCreateArgs(this.config, name, image, this.owner, runId), 10000);
        if (proxy.code !== 0 || !/^[a-f0-9]{64}$/.test(proxy.stdout.trim())) throw new SandboxError('Cannot create Run egress proxy');
        state.proxyId = proxy.stdout.trim(); await this.save(state);
        const attached = await this.command(['network', 'connect', '--alias', PROXY_ALIAS, state.network, `${name}-proxy`], 8000);
        if (attached.code !== 0) throw new SandboxError('Cannot attach Run egress proxy');
        const started = await this.command(['start', `${name}-proxy`], 8000);
        if (started.code !== 0) throw new SandboxError('Cannot start Run egress proxy');
      }
      const created = await this.command(sandboxCreateArgs(this.config, name, image, this.owner, runId, volume), 10000);
      if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(created.stdout.trim())) throw new SandboxError('Cannot create Run sandbox');
      state.containerId = created.stdout.trim(); await this.save(state);
      await this.start(state);
      const restored = await this.exchange(state, '__restore', { persistent: Boolean(volume) }, 30000, files);
      if (restored.status !== 'completed') throw new SandboxError('Could not initialize Run workspace', 'unknown');
      state.ready = true; await this.save(state);
    }
    await this.start(state);
    return state;
  }
  private async stop(name: string) {
    // Stopping the whole container also stops escaped process groups. Its filesystem remains.
    let result: { code: number | null; stderr: string } | undefined;
    try { result = await this.command(['kill', name], 5000); }
    catch (error) {
      if (error instanceof SandboxUnreachable) {
        this.unstopped.add(name);
        throw new SandboxError(`${error.message}. This Run waits until its container can be stopped; other Runs are unaffected`, 'unknown');
      }
    }
    if (result?.code !== 0 && !/is not running|No such container/i.test(result?.stderr ?? '')) {
      this.unstopped.delete(name);
      this.blocked = true; throw new SandboxError('Sandbox stop could not be confirmed; execution blocked until recovery', 'unknown');
    }
    this.unstopped.delete(name);
  }
  async execute(runId: string, tool: string, input: unknown, files: WorkspaceFile[], timeoutMs: number, workspace?: string) {
    if (this.closing) throw new SandboxError('Sandbox service is closing');
    const state = await this.prepareWithWait(runId, files, workspace);
    if (this.closing) throw new SandboxError('Sandbox service is closing');
    if (this.held.has(runId)) throw new SandboxError('This Run was stopped before the tool started; nothing ran');
    this.active.add(state.name);
    try {
      const action = tool === 'process' ? (input as { action?: string }).action : undefined;
      const response = action === 'ports' ? await this.ports(state)
        : action === 'preview' ? await this.preview(state, (input as { port: number }).port)
        : await this.exchange(state, tool, input, timeoutMs);
      if (response.status === 'unknown') await this.stop(state.name);
      return response;
    } catch (error) {
      await this.stop(state.name);
      throw new SandboxError(error instanceof Error ? error.message : 'Sandbox execution failed', 'unknown');
    } finally { this.active.delete(state.name); }
  }
  /** Everything before the tool runs: a pending stop, then the container. While the SSH host is unreachable
   * (paused, cooling down, rebooting) this waits with backoff up to sshWaitSeconds, because nothing has run yet.
   * A refused login is not waited on; sshLoginCommand handles it. */
  private async prepareWithWait(runId: string, files: WorkspaceFile[], workspace?: string): Promise<State> {
    const name = this.name(runId), started = Date.now(), deadline = started + (this.config.ssh ? this.config.sshWaitSeconds * 1000 : 0);
    for (let attempt = 0; ; attempt++) {
      let waitable: SandboxError | undefined;
      try {
        // A stop that never reached the host is retried before anything else runs in that container.
        if (this.unstopped.has(name)) await this.stop(name);
        const ready = await this.ensure(runId, files, workspace);
        if (attempt > 0) await this.setHostWait(undefined);
        return ready;
      } catch (error) {
        const unreachable = (error instanceof SandboxUnreachable && !error.loginRefused) || (this.unstopped.has(name) && !(error instanceof SandboxUnreachable));
        // A host that says it stays away past the deadline is not worth holding every other call for.
        const tooLong = error instanceof SandboxUnreachable && (error.availableAt ?? 0) > deadline;
        if (!unreachable || tooLong || this.closing || Date.now() >= deadline) {
          if (attempt > 0) await this.setHostWait(undefined);
          const waited = Math.round((Date.now() - started) / 60_000);
          const message = error instanceof Error ? error.message : 'Run sandbox unavailable';
          // Nothing of the tool ran, so this is a plain failure, never "unknown".
          if (error instanceof SandboxUnreachable || this.unstopped.has(name)) throw new SandboxError(waited ? `${message} (waited ${waited} min)` : message, 'failed');
          throw error;
        }
        waitable = error as SandboxError;
      }
      if (attempt === 0) {
        console.warn(`AEEIS sandbox: ${waitable.message}; waiting up to ${Math.round((deadline - Date.now()) / 60_000)} min for it to come back`);
        const availableAt = waitable instanceof SandboxUnreachable ? waitable.availableAt : undefined;
        await this.setHostWait({ since: new Date(started).toISOString(), message: waitable.message, ...(availableAt ? { availableAt: new Date(availableAt).toISOString() } : {}) });
      }
      const delay = Math.min(30_000, 2_000 * 2 ** attempt, Math.max(0, deadline - Date.now()));
      for (const end = Date.now() + delay; Date.now() < end && !this.closing;) await new Promise(resolve => setTimeout(resolve, Math.min(500, end - Date.now())));
    }
  }
  /** Stops or freezes a Run's container directly, without waiting behind a tool call in progress. */
  async interrupt(runId: string, action: 'freeze' | 'thaw' | 'halt'): Promise<{ confirmed: boolean; detail?: string }> {
    if (action === 'thaw') this.held.delete(runId); else this.held.add(runId);
    let state: State | undefined;
    try { state = await this.state(runId); } catch (error) { return { confirmed: false, detail: error instanceof Error ? error.message : 'Run sandbox state unreadable' }; }
    if (!state || state.released) return { confirmed: true, detail: 'no machine' };
    try {
      if (action === 'halt') { await this.stop(state.name); return { confirmed: true }; }
      const result = await this.command([action === 'freeze' ? 'pause' : 'unpause', state.name], 8000);
      if (result.code === 0) { if (action === 'freeze') this.held.delete(runId); return { confirmed: true }; }
      if (/already paused|is not paused|is not running|No such container/i.test(result.stderr)) return { confirmed: true };
      return { confirmed: false, detail: result.stderr.trim().slice(0, 300) || 'Docker refused' };
    } catch (error) {
      return { confirmed: false, detail: error instanceof Error ? error.message : 'Sandbox host unavailable' };
    }
  }
  /** A look at the machine. It never starts or thaws anything; `live: false` does not touch the host at all. */
  async observe(runId: string, live: boolean): Promise<MachineView> {
    let state: State | undefined;
    try { state = await this.state(runId); }
    catch (error) {
      if (error instanceof SandboxError && error.message === 'Invalid Run sandbox identity') return { state: 'absent', previews: [] };
      return { state: 'unknown', detail: error instanceof Error ? error.message : 'Run sandbox state unreadable', previews: [] };
    }
    if (!state) return { state: 'absent', previews: [] };
    if (state.released) return { state: 'released', previews: [] };
    const previews = Object.entries(state.previews ?? {}).map(([port, item]) => ({ port: Number(port), url: item.url }));
    if (!live) return { state: 'unknown', previews };
    try {
      const inspected = await this.inspect(state);
      if (!inspected) return { state: 'stopped', detail: 'The container no longer exists', previews };
      if (inspected.State.Paused) return { state: 'frozen', previews };
      if (!inspected.State.Running) return { state: 'stopped', previews };
      const result = await this.command(['exec', state.name, 'python3', '-I', '/opt/aeeis/observe.py'], 15_000, undefined, 512 * 1024);
      // It can be frozen or stopped between the two calls above.
      if (result.code !== 0 && /is paused/i.test(result.stderr)) return { state: 'frozen', previews };
      if (result.code !== 0 && /is not running/i.test(result.stderr)) return { state: 'stopped', previews };
      if (result.code !== 0) return { state: 'running', detail: 'This Run was started from an older sandbox image, or the look failed', previews };
      return { state: 'running', live: observationSchema.parse(JSON.parse(result.stdout)), previews };
    } catch (error) {
      if (error instanceof SandboxUnreachable) return { state: 'unreachable', detail: error.message, previews };
      return { state: 'unknown', detail: error instanceof Error ? error.message : 'Sandbox look failed', previews };
    }
  }
  private hostWaitFile() { return join(this.directory, 'host-wait.json'); }
  private async setHostWait(wait: HostWait | undefined) {
    try {
      if (!wait) { await rm(this.hostWaitFile(), { force: true }); return; }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.hostWaitFile(), JSON.stringify(wait), { mode: 0o600 });
    } catch (error) { console.warn(`AEEIS sandbox: could not record host wait: ${error instanceof Error ? error.message : error}`); }
  }
  /** Set while a tool call is waiting for the SSH host, in a file so that any AEEIS process can show it. */
  async hostWait(): Promise<HostWait | undefined> {
    try {
      const wait = JSON.parse(await readFile(this.hostWaitFile(), 'utf8')) as HostWait;
      // A record older than the longest possible wait was left by a process that died mid-wait.
      return Date.now() - Date.parse(wait.since) > (this.config.sshWaitSeconds + 120) * 1000 ? undefined : wait;
    } catch { return undefined; }
  }
  /** Talks to the relay inside the Run's proxy. On stdin, because `open` carries the real API key. */
  private async relay(state: State, message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.command(['exec', '--interactive', `${state.name}-proxy`, 'python3', '-I', '/opt/aeeis/relay_ctl.py'], 15_000, JSON.stringify(message));
    if (result.code !== 0) throw new SandboxError('Model relay unavailable');
    const answer = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof answer.error === 'string') throw new SandboxError(`Model relay: ${answer.error}`);
    return answer;
  }
  /** Opens a relay session and starts the executor in the Run's container. Nothing has run if this throws. */
  async startExecutor(runId: string, session: { id: string; token: string; prompt: string; argv: string[]; env: Record<string, string>; key: string; upstream: string; budget: number; seconds: number }, files: WorkspaceFile[], workspace?: string): Promise<void> {
    if (!this.config.modelRelay) throw new SandboxError('The executor needs sandbox.modelRelay');
    const state = await this.prepareWithWait(runId, files, workspace);
    if (this.held.has(runId)) throw new SandboxError('This Run was stopped before the executor started; nothing ran');
    await this.relay(state, { action: 'open', token: session.token, key: session.key, upstream: session.upstream, budget: session.budget, seconds: session.seconds });
    this.active.add(state.name);
    try {
      // If the reply is lost the session may be running anyway. Revoking its token ends what it can do.
      const started = await this.exchange(state, '__executor_start', { session: session.id, prompt: session.prompt, argv: session.argv, env: session.env }, 30_000)
        .catch(async error => { await this.relay(state, { action: 'close', token: session.token }).catch(() => undefined); throw error; });
      if (started.status !== 'completed') {
        await this.relay(state, { action: 'close', token: session.token }).catch(() => undefined);
        throw new SandboxError(`Could not start the executor: ${JSON.stringify(started.output).slice(0, 300)}`);
      }
      state.executor = { session: session.id, token: session.token, pid: (started.output as { pid: number }).pid };
      await this.save(state);
    } finally { this.active.delete(state.name); }
  }
  async executorRecord(runId: string) { return (await this.state(runId))?.executor; }
  /** New output since `offset`. Reads beside the tool service and never starts or thaws anything. */
  async pollExecutor(runId: string, session: string, offset: number): Promise<ExecutorPoll> {
    const empty = { output: '', offset, more: false, exitCode: null, errors: '' };
    const state = await this.state(runId);
    if (!state) return { state: 'missing', ...empty };
    try {
      const result = await this.command(['exec', state.name, 'python3', '-I', '/opt/aeeis/observe.py', 'executor', session, String(offset)], 15_000, undefined, 512 * 1024);
      if (result.code !== 0) {
        if (/is paused/i.test(result.stderr)) return { state: 'frozen', ...empty };
        return { state: 'stopped', ...empty };
      }
      const read = JSON.parse(result.stdout) as { found: boolean; offset?: number; output?: string; more?: boolean; exitCode?: number | null; errors?: string };
      if (!read.found) return { state: 'missing', ...empty };
      return { state: 'running', output: read.output ?? '', offset: read.offset ?? offset, more: Boolean(read.more), exitCode: read.exitCode ?? null, errors: read.errors ?? '' };
    } catch (error) {
      if (error instanceof SandboxUnreachable) return { state: 'unreachable', ...empty };
      throw error;
    }
  }
  /** What the relay has counted. This, not the executor's own report, is what the session cost. */
  async relayUsage(runId: string, token: string): Promise<RelayUsage | undefined> {
    const state = await this.state(runId);
    if (!state) return undefined;
    return (await this.relay(state, { action: 'status', token }).catch(() => undefined)) as RelayUsage | undefined;
  }
  /** Revokes the session token. Its answer is the final count. */
  async closeRelay(runId: string, token: string): Promise<RelayUsage | undefined> {
    const state = await this.state(runId);
    if (!state) return undefined;
    return (await this.relay(state, { action: 'close', token }).catch(() => undefined)) as RelayUsage | undefined;
  }
  /** Keeps a finished Run's machine up, so the preview link it delivered still opens. */
  async keepMachine(runId: string, hours: number): Promise<void> {
    const state = await this.state(runId);
    if (state && !state.released) { state.keepUntil = Date.now() + hours * 3_600_000; await this.save(state); }
  }
  /**
   * Counts as activity on the machine's idle timer. The tool service inside exits after idleSeconds without a request,
   * which would end a kept machine (and its preview) long before its keep runs out.
   */
  async touch(runId: string): Promise<boolean> {
    const state = await this.state(runId);
    if (!state || state.released) return false;
    const ping = `import socket\ns=socket.socket(socket.AF_UNIX); s.settimeout(20); s.connect("/run/aeeis.sock"); s.sendall(b'{"tool":"__ping"}'); s.shutdown(socket.SHUT_WR); assert s.recv(100)==b'{"ready":true}'`;
    return (await this.command(['exec', state.name, 'python3', '-I', '-c', ping], 30_000)).code === 0;
  }
  /** Copies the Run's artifacts out now, for a session that wrote them outside any tool call. */
  async snapshotArtifacts(runId: string): Promise<WorkspaceFile[]> {
    const state = await this.state(runId);
    if (!state) return [];
    return (await this.exchange(state, '__snapshot', {}, 30_000)).files ?? [];
  }
  /** Ends the executor's process group, leaving the container and everything else in it running. */
  async stopExecutor(runId: string, pid: number): Promise<void> {
    const state = await this.state(runId);
    if (state) await this.command(['exec', state.name, 'kill', '-TERM', `-${pid}`], 8000).catch(() => undefined);
  }
  /** Runs an operator-configured command on the AEEIS host (no shell) and returns its standard output. */
  private localCommand(argv: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const [command, ...args] = argv;
      const child = spawn(command!, args, { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
      let output = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')); }, timeoutMs);
      child.stdout.on('data', chunk => { if (output.length < 16_000) output += chunk; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`exited ${code}`)); });
    });
  }
  /** Shares one preview port. A failure here is the tool's result, not a reason to stop the Run's container. */
  private async preview(state: State, port: number) {
    const answer = (status: 'completed' | 'failed', output: unknown) => ({ schemaVersion: 'sandbox-output/2' as const, status, output, files: null });
    if (!this.config.previewCommand || !this.config.previewPorts.includes(port)) return answer('failed', { error: `Port ${port} cannot be previewed; allowed: ${this.config.previewPorts.join(', ') || '(none)'}` });
    const note = 'Only people with this link can open it. Listen on 0.0.0.0 inside the container. The link ends when this Run is released.';
    const known = state.previews?.[String(port)];
    if (known) return answer('completed', { port, url: known.url, note });
    const mapped = await this.command(['port', `${state.name}-proxy`, `${port}/tcp`], 8000);
    const hostPort = /:(\d+)\s*$/m.exec(mapped.stdout.trim().split('\n')[0] ?? '')?.[1];
    if (mapped.code !== 0 || !hostPort) return answer('failed', { error: 'Preview port is not available on this Run; it needs a new Run after a configuration change' });
    let printed: string;
    try { printed = await this.localCommand(this.config.previewCommand.publish.map(item => item.replaceAll('{port}', hostPort)), 120_000); }
    catch { return answer('failed', { error: 'Could not publish the preview link' }); }
    const url = /https:\/\/[^\s"'<>]+/.exec(printed)?.[0];
    if (!url) return answer('failed', { error: 'The preview command did not print a link' });
    state.previews = { ...state.previews, [String(port)]: { hostPort, url } };
    await this.save(state);
    return answer('completed', { port, url, note });
  }
  private async unpublishPreviews(state: State) {
    if (!this.config.previewCommand) return;
    for (const { hostPort } of Object.values(state.previews ?? {})) {
      await this.localCommand(this.config.previewCommand.unpublish.map(item => item.replaceAll('{port}', hostPort)), 120_000)
        .catch(error => console.warn(`AEEIS sandbox: could not unpublish preview port ${hostPort}: ${error instanceof Error ? error.message : error}`));
    }
  }
  private async ports(state: State) {
    const result = await this.command(['port', state.name], 5000);
    if (result.code !== 0) throw new SandboxError('Could not read sandbox ports');
    return { schemaVersion: 'sandbox-output/2' as const, status: 'completed' as const, output: { bindings: result.stdout.trim(), note: 'Only configured ports bind to host loopback; services must listen on 0.0.0.0 inside the container.' }, files: null };
  }
  async release(runId: string, saveArtifacts: (files: WorkspaceFile[]) => Promise<void>) {
    const state = await this.state(runId);
    if (!state || state.released) return;
    await this.unpublishPreviews(state);
    if (await this.inspect(state)) {
      if (state.ready) {
        // Stop background writers before exporting the final artifact snapshot.
        await this.stop(state.name); await this.start(state);
        // Keep what the owner reviews: once the machine is gone, the source and site exist only in this export.
        await this.exchange(state, 'shell', { command: PACK_DELIVERABLES }, 90_000).catch(() => undefined);
        const exported = await this.exchange(state, '__snapshot', {}, 30000);
        if (exported.files === null) throw new SandboxError('Artifact export failed; sandbox retained for recovery', 'unknown');
        await saveArtifacts(exported.files);
      }
      const removed = await this.command(['rm', '--force', state.name], 8000);
      if (removed.code !== 0) throw new SandboxError('Cannot release Run sandbox', 'unknown');
    }
    if (state.proxyId) {
      const removed = await this.command(['rm', '--force', `${state.name}-proxy`], 8000);
      if (removed.code !== 0 && !/No such container/i.test(removed.stderr)) throw new SandboxError('Cannot release Run egress proxy', 'unknown');
    }
    const networks = this.config.network === 'none' ? [] : this.config.network === 'proxied' ? [state.network, `${state.name}-egress`] : [state.network];
    for (const name of networks) {
      const network = await this.command(['network', 'inspect', name], 5000);
      if (network.code === 0) {
        const info = JSON.parse(network.stdout)[0];
        if (info?.Labels?.['aeeis.owner'] !== this.owner || info?.Labels?.['aeeis.sandbox'] !== '2') throw new SandboxError('Network ownership mismatch');
        if ((await this.command(['network', 'rm', name], 8000)).code !== 0) throw new SandboxError('Cannot release Run network');
      } else if (!/not found|No such network/i.test(network.stderr)) throw new SandboxError('Cannot inspect Run network');
    }
    state.released = true; await this.save(state);
  }
  async pendingRuns(): Promise<{ runId: string; expired: boolean; keepUntil?: number }[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const pending = [];
    for (const name of names.filter(name => /^run_[a-f0-9-]{36}\.json$/.test(name))) {
      const state = await this.state(name.slice(0, -5));
      if (state && !state.released) pending.push({ runId: state.runId, expired: Date.now() - state.createdAt > this.config.maxLifetimeSeconds * 1000, ...(state.keepUntil ? { keepUntil: state.keepUntil } : {}) });
    }
    return pending;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active].map(name => this.stop(name)));
    // Idle Run containers and installed packages survive an AEEIS restart.
    const control = this.config.ssh ? await this.controlDirectory() : undefined;
    if (control) await new Promise<void>(resolve => {
      const child = spawn('ssh', ['-o', `ControlPath=${control}/%C`, '-O', 'exit', this.config.ssh!], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
      child.once('error', () => { clearTimeout(timer); resolve(); }); child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}
