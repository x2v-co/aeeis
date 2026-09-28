import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerSandbox, SandboxError, sandboxConfigSchema, sandboxCreateArgs, dockerContextArgs } from '../src/docker-sandbox.js';
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
  it('keeps HTTPS allowlist validation independent of Python networking', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('weather')); vi.stubGlobal('fetch', fetcher);
    const call = (url: string) => request({ toolId: 'web-fetch', toolVersion: '1', capabilityGrant: `run:${runId}:web-fetch`, input: { input: url } });
    expect((await gateway.invoke(call('https://weather.example/data'))).status).toBe('completed');
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe('error'); fetcher.mockClear();
    for (const url of ['http://weather.example', 'https://other.example', 'https://u:p@weather.example', 'https://weather.example:9999']) expect((await gateway.invoke(call(url))).status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
