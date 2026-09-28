import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digestProtocol } from './protocol.js';
import { snapshotSchema, validateSnapshot, type WorkspaceFile } from './sandbox-workspace.js';

export const sandboxConfigSchema = z.object({
  runtime: z.literal('docker').default('docker'),
  context: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/).default('auto'),
  image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,250}$/).default('aeeis-sandbox:2'),
  memoryMiB: z.number().int().min(128).max(16384).default(1024),
  cpus: z.number().min(0.25).max(16).default(2),
  pids: z.number().int().min(16).max(4096).default(256),
  network: z.enum(['bridge', 'none']).default('bridge'),
  snapshotMiB: z.number().int().min(1).max(32).default(16),
  idleSeconds: z.number().int().min(60).max(86400).default(3600),
  maxLifetimeSeconds: z.number().int().min(300).max(604800).default(86400),
  ports: z.array(z.number().int().min(1024).max(65535)).max(20).default([]),
}).strict().refine(config => new Set(config.ports).size === config.ports.length && (config.network !== 'none' || config.ports.length === 0), 'Ports must be unique and require networking');
export type SandboxConfig = z.infer<typeof sandboxConfigSchema>;
const responseSchema = z.object({
  schemaVersion: z.literal('sandbox-output/2'), status: z.enum(['completed', 'failed', 'unknown']), output: z.unknown(), files: snapshotSchema.nullable(),
}).strict();
const stateSchema = z.object({ runId: z.string(), name: z.string(), network: z.string(), image: z.string(), policy: z.string(), createdAt: z.number(), ready: z.boolean(), released: z.boolean().default(false), containerId: z.string().optional() });
type State = z.infer<typeof stateSchema>;
export class SandboxError extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown' = 'failed') { super(message); }
}
export function dockerContextArgs(config: SandboxConfig, platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (config.context !== 'auto') return ['--context', config.context];
  if (env.DOCKER_HOST) return ['--host', env.DOCKER_HOST];
  if (env.DOCKER_CONTEXT) return ['--context', env.DOCKER_CONTEXT];
  return platform === 'darwin' ? ['--context', 'colima-aeeis'] : [];
}

/** Full Linux userspace, isolated from host files/devices and other Run networks. */
export function sandboxCreateArgs(config: SandboxConfig, name: string, imageId: string, owner: string, runId = 'test'): string[] {
  return ['create', '--pull=never', '--name', name,
    '--label', 'aeeis.sandbox=2', '--label', `aeeis.owner=${owner}`, '--label', `aeeis.run=${runId}`,
    `--network=${config.network === 'none' ? 'none' : `${name}-net`}`, '--cap-drop=NET_RAW', '--security-opt=no-new-privileges:true',
    '--user=0:0', '--workdir=/workspace', '--restart=no', '--stop-timeout=3',
    `--memory=${config.memoryMiB}m`, `--memory-swap=${config.memoryMiB}m`, `--cpus=${config.cpus}`, `--pids-limit=${config.pids}`,
    '--ulimit=nofile=4096:4096', '--log-driver=none',
    '--env', `AEEIS_SANDBOX_IDLE_SECONDS=${config.idleSeconds}`, '--env', `AEEIS_SANDBOX_LIFETIME_SECONDS=${config.maxLifetimeSeconds}`,
    ...config.ports.flatMap(port => ['--publish', `127.0.0.1::${port}`]), imageId];
}

export class DockerSandbox {
  private endpoint: string | undefined;
  private pinnedImage: string | undefined;
  private preparing: Promise<string> | undefined;
  private active = new Set<string>();
  private closing = false;
  private blocked = false;
  private readonly owner: string;
  private readonly directory: string;
  constructor(readonly config: SandboxConfig, stateDirectory: string) {
    this.owner = createHash('sha256').update(stateDirectory).digest('hex').slice(0, 16);
    this.directory = join(stateDirectory, 'sandboxes');
  }
  private async command(args: string[], timeoutMs: number, input?: string, maxBytes = 64_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'TMPDIR', 'DOCKER_CONFIG'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
      const child = spawn('docker', [...(this.endpoint ? ['--host', this.endpoint] : dockerContextArgs(this.config)), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error, code?: number | null) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { child.kill('SIGKILL'); reject(error); }
        else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code: code ?? null });
      };
      const timer = setTimeout(() => finish(new SandboxError('Docker operation timed out')), timeoutMs);
      const collect = (target: Buffer[], chunk: Buffer) => { size += chunk.length; if (size > maxBytes) finish(new SandboxError('Sandbox output exceeded its limit', 'unknown')); else target.push(chunk); };
      child.stdout.on('data', chunk => collect(stdout, chunk)); child.stderr.on('data', chunk => collect(stderr, chunk));
      child.once('error', () => finish(new SandboxError('Docker executable is unavailable')));
      child.once('close', code => finish(undefined, code));
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
    if (!this.endpoint) {
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
  async health() {
    try {
      const image = await this.imageId();
      const probe = await this.command(['info', '--format', '{{.OSType}}'], 3000);
      if (probe.code !== 0 || probe.stdout.trim() !== 'linux') throw new SandboxError('Docker Linux engine unavailable');
      return { ready: true, detail: `Persistent Linux sandbox · ${this.config.network} network · ${this.config.memoryMiB} MiB · ${this.config.cpus} CPU · ${image.slice(0, 19)}`, checkedAt: new Date().toISOString() };
    } catch (error) { return { ready: false, detail: error instanceof Error ? error.message : 'Docker sandbox unavailable', checkedAt: new Date().toISOString() }; }
  }
  private name(runId: string) {
    if (!/^run_[a-f0-9-]{36}$/.test(runId)) throw new SandboxError('Invalid Run sandbox identity');
    return `aeeis-${this.owner}-${runId.slice(4)}`;
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
  private async inspect(state: State): Promise<{ Id: string; Image: string; State: { Running: boolean }; Config: { Labels: Record<string, string> } } | null> {
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
    if (!inspected.State.Running) {
      const started = await this.command(['start', state.name], 8000);
      if (started.code !== 0) throw new SandboxError('Could not start Run sandbox', 'unknown');
    }
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
  private async ensure(runId: string, files: WorkspaceFile[]): Promise<State> {
    const image = await this.imageId(), policy = digestProtocol({ config: this.config, image });
    let state = await this.state(runId);
    if (state) {
      if (state.released) throw new SandboxError('Run sandbox was released; start a new Run');
      if (!state.ready) throw new SandboxError('Sandbox initialization was interrupted; inspect/release this environment before retrying', 'unknown');
      if (state.policy !== policy) throw new SandboxError('Run sandbox policy or image changed; start a new Run');
      if (Date.now() - state.createdAt > this.config.maxLifetimeSeconds * 1000) throw new SandboxError('Run sandbox lifetime expired; start a new Run');
    } else {
      validateSnapshot(files, this.config.snapshotMiB * 1024 * 1024);
      const name = this.name(runId);
      state = { runId, name, network: `${name}-net`, image, policy, ready: false, released: false, createdAt: Date.now() };
      await this.save(state);
      if (this.config.network !== 'none') {
        const network = await this.command(['network', 'create', '--label', `aeeis.owner=${this.owner}`, '--label', 'aeeis.sandbox=2', state.network], 8000);
        if (network.code !== 0) throw new SandboxError('Cannot create isolated Run network');
      }
      const created = await this.command(sandboxCreateArgs(this.config, name, image, this.owner, runId), 10000);
      if (created.code !== 0 || !/^[a-f0-9]{64}$/.test(created.stdout.trim())) throw new SandboxError('Cannot create Run sandbox');
      state.containerId = created.stdout.trim(); await this.save(state);
      await this.start(state);
      const restored = await this.exchange(state, '__restore', {}, 30000, files);
      if (restored.status !== 'completed') throw new SandboxError('Could not initialize Run workspace', 'unknown');
      state.ready = true; await this.save(state);
    }
    await this.start(state);
    return state;
  }
  private async stop(name: string) {
    // Stopping the whole container also stops escaped process groups. Its filesystem remains.
    const result = await this.command(['kill', name], 5000).catch(() => undefined);
    if (result?.code !== 0 && !/is not running|No such container/i.test(result?.stderr ?? '')) {
      this.blocked = true; throw new SandboxError('Sandbox stop could not be confirmed; execution blocked until recovery', 'unknown');
    }
  }
  async execute(runId: string, tool: string, input: unknown, files: WorkspaceFile[], timeoutMs: number) {
    if (this.closing) throw new SandboxError('Sandbox service is closing');
    const state = await this.ensure(runId, files);
    if (this.closing) throw new SandboxError('Sandbox service is closing');
    this.active.add(state.name);
    try {
      const response = tool === 'process' && (input as { action?: string }).action === 'ports'
        ? await this.ports(state)
        : await this.exchange(state, tool, input, timeoutMs);
      if (response.status === 'unknown') await this.stop(state.name);
      return response;
    } catch (error) {
      await this.stop(state.name);
      throw new SandboxError(error instanceof Error ? error.message : 'Sandbox execution failed', 'unknown');
    } finally { this.active.delete(state.name); }
  }
  private async ports(state: State) {
    const result = await this.command(['port', state.name], 5000);
    if (result.code !== 0) throw new SandboxError('Could not read sandbox ports');
    return { schemaVersion: 'sandbox-output/2' as const, status: 'completed' as const, output: { bindings: result.stdout.trim(), note: 'Only configured ports bind to host loopback; services must listen on 0.0.0.0 inside the container.' }, files: null };
  }
  async release(runId: string, saveArtifacts: (files: WorkspaceFile[]) => Promise<void>) {
    await this.imageId();
    const state = await this.state(runId);
    if (!state || state.released) return;
    if (await this.inspect(state)) {
      if (state.ready) {
        // Stop background writers before exporting the final artifact snapshot.
        await this.stop(state.name); await this.start(state);
        const exported = await this.exchange(state, '__snapshot', {}, 30000);
        if (exported.files === null) throw new SandboxError('Artifact export failed; sandbox retained for recovery', 'unknown');
        await saveArtifacts(exported.files);
      }
      const removed = await this.command(['rm', '--force', state.name], 8000);
      if (removed.code !== 0) throw new SandboxError('Cannot release Run sandbox', 'unknown');
    }
    if (this.config.network !== 'none') {
      const network = await this.command(['network', 'inspect', state.network], 5000);
      if (network.code === 0) {
        const info = JSON.parse(network.stdout)[0];
        if (info?.Labels?.['aeeis.owner'] !== this.owner || info?.Labels?.['aeeis.sandbox'] !== '2') throw new SandboxError('Network ownership mismatch');
        if ((await this.command(['network', 'rm', state.network], 8000)).code !== 0) throw new SandboxError('Cannot release Run network');
      } else if (!/not found|No such network/i.test(network.stderr)) throw new SandboxError('Cannot inspect Run network');
    }
    state.released = true; await this.save(state);
  }
  async pendingRuns(): Promise<{ runId: string; expired: boolean }[]> {
    let names: string[];
    try { names = await readdir(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const pending = [];
    for (const name of names.filter(name => /^run_[a-f0-9-]{36}\.json$/.test(name))) {
      const state = await this.state(name.slice(0, -5));
      if (state && !state.released) pending.push({ runId: state.runId, expired: Date.now() - state.createdAt > this.config.maxLifetimeSeconds * 1000 });
    }
    return pending;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active].map(name => this.stop(name)));
    // Idle Run containers and installed packages survive an AEEIS restart.
  }
}
