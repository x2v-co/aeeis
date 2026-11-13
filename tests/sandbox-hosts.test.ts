import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerSandbox, sandboxConfigSchema } from '../src/docker-sandbox.js';
import { hostConfigs, localToolsConfigSchema, LocalToolGateway } from '../src/local-tools.js';
import type { ToolInvocation } from '../src/integrations.js';

const image = `sha256:${'a'.repeat(64)}`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const done = { schemaVersion: 'sandbox-output/2' as const, status: 'completed' as const, output: { stdout: 'ok' }, files: null };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aeeis-sandbox-hosts-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const base = { schemaVersion: 'local-tools/1', workspaceRoot: 'work', stateDirectory: 'state', tools: ['python'],
  sandbox: { network: 'proxied', egressHosts: ['registry.npmjs.org'], previewPorts: [3000], previewCommand: { publish: ['publish', '{port}'], unpublish: ['unpublish', '{port}'] } } };
const named = { ...base, hosts: { instabox: { ssh: 'instabox-box' }, vps: { ssh: 'aeeis-sandbox-2', memoryMiB: 2048 } },
  assign: { default: 'instabox', principals: { 'local/alice': 'vps' } }, perPrincipal: { maxMachines: 2 } };

describe('sandbox host configuration', () => {
  it('gives each host the deployment sandbox with its own access, size and previews', () => {
    const hosts = hostConfigs(localToolsConfigSchema.parse(named));
    expect([...hosts.keys()]).toEqual(['instabox', 'vps']);
    expect(hosts.get('instabox')).toMatchObject({ ssh: 'instabox-box', network: 'proxied', memoryMiB: 1024, egressHosts: ['registry.npmjs.org'] });
    // A host with no preview command of its own shares no previews.
    expect(hosts.get('instabox')).toMatchObject({ previewPorts: [] });
    expect(hosts.get('instabox')?.previewCommand).toBeUndefined();
    expect(hosts.get('vps')).toMatchObject({ ssh: 'aeeis-sandbox-2', memoryMiB: 2048, previewPorts: [] });
    const instabox = { ssh: 'instabox-box', previewPorts: [3000], previewCommand: base.sandbox.previewCommand };
    expect(hostConfigs(localToolsConfigSchema.parse({ ...named, hosts: { ...named.hosts, instabox } })).get('instabox')).toMatchObject({ previewPorts: [3000], previewCommand: base.sandbox.previewCommand });
    // Without hosts, the deployment sandbox is the one host, as before.
    expect([...hostConfigs(localToolsConfigSchema.parse(base)).keys()]).toEqual(['default']);
  });
  it('refuses an assignment to a host that is not configured, and hosts without an assignment', () => {
    expect(() => localToolsConfigSchema.parse({ ...named, assign: { default: 'instabox', principals: { bob: 'missing' } } })).toThrow(/not in hosts/);
    expect(() => localToolsConfigSchema.parse({ ...named, assign: { default: 'nowhere' } })).toThrow(/not in hosts/);
    expect(() => localToolsConfigSchema.parse({ ...named, assign: undefined })).toThrow(/go together/);
    expect(() => localToolsConfigSchema.parse({ ...named, hosts: { instabox: {} } })).toThrow();
  });
});

describe('gateway routing by user', () => {
  const owners = new Map<string, string>();
  const request = (runId: string): ToolInvocation => ({ toolId: 'python', toolVersion: '3', taskId: 'task', purpose: 'test', input: { code: 'print(1)' }, capabilityGrant: `run:${runId}:python`, idempotencyKey: `${runId}:${randomUUID()}`, timeoutMs: 1000 });
  const load = async (config: unknown = named) => {
    const filename = join(root, 'config.json');
    await writeFile(filename, JSON.stringify(config));
    const gateway = await LocalToolGateway.load(filename);
    gateway.principalOf = async runId => owners.has(runId) ? { owner: owners.get(runId)!, tenantId: 'local' } : undefined;
    return gateway;
  };
  const run = (owner: string) => { const id = `run_${randomUUID()}`; owners.set(id, owner); return id; };

  it('runs each user on their assigned host, and everyone else on the default host', async () => {
    const seen: { host: string; principal: string | undefined }[] = [];
    vi.spyOn(DockerSandbox.prototype, 'execute').mockImplementation(async function (this: DockerSandbox, ...args: unknown[]) { seen.push({ host: this.host, principal: args[6] as string | undefined }); return done; });
    const gateway = await load();
    const alice = run('alice'), bob = run('bob');
    expect((await gateway.invoke(request(alice))).status).toBe('completed');
    expect((await gateway.invoke(request(bob))).status).toBe('completed');
    expect(seen.map(item => item.host)).toEqual(['vps', 'instabox']);
    // A hash of the user travels with the call, never the user's own name, and differs per user.
    expect(seen[0]!.principal).toMatch(/^[a-f0-9]{16}$/);
    expect(seen[1]!.principal).toMatch(/^[a-f0-9]{16}$/);
    expect(seen[0]!.principal).not.toBe(seen[1]!.principal);
    expect(await gateway.hostFor(alice)).toBe('vps');
    await gateway.close();
  });
  it('keeps a Run on the host its machine is already on, and older machines on the existing host', async () => {
    const gateway = await load({ ...named, assign: { ...named.assign, existing: 'instabox' } });
    const state = join(root, 'state', 'sandboxes');
    await mkdir(state, { recursive: true });
    const moved = run('alice'), older = run('alice');
    await writeFile(join(state, `${moved}.json`), JSON.stringify({ runId: moved, host: 'instabox' }));
    await writeFile(join(state, `${older}.json`), JSON.stringify({ runId: older }));
    expect(await gateway.hostFor(moved)).toBe('instabox');
    expect(await gateway.hostFor(older)).toBe('instabox');
    expect(await gateway.hostFor(run('alice'))).toBe('vps');
    await gateway.close();
  });
  it('runs nothing, and remembers no host, while the Run\'s user cannot be read', async () => {
    const execute = vi.spyOn(DockerSandbox.prototype, 'execute').mockImplementation(async function (this: DockerSandbox) { return { ...done, output: { host: this.host } }; });
    const gateway = await load();
    const alice = run('alice');
    let down = true;
    const lookup = gateway.principalOf!;
    gateway.principalOf = async runId => { if (down) throw new Error('repository temporarily unavailable'); return lookup(runId); };
    const refused = await gateway.invoke(request(alice));
    expect(refused.status).toBe('failed');
    expect(refused.output).toMatchObject({ error: expect.stringMatching(/whose task/) });
    expect(execute).not.toHaveBeenCalled();
    // A Run the server does not know is refused the same way.
    gateway.principalOf = async () => undefined;
    expect((await gateway.invoke(request(alice))).status).toBe('failed');
    down = false; gateway.principalOf = async runId => { if (down) throw new Error('down'); return lookup(runId); };
    expect((await gateway.invoke(request(alice))).output).toEqual({ host: 'vps' });
    expect(await gateway.hostFor(alice)).toBe('vps');
    await gateway.close();
  });
  it('moves machines made under a single-host configuration to the existing host once hosts are named', async () => {
    // Before: no hosts; this version records the one host as "default".
    vi.spyOn(DockerSandbox.prototype, 'execute').mockImplementation(async function (this: DockerSandbox) { return { ...done, output: { host: this.host } }; });
    const state = join(root, 'state', 'sandboxes');
    await mkdir(state, { recursive: true });
    const earlier = run('alice'), stray = run('alice');
    await writeFile(join(state, `${earlier}.json`), JSON.stringify({ runId: earlier, host: 'default' }));
    await writeFile(join(state, `${stray}.json`), JSON.stringify({ runId: stray, host: 'retired' }));
    // After: named hosts, with the old machine on instabox even though alice is now assigned to the VPS.
    const gateway = await load({ ...named, assign: { ...named.assign, existing: 'instabox' } });
    expect(await gateway.hostFor(earlier)).toBe('instabox');
    expect((await gateway.invoke(request(earlier))).output).toEqual({ host: 'instabox' });
    // A host that is no longer configured is not quietly taken for another one.
    await expect(gateway.hostFor(stray)).rejects.toThrow(/no longer configured/);
    expect((await gateway.invoke(request(stray))).status).toBe('failed');
    await gateway.close();
  });
  it('queues each user apart: one user\'s long call does not hold up another\'s', async () => {
    let finishAlice!: () => void;
    const aliceHolds = new Promise<void>(resolve => { finishAlice = resolve; });
    const order: string[] = [];
    vi.spyOn(DockerSandbox.prototype, 'execute').mockImplementation(async function (this: DockerSandbox, ...args: unknown[]) {
      const id = args[0] as string;
      if (owners.get(id) === 'alice') await aliceHolds;
      order.push(owners.get(id)!); return done;
    });
    // Both users on one host, so only the queue tells them apart.
    const gateway = await load({ ...named, assign: { default: 'instabox' } });
    const slow = gateway.invoke(request(run('alice')));
    const second = gateway.invoke(request(run('alice')));
    await gateway.invoke(request(run('bob')));
    expect(order).toEqual(['bob']);
    finishAlice();
    await Promise.all([slow, second]);
    expect(order).toEqual(['bob', 'alice', 'alice']);
    await gateway.close();
  });
});

describe('machines labelled and limited per user (mocked transport)', () => {
  const harness = (options: ConstructorParameters<typeof DockerSandbox>[2] = {}) => {
    const sandbox = new DockerSandbox(sandboxConfigSchema.parse({ ssh: 'aeeis-sandbox-2', network: 'none' }), root, options);
    const containers = new Map<string, any>();
    const created: string[][] = [];
    const command = vi.spyOn(sandbox as any, 'command').mockImplementation(async (...values: any[]) => {
      const args = values[0] as string[];
      if (args[0] === 'image') return ok(`${image} linux`);
      if (args[0] === 'create') {
        created.push(args);
        const name = args[args.indexOf('--name') + 1]!;
        const labels = Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1]!.split('=')] : []));
        containers.set(name, { Id: 'c'.repeat(64), Image: image, Config: { Labels: labels }, State: { Running: false } });
        return ok('c'.repeat(64));
      }
      if (args[0] === 'inspect') { const info = containers.get(args.at(-1)!); return info ? ok(JSON.stringify([info])) : { code: 1, stdout: '', stderr: 'No such container' }; }
      if (args[0] === 'start') { containers.get(args[1]!).State.Running = true; return ok(); }
      if (args[0] === 'exec' && args.includes('--interactive')) return ok(JSON.stringify(done));
      return ok();
    });
    return { sandbox, command, created, containers };
  };
  const runId = () => `run_${randomUUID()}`;

  it('labels a user\'s machine as theirs and records its host, and finds another user\'s label a mismatch', async () => {
    const { sandbox, created, containers } = harness({ host: 'vps', unlabeled: false });
    const id = runId();
    await sandbox.execute(id, 'python', {}, [], 300, undefined, 'a'.repeat(16));
    expect(created[0]).toEqual(expect.arrayContaining(['--label', `aeeis.principal=${'a'.repeat(16)}`]));
    const record = JSON.parse(await readFile(join(root, 'sandboxes', `${id}.json`), 'utf8'));
    expect(record).toMatchObject({ host: 'vps', principal: 'a'.repeat(16) });
    // Someone relabels the container: it is no longer this user's, so nothing runs in it.
    for (const info of containers.values()) { info.Config.Labels['aeeis.principal'] = 'b'.repeat(16); info.State.Running = false; }
    await expect(sandbox.execute(id, 'python', {}, [], 300, undefined, 'a'.repeat(16))).rejects.toThrow(/ownership/);
  });
  it('treats another host\'s machine as absent, and an unnamed older machine as the existing host\'s', async () => {
    const vps = harness({ host: 'vps', unlabeled: false });
    const id = runId();
    await vps.sandbox.execute(id, 'python', {}, [], 300);
    expect(await vps.sandbox.describe(id)).toEqual({ state: 'present', ready: true });
    const instabox = new DockerSandbox(sandboxConfigSchema.parse({ ssh: 'instabox-box', network: 'none' }), root, { host: 'instabox', unlabeled: true });
    expect(await instabox.describe(id)).toBeUndefined();
    expect(await instabox.pendingRuns()).toEqual([]);
    const record = JSON.parse(await readFile(join(root, 'sandboxes', `${id}.json`), 'utf8'));
    delete record.host;
    await writeFile(join(root, 'sandboxes', `${id}.json`), JSON.stringify(record));
    expect(await instabox.describe(id)).toEqual({ state: 'present', ready: true });
    expect(await vps.sandbox.describe(id)).toBeUndefined();
  });
  it('reserves a machine under the cap as one step, so Runs starting together cannot both get one', async () => {
    const alice = 'a'.repeat(16);
    const vps = harness({ host: 'vps', unlabeled: false, maxRunsPerPrincipal: 1 });
    const instabox = harness({ host: 'instabox', unlabeled: true, maxRunsPerPrincipal: 1 });
    // Hold every host at its first contact, so both creations are in flight at once.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    for (const { command } of [vps, instabox]) {
      const inner = command.getMockImplementation()!;
      command.mockImplementation(async (...values: any[]) => { if (values[0][0] === 'version') await gate; return inner(...values); });
    }
    const session = { id: 's', token: 't', prompt: 'p', argv: [], env: {}, key: 'k', upstream: 'u', budget: 1, seconds: 60 };
    const relay = (sandbox: DockerSandbox) => vi.spyOn(sandbox as any, 'relay').mockResolvedValue({});
    relay(vps.sandbox); relay(instabox.sandbox);
    const configRelay = (sandbox: DockerSandbox) => Object.assign(sandbox.config, { modelRelay: true });
    configRelay(vps.sandbox); configRelay(instabox.sandbox);
    const attempts = Promise.allSettled([
      vps.sandbox.startExecutor(runId(), session, [], undefined, alice),
      vps.sandbox.execute(runId(), 'python', {}, [], 300, undefined, alice),
      instabox.sandbox.execute(runId(), 'python', {}, [], 300, undefined, alice),
    ]);
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    const settled = await attempts;
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(item => item.status === 'rejected').map(item => String((item as PromiseRejectedResult).reason))).toEqual([expect.stringMatching(/already has 1/), expect.stringMatching(/already has 1/)]);
    expect(vps.created.length + instabox.created.length).toBe(1);
  });
  it('treats a machine recorded on the former single host as the existing host\'s, on every host', async () => {
    const id = runId();
    const single = harness();
    await single.sandbox.execute(id, 'python', {}, [], 300);
    expect(JSON.parse(await readFile(join(root, 'sandboxes', `${id}.json`), 'utf8')).host).toBe('default');
    const instabox = new DockerSandbox(sandboxConfigSchema.parse({ ssh: 'instabox-box', network: 'none' }), root, { host: 'instabox', unlabeled: true, formerNames: ['default'] });
    const vps = new DockerSandbox(sandboxConfigSchema.parse({ ssh: 'aeeis-sandbox-2', network: 'none' }), root, { host: 'vps', unlabeled: false, formerNames: ['default'] });
    expect(await instabox.describe(id)).toEqual({ state: 'present', ready: true });
    expect((await instabox.pendingRuns()).map(item => item.runId)).toEqual([id]);
    expect(await vps.describe(id)).toBeUndefined();
  });
  it('caps how many machines one user has at once, across hosts, without affecting other users', async () => {
    const { sandbox, created } = harness({ host: 'vps', unlabeled: false, maxRunsPerPrincipal: 1 });
    const alice = 'a'.repeat(16), bob = 'b'.repeat(16), first = runId();
    await sandbox.execute(first, 'python', {}, [], 300, undefined, alice);
    // Her own machine keeps working.
    await sandbox.execute(first, 'python', {}, [], 300, undefined, alice);
    await expect(sandbox.execute(runId(), 'python', {}, [], 300, undefined, alice)).rejects.toThrow(/already has 1 running machine/);
    await sandbox.execute(runId(), 'python', {}, [], 300, undefined, bob);
    // A machine on another host counts too.
    const other = harness({ host: 'instabox', unlabeled: true, maxRunsPerPrincipal: 1 });
    await expect(other.sandbox.execute(runId(), 'python', {}, [], 300, undefined, alice)).rejects.toThrow(/already has 1/);
    expect(created).toHaveLength(2);
  });
});
