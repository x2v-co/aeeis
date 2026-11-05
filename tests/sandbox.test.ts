import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, link, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { DockerSandbox, SandboxError, SandboxUnreachable, sandboxConfigSchema, sandboxCreateArgs, dockerContextArgs, dockerInvocation, proxyCreateArgs, shellQuote, sshControlDirectory } from '../src/docker-sandbox.js';
import { commitSnapshot, readSnapshot, validateSnapshot } from '../src/sandbox-workspace.js';
import { LocalToolGateway } from '../src/local-tools.js';
import type { ToolInvocation } from '../src/integrations.js';

const image = `sha256:${'a'.repeat(64)}`, config = sandboxConfigSchema.parse({});
const file = (path: string, content = 'hello') => ({ path, base64: Buffer.from(content).toString('base64') });
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aeeis-sandbox-test-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

describe('untrusted workspace snapshots', () => {
  it.each(['../escape', '/absolute', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'nul\0name', 'line\nname'])('rejects unsafe path %j', path => {
    expect(() => validateSnapshot([file(path)], 100)).toThrow();
  });
  it('rejects duplicate, file/directory and host case/Unicode aliases', () => {
    for (const paths of [['a', 'a'], ['a', 'a/b'], ['A', 'a/b'], ['A/x', 'a/y'], ['é', 'e\u0301']]) {
      expect(() => validateSnapshot(paths.map(path => file(path)), 100)).toThrow();
    }
  });
  it('bounds decoded sizes and requires canonical base64', () => {
    expect(() => validateSnapshot([file('a', 'abcdef')], 5)).toThrow();
    expect(() => validateSnapshot([{ path: 'a', base64: '***' }], 100)).toThrow();
    expect(() => validateSnapshot(Array.from({ length: 1001 }, (_, i) => file(String(i), '')), 100)).toThrow();
  });
  it('atomically replaces snapshots and preserves the last valid version after invalid output', async () => {
    const workspace = join(root, 'run');
    await commitSnapshot(workspace, [file('old.txt')], 100);
    await expect(commitSnapshot(workspace, [file('../escape')], 100)).rejects.toThrow();
    expect(await readSnapshot(workspace, 100)).toEqual([file('old.txt')]);
    await commitSnapshot(workspace, [file('nested/new.txt', '新')], 100);
    expect(await readSnapshot(workspace, 100)).toEqual([file('nested/new.txt', '新')]);
    await expect(readFile(join(workspace, 'old.txt'))).rejects.toThrow();
    await rename(workspace, `${workspace}.previous`);
    expect(await readSnapshot(workspace, 100)).toEqual([file('nested/new.txt', '新')]);
    expect(await readSnapshot(join(root, 'missing'), 100)).toEqual([]);
  });
  it('refuses host symlinks, hardlinks and linked workspace roots', async () => {
    const workspace = join(root, 'run'); await mkdir(workspace);
    await writeFile(join(root, 'secret'), 'private');
    await symlink(root, join(workspace, 'linked'));
    await expect(readSnapshot(workspace, 100)).rejects.toThrow(/links/);
    await rm(join(workspace, 'linked'));
    await link(join(root, 'secret'), join(workspace, 'hard'));
    await expect(readSnapshot(workspace, 100)).rejects.toThrow(/links/);
    await symlink(root, join(root, 'linked-root'));
    await expect(readSnapshot(join(root, 'linked-root'), 100)).rejects.toThrow(/regular/);
    expect(await readFile(join(root, 'secret'), 'utf8')).toBe('private');
  });
});

describe('persistent Docker execution boundary (mocked transport)', () => {
  const runId = `run_${'a'.repeat(36)}`;
  const harness = () => {
    const sandbox = new DockerSandbox(config, root);
    let info: any, createdArgs: string[] = [], networkLabels: any;
    const response = { schemaVersion: 'sandbox-output/2', status: 'completed', output: { stdout: '42' }, files: [file('answer', '42')] };
    const command = vi.spyOn(sandbox as any, 'command').mockImplementation(async (...values: any[]) => {
      const args = values[0] as string[];
      if (args[0] === 'context') return ok('unix:///tmp/docker.sock');
      if (args[0] === 'image') return ok(`${image} linux`);
      if (args[0] === 'info') return ok('linux');
      if (args[0] === 'network') {
        if (args[1] === 'create') { networkLabels = { 'aeeis.owner': args[3]!.split('=')[1], 'aeeis.sandbox': '2' }; return ok('network'); }
        if (args[1] === 'inspect') return ok(JSON.stringify([{Labels:networkLabels}]));
        return ok();
      }
      if (args[0] === 'create') {
        createdArgs = args;
        const labels = Object.fromEntries(args.flatMap((a,i)=>a === '--label' ? [args[i+1]!.split('=')] : []));
        info = { Id: 'c'.repeat(64), Image: image, Config: { Labels: labels }, State: { Running: false } };
        return ok(info.Id);
      }
      if (args[0] === 'inspect') return info ? ok(JSON.stringify([info])) : {code:1,stdout:'',stderr:'No such container'};
      if (args[0] === 'start') { info.State.Running = true; return ok(); }
      if (args[0] === 'kill') { info.State.Running = false; return ok(); }
      if (args[0] === 'rm') { info = undefined; return ok(); }
      if (args[0] === 'exec' && args.includes('--interactive')) return ok(JSON.stringify(response));
      return ok();
    });
    return { sandbox, command, response, createdArgs: () => createdArgs, disappear: () => {info = undefined;} };
  };
  it('selects Colima on Mac and native Docker on Linux without changing global context', () => {
    expect(dockerContextArgs(config, 'darwin', {})).toEqual(['--context','colima-aeeis']);
    expect(dockerContextArgs(config, 'linux', {})).toEqual([]);
    expect(dockerContextArgs(config, 'linux', { DOCKER_HOST:'unix:///run/user/1000/docker.sock' })).toEqual(['--host','unix:///run/user/1000/docker.sock']);
    expect(dockerContextArgs({...config,context:'chosen'}, 'darwin', {})).toEqual(['--context','chosen']);
  });
  it('allows package installation and networking without host mounts, privileged mode or public ports', () => {
    const args = sandboxCreateArgs({...config,ports:[8000]}, 'test', image, 'owner');
    expect(args).toContain('--user=0:0'); expect(args).toContain('--network=test-net');
    expect(args).toContain('--memory=1024m'); expect(args).toContain('127.0.0.1::8000');
    expect(args.join(' ')).not.toMatch(/--(?:mount|volume|privileged|pid)=|docker.sock|--read-only/);
    expect(args).toContain('--security-opt=no-new-privileges:true');
  });
  it('reuses a Run container and retains it across gateway restarts', async () => {
    const {sandbox,command}=harness();
    await sandbox.execute(runId,'python',{},[],300);
    await sandbox.execute(runId,'shell',{},[],300);
    expect(command.mock.calls.filter(c=>c[0][0]==='create')).toHaveLength(1);
    expect(command.mock.calls.filter(c=>c[0][0]==='rm')).toHaveLength(0);
    await sandbox.close();
    expect(command.mock.calls.filter(c=>c[0][0]==='kill')).toHaveLength(0);
    const restarted = new DockerSandbox(config,root);
    vi.spyOn(restarted as any,'command').mockImplementation(command.getMockImplementation()!);
    await restarted.execute(runId,'python',{},[],300);
    expect(command.mock.calls.filter(c=>c[0][0]==='create')).toHaveLength(1);
  });
  it('exports final artifacts before releasing and refuses reuse after release', async () => {
    const {sandbox,command}=harness(); const save=vi.fn();
    await sandbox.execute(runId,'python',{},[],300); await sandbox.release(runId,save);
    expect(save).toHaveBeenCalledWith([file('answer','42')]);
    expect(command.mock.calls.some(c=>c[0][0]==='rm')).toBe(true);
    expect(await sandbox.pendingRuns()).toEqual([]);
    await expect(sandbox.execute(runId,'python',{},[],300)).rejects.toThrow(/released/);
  });
  it('fails closed on Docker failure and remote TCP endpoints', async () => {
    const {sandbox,command}=harness(); command.mockRejectedValue(new SandboxError('Docker unavailable'));
    await expect(sandbox.execute(runId,'python',{},[],300)).rejects.toThrow(/unavailable/);
    expect((await sandbox.health()).ready).toBe(false);
    vi.stubEnv('DOCKER_HOST','tcp://remote:2375');
    await expect(new DockerSandbox(config,root).imageId()).rejects.toThrow(/local Unix/);
  });
  it('never silently rebuilds a deleted Run environment', async () => {
    const {sandbox,disappear}=harness(); await sandbox.execute(runId,'python',{},[],300); disappear();
    await expect(sandbox.execute(runId,'python',{},[],300)).rejects.toThrow(/removed externally/);
  });
  it('stops the entire container on unknown execution, preserving its filesystem for recovery', async () => {
    const {sandbox,command,response}=harness(); await sandbox.execute(runId,'python',{},[],300);
    response.status='unknown'; await sandbox.execute(runId,'python',{},[],300);
    expect(command.mock.calls.at(-1)?.[0][0]).toBe('kill');
    expect(command.mock.calls.some(c=>c[0][0]==='rm')).toBe(false);
  });
  it('blocks execution if container stop cannot be confirmed', async () => {
    const {sandbox,command,response}=harness(); await sandbox.execute(runId,'python',{},[],300);
    response.status='unknown'; const implementation=command.getMockImplementation()!;
    command.mockImplementation(async (...args:any[])=>args[0][0]==='kill' ? {code:1,stdout:'',stderr:'engine failed'} : implementation(...args));
    await expect(sandbox.execute(runId,'python',{},[],300)).rejects.toThrow(/stop/);
    command.mockClear(); await expect(sandbox.execute(runId,'python',{},[],300)).rejects.toThrow(/stop/);
    expect(command).not.toHaveBeenCalled();
  });
  it('retains the environment if artifact export cannot be committed', async () => {
    const {sandbox,command}=harness(); await sandbox.execute(runId,'python',{},[],300);
    await expect(sandbox.release(runId,async()=>{throw new Error('disk full');})).rejects.toThrow('disk full');
    expect(command.mock.calls.some(c=>c[0][0]==='rm')).toBe(false);
  });
  it('reads whether this Run still has a machine without creating or starting one', async () => {
    const sandbox = new DockerSandbox(config, root);
    const command = vi.spyOn(sandbox as any, 'command').mockRejectedValue(new Error('describe must not call docker'));
    const owner = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const name = `aeeis-${owner}-${runId.slice(4)}`;
    const file = join(root, 'sandboxes', `${runId}.json`);
    const record = { runId, name, network: `${name}-net`, image, policy: 'policy', createdAt: Date.now(), ready: true, released: false };
    expect(await sandbox.describe(runId)).toBeUndefined();
    expect(await sandbox.describe('not-a-run')).toBeUndefined();
    await expect(stat(join(root, 'sandboxes'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'sandboxes'), { recursive: true });
    await writeFile(file, JSON.stringify(record));
    expect(await sandbox.describe(runId)).toEqual({ state: 'present', ready: true });
    expect(await sandbox.pendingRuns()).toEqual([{ runId, expired: false }]);
    await writeFile(file, JSON.stringify({ ...record, ready: false }));
    expect(await sandbox.describe(runId)).toEqual({ state: 'present', ready: false });
    await writeFile(file, JSON.stringify({ ...record, ready: true, released: true }));
    expect(await sandbox.describe(runId)).toEqual({ state: 'released', ready: false });
    expect(await sandbox.pendingRuns()).toEqual([]);
    await writeFile(file, JSON.stringify({ ...record, name: 'aeeis-other' }));
    await expect(sandbox.describe(runId)).rejects.toThrow(/identity mismatch/);
    expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('aeeis-other');
    expect(command).not.toHaveBeenCalled();
  });
});

describe('gateway persistence and receipts (mocked sandbox)', () => {
  let gateway: LocalToolGateway, filename: string, runId: string;
  const request = (overrides: Partial<ToolInvocation> = {}): ToolInvocation => ({ toolId: 'python', toolVersion: '3', taskId: 'task', purpose: 'test', input: { code: 'print(42)' }, capabilityGrant: `run:${runId}:python`, idempotencyKey: `${runId}:${randomUUID()}`, timeoutMs: 1000, ...overrides });
  beforeEach(async () => {
    filename = join(root, 'config.json'); runId = `run_${randomUUID()}`;
    await writeFile(filename, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: 'work', stateDirectory: 'state', tools: ['python', 'web-fetch'], defaultAllowedTools: ['python'], webHosts: ['weather.example'] }));
    gateway = await LocalToolGateway.load(filename);
  });
  afterEach(async () => { await gateway.close(); vi.unstubAllGlobals(); });
  it('never executes code on the host when the sandbox is unavailable', async () => {
    const execute = vi.spyOn(DockerSandbox.prototype, 'execute').mockRejectedValue(new SandboxError('Docker unavailable'));
    const call = request();
    const result = await gateway.invoke(call);
    expect(result.status).toBe('failed'); expect(result.outputRefs).toEqual([]);
    expect(await gateway.invoke(call)).toEqual(result); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('persists partial changes with unknown status and never replays the invocation', async () => {
    const execute = vi.spyOn(DockerSandbox.prototype, 'execute').mockResolvedValue({ schemaVersion: 'sandbox-output/2', status: 'unknown', output: { error: 'timeout' }, files: [file('partial.txt')] });
    const call = request(), result = await gateway.invoke(call);
    expect(result.status).toBe('unknown'); expect(result.outputRefs).toEqual([]);
    expect(await readFile(join(root, 'work', runId, 'artifacts', 'partial.txt'), 'utf8')).toBe('hello');
    const restarted = await LocalToolGateway.load(filename);
    expect(await restarted.invoke(call)).toEqual(result);
    expect(await restarted.reconcile(call, result.receipt)).toEqual(result);
    expect(execute).toHaveBeenCalledTimes(1); await restarted.close();
  });
  it('preserves the prior workspace when a sandbox rejects its snapshot', async () => {
    await commitSnapshot(join(root, 'work', runId), [file('before')], 100);
    vi.spyOn(DockerSandbox.prototype, 'execute').mockResolvedValue({ schemaVersion: 'sandbox-output/2', status: 'unknown', output: { error: 'symlink' }, files: null });
    expect((await gateway.invoke(request())).status).toBe('unknown');
    expect(await readSnapshot(join(root, 'work', runId), 100)).toEqual([file('before')]);
  });
  it('invalidates the catalog when sandbox image or policy changes', async () => {
    const identity = vi.spyOn(DockerSandbox.prototype, 'imageId').mockResolvedValue(image);
    const first = await gateway.listTools();
    expect(first[0]?.version).toBe('3');
    identity.mockResolvedValue(`sha256:${'b'.repeat(64)}`);
    expect(await gateway.listTools()).not.toEqual(first);
  });
  it('rejects stale versions, invalid grants and legacy host execution configuration', async () => {
    const execute = vi.spyOn(DockerSandbox.prototype, 'execute');
    expect((await gateway.invoke(request({ toolVersion: '1' }))).status).toBe('failed');
    expect((await gateway.invoke(request({ capabilityGrant: `run:${runId}:read` }))).status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    const config = JSON.parse(await readFile(filename, 'utf8')); config.pythonCommand = 'python3';
    await writeFile(filename, JSON.stringify(config));
    await expect(LocalToolGateway.load(filename)).rejects.toThrow();
  });
  it('describes a Run machine through the gateway without executing it', async () => {
    const described = vi.spyOn(DockerSandbox.prototype, 'describe').mockResolvedValue({ state: 'present', ready: true });
    const execute = vi.spyOn(DockerSandbox.prototype, 'execute');
    expect(await gateway.describe(runId)).toEqual({ state: 'present', ready: true });
    expect(described).toHaveBeenCalledWith(runId);
    expect(execute).not.toHaveBeenCalled();
  });
  it('keeps HTTPS allowlist validation independent of Python networking', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('weather')); vi.stubGlobal('fetch', fetcher);
    const call = (url: string) => request({ toolId: 'web-fetch', toolVersion: '1', capabilityGrant: `run:${runId}:web-fetch`, input: { input: url } });
    expect((await gateway.invoke(call('https://weather.example/data'))).status).toBe('completed');
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe('error'); fetcher.mockClear();
    for (const url of ['http://weather.example', 'https://other.example', 'https://u:p@weather.example', 'https://weather.example:9999']) expect((await gateway.invoke(call(url))).status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('remote and proxied sandboxes (mocked transport)', () => {
  const runId = `run_${'b'.repeat(36)}`;
  const proxied = sandboxConfigSchema.parse({ ssh: 'vps-test-1', network: 'proxied', egressHosts: ['registry.npmjs.org', '*.pythonhosted.org'] });
  it('runs docker on the SSH host with every argument quoted for the remote shell', () => {
    const call = dockerInvocation(proxied, ['exec', 'name', 'sh', '-c', "echo 'hi'; rm -rf /"]);
    expect(call.command).toBe('ssh');
    expect(call.args.slice(0, 10)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', 'vps-test-1', '--']);
    expect(call.args.slice(10)).toEqual(['docker', "'exec'", "'name'", "'sh'", "'-c'", `'echo '\\''hi'\\''; rm -rf /'`]);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(dockerInvocation(config, ['info'], [])).toEqual({ command: 'docker', args: ['info'] });
  });
  it('reuses one SSH connection per host through a private control socket', () => {
    const call = dockerInvocation(proxied, ['ps'], [], sshControlDirectory(501));
    const host = call.args.indexOf('vps-test-1');
    expect(call.args.slice(0, host)).toEqual(expect.arrayContaining(['ControlMaster=auto', 'ControlPath=/tmp/aeeis-ssh-501/%C', 'ControlPersist=300']));
    expect(call.args.slice(host)).toEqual(['vps-test-1', '--', 'docker', "'ps'"]);
    expect(dockerInvocation(proxied, ['ps'], []).args.join(' ')).not.toContain('ControlMaster');
  });
  it('rejects configurations that would leave the proxy open or ambiguous', () => {
    expect(() => sandboxConfigSchema.parse({ network: 'proxied', ports: [3000] })).toThrow(/bridge network/);
    expect(() => sandboxConfigSchema.parse({ network: 'bridge', egressHosts: ['pypi.org'] })).toThrow(/proxied network/);
    expect(() => sandboxConfigSchema.parse({ ssh: 'vps', context: 'other' })).toThrow(/either ssh/);
    for (const host of ['localhost', '10.0.0.1', 'pypi.org:443', '*.org', 'exa mple.com']) expect(() => sandboxConfigSchema.parse({ network: 'proxied', egressHosts: [host] })).toThrow();
  });
  it('puts the Run on an internal network whose only way out is a locked-down proxy, and removes both on release', async () => {
    const sandbox = new DockerSandbox(proxied, root);
    const containers = new Map<string, any>(), networks = new Map<string, any>();
    const response = { schemaVersion: 'sandbox-output/2', status: 'completed', output: {}, files: [] };
    const command = vi.spyOn(sandbox as any, 'command').mockImplementation(async (...values: any[]) => {
      const args = values[0] as string[];
      if (args[0] === 'context') throw new Error('an SSH sandbox must not look for a local socket');
      if (args[0] === 'image') return ok(`${image} linux`);
      if (args[0] === 'network' && args[1] === 'create') { networks.set(args.at(-1)!, { Labels: { 'aeeis.owner': args[3]!.split('=')[1], 'aeeis.sandbox': '2' } }); return ok('n'); }
      if (args[0] === 'network' && args[1] === 'inspect') return networks.has(args[2]!) ? ok(JSON.stringify([networks.get(args[2]!)])) : { code: 1, stdout: '', stderr: 'network not found' };
      if (args[0] === 'network' && args[1] === 'rm') { networks.delete(args[2]!); return ok(); }
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1]!;
        const labels = Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1]!.split('=')] : []));
        containers.set(name, { Id: (name.endsWith('-proxy') ? 'd' : 'c').repeat(64), Image: image, Config: { Labels: labels }, State: { Running: false } });
        return ok(containers.get(name).Id);
      }
      if (args[0] === 'inspect') { const info = containers.get(args.at(-1)!); return info ? ok(JSON.stringify([info])) : { code: 1, stdout: '', stderr: 'No such container' }; }
      if (args[0] === 'start' || args[0] === 'kill') { const info = containers.get(args[1]!); if (info) info.State.Running = args[0] === 'start'; return ok(); }
      if (args[0] === 'rm') { containers.delete(args.at(-1)!); return ok(); }
      if (args[0] === 'exec') return ok(JSON.stringify(response));
      return ok();
    });
    await sandbox.execute(runId, 'shell', { command: 'npm install' }, [], 300);
    const calls = command.mock.calls.map(call => call[0] as string[]);
    const name = [...containers.keys()].find(key => !key.endsWith('-proxy'))!;
    expect(calls.find(args => args[1] === 'create' && args.at(-1) === `${name}-net`)).toContain('--internal');
    expect(calls.find(args => args[1] === 'create' && args.at(-1) === `${name}-egress`)).not.toContain('--internal');
    const proxy = calls.find(args => args[0] === 'create' && args.includes(`${name}-proxy`))!;
    expect(proxy).toEqual(proxyCreateArgs(proxied, name, image, createHash('sha256').update(root).digest('hex').slice(0, 16), runId));
    expect(proxy).toEqual(expect.arrayContaining(['--cap-drop=ALL', '--read-only', '--user=65534:65534', `--network=${name}-egress`, 'AEEIS_EGRESS_HOSTS=registry.npmjs.org,*.pythonhosted.org']));
    expect(calls).toContainEqual(['network', 'connect', '--alias', 'aeeis-proxy', `${name}-net`, `${name}-proxy`]);
    const run = calls.find(args => args[0] === 'create' && args.includes(name))!;
    expect(run).toEqual(expect.arrayContaining([`--network=${name}-net`, 'HTTPS_PROXY=http://aeeis-proxy:3128', 'NO_PROXY=localhost,127.0.0.1']));
    expect(run).not.toContain('--publish');
    // The proxy is started before the Run container, and again whenever the Run resumes.
    expect(calls.findIndex(args => args[0] === 'start' && args[1] === `${name}-proxy`)).toBeLessThan(calls.findIndex(args => args[0] === 'start' && args[1] === name));
    // A warm call only checks the container and runs the tool: no proxy start, no readiness probe.
    command.mockClear();
    await sandbox.execute(runId, 'shell', { command: 'true' }, [], 300);
    expect(command.mock.calls.map(call => (call[0] as string[]).slice(0, 2))).toEqual([['inspect', '--type=container'], ['exec', '--interactive']]);
    // After the container stopped (idle expiry, daemon restart), the proxy and the tool service are started and probed again.
    containers.get(name).State.Running = false; command.mockClear();
    await sandbox.execute(runId, 'shell', { command: 'true' }, [], 300);
    expect(command.mock.calls.map(call => (call[0] as string[]).slice(0, 2))).toEqual([['inspect', '--type=container'], ['start', `${name}-proxy`], ['start', name], ['exec', name], ['exec', '--interactive']]);
    await sandbox.release(runId, async () => undefined);
    expect(containers.size).toBe(0); expect(networks.size).toBe(0);
  });
});

describe('browser tool pages', () => {
  const load = async (sandbox: object) => {
    const filename = join(root, 'browser.json');
    await writeFile(filename, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: 'work', stateDirectory: 'state', tools: ['browser'], sandbox }));
    return LocalToolGateway.load(filename);
  };
  const open = (gateway: LocalToolGateway, url: string) => {
    const runId = `run_${randomUUID()}`;
    return gateway.invoke({ toolId: 'browser', toolVersion: '3', taskId: 'task', purpose: 'test', input: { url }, capabilityGrant: `run:${runId}:browser`, idempotencyKey: `${runId}:1`, timeoutMs: 1000 });
  };
  it('opens local dev servers, allowed hosts only through the proxy, and nothing else', async () => {
    const execute = vi.spyOn(DockerSandbox.prototype, 'execute').mockResolvedValue({ schemaVersion: 'sandbox-output/2', status: 'completed', output: { title: 'ok' }, files: [] });
    const proxiedGateway = await load({ network: 'proxied', egressHosts: ['docs.example.com', '*.cdn.example'] });
    const isolated = await load({ network: 'none' });
    try {
      expect((await open(proxiedGateway, 'http://127.0.0.1:3000/')).status).toBe('completed');
      expect((await open(proxiedGateway, 'https://docs.example.com/a')).status).toBe('completed');
      expect((await open(proxiedGateway, 'https://img.cdn.example/x.png')).status).toBe('completed');
      for (const [gateway, url, message] of [
        [proxiedGateway, 'https://evil.example/', /not in the sandbox's allowed hosts/],
        [proxiedGateway, 'https://cdn.example/', /not in the sandbox's allowed hosts/],
        [proxiedGateway, 'https://user:pass@docs.example.com/', /credentials/],
        [proxiedGateway, 'file:///etc/passwd', /http:\/\/ or https:\/\//],
        [isolated, 'https://docs.example.com/', /no network/],
      ] as const) {
        const result = await open(gateway, url);
        expect(result.status).toBe('failed'); expect(JSON.stringify(result.output)).toMatch(message);
      }
      expect(execute).toHaveBeenCalledTimes(3);
    } finally { await proxiedGateway.close(); await isolated.close(); }
  });
});

describe('Run egress proxy (python, no Docker)', () => {
  const ask = (port: number, head: string) => new Promise<string>((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.write(head));
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data)); socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); resolve(data); });
  });
  it('refuses hosts outside the list, other ports, IP literals and allowed names that resolve to private addresses', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn('python3', ['-I', '-u', join(process.cwd(), 'sandbox/proxy.py')], { env: { PATH: process.env.PATH!, AEEIS_EGRESS_HOSTS: 'localhost,*.allowed.test', AEEIS_PROXY_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
    const lines: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => { child.stdout!.on('data', chunk => { lines.push(...String(chunk).trim().split('\n')); if (lines.some(line => line.includes('"ready"'))) resolve(); }); child.once('exit', () => reject(new Error('proxy exited'))); });
      expect(await ask(port, 'CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n')).toMatch(/^HTTP\/1.1 403 .*not in this Run's allowed hosts/s);
      expect(await ask(port, 'CONNECT localhost:22 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1.1 403 Only HTTPS on port 443/);
      expect(await ask(port, 'CONNECT localhost:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1.1 403 .*non-public address/s);
      expect(await ask(port, 'GET http://169.254.169.254/latest HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n')).toMatch(/^HTTP\/1.1 403/);
      expect(await ask(port, 'CONNECT allowed.test:443 HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1.1 403 .*not in this Run's allowed hosts/s);
      expect(await ask(port, 'GET /relative HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1.1 400/);
      const decisions = lines.map(line => JSON.parse(line)).filter(entry => entry.decision === 'deny').map(entry => [entry.host, entry.reason]);
      expect(decisions).toEqual([['evil.example', 'not allowlisted'], ['localhost', 'port'], ['localhost', 'Host resolves to a non-public address'], ['169.254.169.254', 'not allowlisted'], ['allowed.test', 'not allowlisted']]);
    } finally { child.kill(); }
  });
});

describe('SSH host paused or unreachable (mocked transport)', () => {
  const remote = sandboxConfigSchema.parse({ ssh: 'vps-test-1' });
  const runA = `run_${'c'.repeat(36)}`, runB = `run_${'d'.repeat(36)}`;
  const harness = () => {
    const sandbox = new DockerSandbox(remote, root);
    const host = { down: false, dropDuringTool: false };
    const containers = new Map<string, any>(), networks = new Map<string, any>();
    const response = { schemaVersion: 'sandbox-output/2', status: 'completed', output: { ok: true }, files: [] };
    const command = vi.spyOn(sandbox as any, 'command').mockImplementation(async (...values: any[]) => {
      const args = values[0] as string[];
      if (host.down) throw new SandboxUnreachable('vps-test-1', 'ssh: connect to host ssh.example port 2222: Connection refused');
      if (args[0] === 'image') return ok(`${image} linux`);
      if (args[0] === 'network' && args[1] === 'create') { networks.set(args.at(-1)!, { Labels: { 'aeeis.owner': args[3]!.split('=')[1], 'aeeis.sandbox': '2' } }); return ok('n'); }
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name') + 1]!;
        const labels = Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1]!.split('=')] : []));
        containers.set(name, { Id: 'e'.repeat(64), Image: image, Config: { Labels: labels }, State: { Running: false } });
        return ok('e'.repeat(64));
      }
      if (args[0] === 'inspect') { const info = containers.get(args.at(-1)!); return info ? ok(JSON.stringify([info])) : { code: 1, stdout: '', stderr: 'No such container' }; }
      if (args[0] === 'start' || args[0] === 'kill') { const info = containers.get(args[1]!); if (info) info.State.Running = args[0] === 'start'; return ok(); }
      if (args[0] === 'exec' && args.includes('--interactive') && host.dropDuringTool && !values[2]?.includes('__restore')) { host.down = true; throw new SandboxUnreachable('vps-test-1', 'Connection reset by peer'); }
      if (args[0] === 'exec') return ok(JSON.stringify(response));
      return ok();
    });
    return { sandbox, host, command };
  };
  const outcome = (promise: Promise<unknown>) => promise.then(() => 'completed', (error: SandboxError) => `${error.outcome}: ${error.message}`);

  it('fails a first call cleanly when the host is down, without leaving a half-created Run', async () => {
    const { sandbox, host } = harness(); host.down = true;
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toMatch(/^failed: .*unreachable over SSH; it may be paused/);
    expect(await sandbox.describe(runA)).toBeUndefined();
    host.down = false;
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toBe('completed');
  });
  it('treats a pause between tool calls as "did not run" and recovers on resume without blocking other Runs', async () => {
    const { sandbox, host } = harness();
    await sandbox.execute(runA, 'shell', {}, [], 300);
    host.down = true;
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toMatch(/^failed: .*unreachable/);
    host.down = false;
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toBe('completed');
    expect(await outcome(sandbox.execute(runB, 'shell', {}, [], 300))).toBe('completed');
  });
  it('keeps a call cut off mid-tool unknown, holds only that Run, and stops its container first once the host is back', async () => {
    const { sandbox, host, command } = harness();
    await sandbox.execute(runA, 'shell', {}, [], 300);
    await sandbox.execute(runB, 'shell', {}, [], 300);
    host.dropDuringTool = true;
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toMatch(/^unknown: .*This Run waits until its container can be stopped/);
    host.dropDuringTool = false;
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toMatch(/^failed: .*waits/);
    host.down = false;
    expect(await outcome(sandbox.execute(runB, 'shell', {}, [], 300))).toBe('completed');
    command.mockClear();
    expect(await outcome(sandbox.execute(runA, 'shell', {}, [], 300))).toBe('completed');
    const owner = createHash('sha256').update(root).digest('hex').slice(0, 16);
    expect(command.mock.calls[0]![0]).toEqual(['kill', `aeeis-${owner}-${runA.slice(4)}`]);
  });
  it('turns a real ssh failure (exit 255) into an unreachable-host error', async () => {
    const sandbox = new DockerSandbox(sandboxConfigSchema.parse({ ssh: 'aeeis-test-no-such-host.invalid' }), root);
    const error = await sandbox.imageId().catch(value => value);
    expect(error).toBeInstanceOf(SandboxUnreachable);
    expect(error.message).toMatch(/aeeis-test-no-such-host.invalid is unreachable/);
    expect((await sandbox.health()).detail).toMatch(/unreachable over SSH/);
  }, 30000);
});

describe('renewing a refused SSH login', () => {
  const refused = () => new SandboxUnreachable('vps-test-1', 'm_1@ssh.example: Permission denied (publickey).');
  const sandboxWith = (sshLoginCommand: string[]) => new DockerSandbox(sandboxConfigSchema.parse({ ssh: 'vps-test-1', sshLoginCommand }), root);
  const call = (sandbox: DockerSandbox) => (sandbox as any).command(['ps'], 1000);
  it('runs the login command once and retries, because a refused login ran nothing remotely', async () => {
    const sandbox = sandboxWith(['true']);
    const transport = vi.spyOn(sandbox as any, 'transport').mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused()).mockResolvedValue(ok('done'));
    const results = await Promise.all([call(sandbox), call(sandbox)]);
    expect(results.map(result => result.stdout)).toEqual(['done', 'done']);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it('gives up with the original error when renewing fails, and does not rerun it for a minute', async () => {
    const sandbox = sandboxWith(['false']);
    const transport = vi.spyOn(sandbox as any, 'transport').mockRejectedValue(refused());
    await expect(call(sandbox)).rejects.toThrow(/refused the SSH login/);
    const refresh = vi.spyOn(sandbox as any, 'refreshLogin');
    await expect(call(sandbox)).rejects.toThrow(/refused the SSH login/);
    expect(await refresh.mock.results[0]!.value).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('does not renew or retry when the host is simply unreachable', async () => {
    const sandbox = sandboxWith(['true']);
    const transport = vi.spyOn(sandbox as any, 'transport').mockRejectedValue(new SandboxUnreachable('vps-test-1', 'ssh: connect to host ssh.example port 2222: Operation timed out'));
    const refresh = vi.spyOn(sandbox as any, 'refreshLogin');
    await expect(call(sandbox)).rejects.toThrow(/unreachable over SSH/);
    expect(refresh).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
    expect(() => sandboxConfigSchema.parse({ sshLoginCommand: ['true'] })).toThrow(/needs ssh/);
  });
});
