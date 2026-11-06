import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeTransport, EXECUTOR_ENDPOINT, RoutedAgentTransport, ensureExecutorAdmitted, executorArgv, executorCard, executorConfigSchema, executorPrompt, type ExecutorSandbox } from '../src/executor.js';
import { AgentDirectory, AgentGateway, type AgentTransport, type DelegationRequest } from '../src/agent-gateway.js';
import { InMemoryGrantLedger } from '../src/agent-ledger.js';
import { createContextPack, type DelegationGrant } from '../src/protocol.js';
import { DockerSandbox, proxyCreateArgs, sandboxConfigSchema } from '../src/docker-sandbox.js';
import { localToolsConfigSchema } from '../src/local-tools.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'aeeis-executor-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

const config = executorConfigSchema.parse({});
const runId = `run_${'a'.repeat(36)}`;
const brief = { schemaVersion: 'task-brief/1', taskId: 'task', goal: 'Add a footer', nonGoals: ['No redesign'], contextManifestId: 'ctx', knownFacts: [], constraints: ['Keep it small'], expectedOutput: 'patch', budget: { tokens: 1000 }, allowedCapabilities: ['code'] };
const request = (overrides: Partial<DelegationRequest> = {}) => ({
  agentId: 'executor.claude-code', taskBrief: brief, mode: 'sync', idempotencyKey: `${runId}:task:1`,
  contextPack: { schemaVersion: 'context-pack/1', id: 'ctx', taskId: 'task', version: 1, audience: ['executor.claude-code'], classification: 'internal', expiresAt: '2099-01-01T00:00:00.000Z', sourceRefs: ['src'], artifactRefs: [], claims: [{ id: 'claim', text: 'The site is static.', evidenceRefs: ['src'] }], redactions: [], digest: 'a'.repeat(64) },
  grant: { budget: { tokens: 1000 } }, ...overrides,
}) as never as DelegationRequest;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const toolUse = line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit' }, { type: 'text', text: 'ok' }] } });
const result = (extra: object = {}) => line({ type: 'result', is_error: false, result: 'Added the footer.', total_cost_usd: 0.02, ...extra });
const usage = (tokens: number) => ({ calls: 1, input: tokens, output: 0, cacheWrite: 0, cacheRead: 0, refused: 0, tokens, budget: 900 });
const poll = (values: Partial<Awaited<ReturnType<ExecutorSandbox['pollExecutor']>>>) => ({ state: 'running' as const, output: '', offset: 0, more: false, exitCode: null, errors: '', ...values });

function fakeSandbox(polls: Array<ReturnType<typeof poll>>, tokens = 100) {
  const sandbox = {
    startExecutor: vi.fn<ExecutorSandbox['startExecutor']>(async () => undefined),
    executorRecord: vi.fn<ExecutorSandbox['executorRecord']>(async () => ({ session: 'session', token: 'token', pid: 42 })),
    pollExecutor: vi.fn<ExecutorSandbox['pollExecutor']>(async () => polls.length > 1 ? polls.shift()! : polls[0]!),
    relayUsage: vi.fn<ExecutorSandbox['relayUsage']>(async () => usage(tokens)),
    closeRelay: vi.fn<ExecutorSandbox['closeRelay']>(async () => usage(tokens)),
    stopExecutor: vi.fn<ExecutorSandbox['stopExecutor']>(async () => undefined),
    observe: vi.fn<ExecutorSandbox['observe']>(async () => ({ state: 'running', previews: [], live: { foreground: null, processes: [], repository: { status: ' M index.html', diff: '+footer', truncated: false }, files: [] } })),
  };
  return sandbox;
}
const transport = (sandbox: ExecutorSandbox, maxMinutes = 60) => new ClaudeCodeTransport(sandbox, { ...config, maxMinutes }, root, () => 'sk-real-key', 1);
const card = executorCard(config);
const context = { runId };

describe('Claude Code as an AEEIS Agent', () => {
  it('starts with a task and a session token, and never the real key', async () => {
    const sandbox = fakeSandbox([poll({ output: toolUse + result(), offset: 10, exitCode: 0 })]);
    await transport(sandbox).submit(card, request(), { runId, workspace: `wg_${'b'.repeat(32)}` });
    const [startedRun, session, workspace] = sandbox.startExecutor.mock.calls[0]!;
    expect(startedRun).toBe(runId); expect(workspace).toBe(`wg_${'b'.repeat(32)}`);
    // The key goes to the relay only: not into the process's arguments or environment.
    expect(session.key).toBe('sk-real-key');
    expect(JSON.stringify([session.argv, session.env, session.prompt])).not.toContain('sk-real-key');
    expect(session.env.ANTHROPIC_API_KEY).toBe(session.token);
    expect(session.token).toMatch(/^aeeis-session-[a-f0-9]{64}$/);
    expect(session.env.ANTHROPIC_BASE_URL).toBe('http://aeeis-proxy:3129');
    expect(session.budget).toBe(900);
    // The task text is never an argument.
    expect(session.argv.join(' ')).not.toContain('Add a footer');
    expect(session.prompt).toContain('Goal: Add a footer'); expect(session.prompt).toContain('- No redesign'); expect(session.prompt).toContain('- The site is static.');
  });
  it('reports what the relay counted and what AEEIS saw, not only what the executor said', async () => {
    const sandbox = fakeSandbox([poll({ output: toolUse + result(), offset: 10, exitCode: 0 })], 321);
    const progress: string[] = [];
    const response = await transport(sandbox).submit(card, request({ onProgress: value => { progress.push(value.message); } }), context);
    expect(response).toMatchObject({ status: 'completed', result: { status: 'completed', claims: [], cost: { tokens: 321, money: 0.02, currency: 'USD' }, unresolved: [expect.stringContaining('not verified')] } });
    expect(response.result!.summary).toContain('Added the footer.'); expect(response.result!.summary).toContain('Changes seen by AEEIS:\nM index.html');
    expect(progress).toEqual(['Using Edit']);
    expect(sandbox.closeRelay).toHaveBeenCalledWith(runId, expect.any(String));
    const session = sandbox.startExecutor.mock.calls[0]![1].id;
    expect(await readFile(join(root, runId, 'executor', `${session}.jsonl`), 'utf8')).toContain('"tool_use"');
    expect(JSON.parse(await readFile(join(root, runId, 'executor', `${session}.evidence.json`), 'utf8'))).toMatchObject({ end: 'finished', usage: { tokens: 321 }, repository: { diff: '+footer' } });
  });
  it('lists recent files when the workspace is not a git repository', async () => {
    const sandbox = fakeSandbox([poll({ output: result(), offset: 5, exitCode: 0 })]);
    sandbox.observe.mockResolvedValue({ state: 'running', previews: [], live: { foreground: null, processes: [], repository: null, files: [{ path: 'module1.js', modifiedAt: '2026-11-06T00:00:00Z' }] } });
    expect((await transport(sandbox).submit(card, request(), context)).result!.summary).toContain('Recent files seen by AEEIS:\nmodule1.js');
  });
  it('stops the session when the budget runs out, and keeps the result partial', async () => {
    const sandbox = fakeSandbox([poll({ output: toolUse, offset: 10 })], 900);
    const response = await transport(sandbox).submit(card, request(), context);
    expect(sandbox.stopExecutor).toHaveBeenCalledWith(runId, 42);
    expect(response).toMatchObject({ status: 'partial' }); expect(response.result!.summary).toContain('token budget ran out');
  });
  it('stops at the wall-clock limit, not counting time the Run was paused', async () => {
    let frozenPolls = 0;
    const sandbox = fakeSandbox([poll({})]);
    const instance = new ClaudeCodeTransport(sandbox, { ...config, maxMinutes: 1 }, root, () => 'key', 1);
    const realNow = Date.now.bind(Date); let shift = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
    sandbox.pollExecutor.mockImplementation(async () => {
      if (frozenPolls < 3) { frozenPolls += 1; shift += 40_000; return poll({ state: 'frozen' }); } // 2 minutes frozen
      shift += 25_000; return poll({});
    });
    const response = await instance.submit(card, request(), context);
    expect(frozenPolls).toBe(3);
    expect(sandbox.pollExecutor.mock.calls.length).toBeGreaterThanOrEqual(5); // it kept going after the frozen time
    expect(response.result!.summary).toContain('1-minute limit');
  });
  it('reports a killed session as unknown, and reconciling reads it instead of running it again', async () => {
    const sandbox = fakeSandbox([poll({ state: 'stopped' })]);
    expect(await transport(sandbox).submit(card, request(), context)).toMatchObject({ status: 'unknown' });
    const session = sandbox.startExecutor.mock.calls[0]![1].id;
    sandbox.executorRecord.mockResolvedValue({ session, token: 'token', pid: 42 });
    sandbox.pollExecutor.mockResolvedValue(poll({ output: result(), offset: 5, exitCode: 0 }));
    const receipt = { status: 'unknown' } as never;
    expect(await transport(sandbox).reconcile(card, request(), receipt, context)).toMatchObject({ status: 'completed' });
    expect(sandbox.startExecutor).toHaveBeenCalledTimes(1);
    sandbox.executorRecord.mockResolvedValue(undefined);
    expect(await transport(sandbox).reconcile(card, request(), receipt, context)).toEqual({ status: 'unknown', receiptRef: expect.any(String) });
  });
  it('fails plainly when the executor exits without a result, or reports an error', async () => {
    const crashed = fakeSandbox([poll({ exitCode: 1, errors: 'boom' })]);
    const response = await transport(crashed).submit(card, request(), context);
    expect(response).toMatchObject({ status: 'failed' }); expect(response.result!.summary).toContain('boom');
    const errored = fakeSandbox([poll({ output: result({ is_error: true, result: 'Credit balance too low' }), offset: 5, exitCode: 1 })]);
    expect(await transport(errored).submit(card, request(), context)).toMatchObject({ status: 'partial' });
  });
  it('refuses to start without a key, a budget or a Run', async () => {
    const sandbox = fakeSandbox([poll({})]);
    await expect(new ClaudeCodeTransport(sandbox, config, root, () => undefined).submit(card, request(), context)).rejects.toThrow(/AEEIS_EXECUTOR_API_KEY/);
    const noBudget = request({ grant: { budget: {} } as never, taskBrief: { ...brief, budget: {} } as never });
    await expect(transport(sandbox).submit(card, noBudget, context)).rejects.toThrow(/token budget/);
    await expect(transport(sandbox).submit(card, request())).rejects.toThrow(/inside a Run/);
    expect(sandbox.startExecutor).not.toHaveBeenCalled();
  });
  it('takes its budget from the Run when the delegation carries none, and the tightest limit otherwise', async () => {
    const bare = { grant: { budget: { calls: 1 } } as never, taskBrief: { ...brief, budget: {} } as never };
    const fromRun = fakeSandbox([poll({ output: result(), offset: 5, exitCode: 0 })]);
    await transport(fromRun).submit(card, request(bare), { runId, tokens: 50_000 });
    expect(fromRun.startExecutor.mock.calls[0]![1].budget).toBe(45_000);
    const tightest = fakeSandbox([poll({ output: result(), offset: 5, exitCode: 0 })]);
    await transport(tightest).submit(card, request(), { runId, tokens: 500 });
    expect(tightest.startExecutor.mock.calls[0]![1].budget).toBe(450);
    await expect(transport(fakeSandbox([poll({})])).submit(card, request(bare), { runId, tokens: 0 })).rejects.toThrow(/token budget/);
  });
  it('limits the executor to its configured tools and ignores project settings', () => {
    const argv = executorArgv(executorConfigSchema.parse({ tools: ['Read', 'Edit'], model: 'claude-sonnet-5-5' }), 'session');
    expect(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 4)).toEqual(['--tools', 'Read,Edit', '--allowedTools', 'Read,Edit']);
    expect(argv).toEqual(expect.arrayContaining(['--setting-sources', 'user', '--strict-mcp-config', '--model', 'claude-sonnet-5-5']));
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(executorPrompt(request())).toContain('Run the tests before you finish');
  });
  it('sends executor cards to the sandbox and all others over the normal transport', async () => {
    const executor = { submit: vi.fn(async () => ({ status: 'completed', receiptRef: 'a' })) } as unknown as AgentTransport;
    const remote = { submit: vi.fn(async () => ({ status: 'completed', receiptRef: 'b' })) } as unknown as AgentTransport;
    const routed = new RoutedAgentTransport(executor, remote);
    expect(card.endpoint).toBe(EXECUTOR_ENDPOINT);
    expect(await routed.submit(card, request(), context)).toMatchObject({ receiptRef: 'a' });
    expect(await routed.submit({ ...card, endpoint: 'https://agent.example' }, request(), context)).toMatchObject({ receiptRef: 'b' });
  });
  it('can be registered again on every start without losing its admission', async () => {
    const directory = new AgentDirectory(join(root, 'agents.json'));
    await ensureExecutorAdmitted(directory, card);
    await ensureExecutorAdmitted(directory, card);
    expect((await directory.get(card.agentId)).agentId).toBe(card.agentId);
    directory.revoke(card.agentId);
    await ensureExecutorAdmitted(directory, card);
    expect(() => directory.get(card.agentId)).toThrow();
  });
});

describe('through the Agent gateway', () => {
  const agentId = card.agentId, future = '2099-01-01T00:00:00.000Z';
  const pack = createContextPack({ schemaVersion: 'context-pack/1', id: 'ctx.executor', taskId: 'task.executor', version: 1, audience: [agentId], classification: 'internal', expiresAt: future, sourceRefs: ['src.brief'], artifactRefs: [], claims: [{ id: 'claim.one', text: 'The site is static.', evidenceRefs: ['src.brief'] }], redactions: [] });
  const grant: DelegationGrant = { schemaVersion: 'delegation-grant/1', grantId: 'grant.executor', subjectAgentId: agentId, issuerAgentId: 'aeeis', taskId: 'task.executor', purpose: 'Fix the bug', actions: ['return_result'], resourceRefs: [], dataScope: 'internal', issuedAt: '2026-11-06T00:00:00.000Z', expiresAt: future, budget: { tokens: 1000 }, delegationChain: [], revocationRef: 'revocation.executor', nonce: 'n'.repeat(16) };
  const delegation = (key = `${runId}:task:gateway`) => ({ agentId, taskBrief: { ...brief, taskId: 'task.executor', contextManifestId: 'ctx.executor' } as never, contextPack: pack, grant, mode: 'sync' as const, idempotencyKey: key });
  const gateway = async (sandbox: ExecutorSandbox) => {
    const directory = new AgentDirectory(join(root, 'gateway-agents.json'));
    await ensureExecutorAdmitted(directory, card);
    return new AgentGateway(directory, new RoutedAgentTransport(transport(sandbox), { submit: async () => { throw new Error('must not leave this host'); } }), new InMemoryGrantLedger());
  };
  it('passes the gateway\'s validation as a real Agent result, with the Run beside the request', async () => {
    const sandbox = fakeSandbox([poll({ output: toolUse + result(), offset: 10, exitCode: 0 })], 321);
    const outcome = await (await gateway(sandbox)).delegate(delegation(), { runId, workspace: `wg_${'c'.repeat(32)}` });
    expect(outcome).toMatchObject({ status: 'completed', result: { agentId, cost: { tokens: 321 }, claims: [], unresolved: [expect.stringContaining('not verified')] } });
    expect(sandbox.startExecutor.mock.calls[0]![0]).toBe(runId);
    expect(sandbox.startExecutor.mock.calls[0]![2]).toBe(`wg_${'c'.repeat(32)}`);
  });
  it('passes a budget stop and a lost session through as partial and unknown', async () => {
    const stopped = fakeSandbox([poll({ output: toolUse, offset: 10 })], 900);
    expect((await (await gateway(stopped)).delegate(delegation(`${runId}:task:budget`), { runId })).status).toBe('partial');
    const lost = fakeSandbox([poll({ state: 'stopped' })]);
    expect((await (await gateway(lost)).delegate(delegation(`${runId}:task:lost`), { runId })).status).toBe('unknown');
  });
  it('holds a result that overran the grant for a person to look at', async () => {
    const over = fakeSandbox([poll({ output: result(), offset: 5, exitCode: 0 })], 1500);
    const outcome = await (await gateway(over)).delegate(delegation(`${runId}:task:over`), { runId }).catch(error => ({ status: 'threw', error: String(error) }));
    expect(JSON.stringify(outcome)).toMatch(/unknown|budget|exceed/i);
    expect(outcome.status).not.toBe('completed');
  });
});

describe('sandbox configuration for the executor', () => {
  it('needs the relay, and the relay needs the proxied network', () => {
    expect(() => sandboxConfigSchema.parse({ modelRelay: true })).toThrow(/proxied network/);
    expect(() => localToolsConfigSchema.parse({ schemaVersion: 'local-tools/1', workspaceRoot: 'w', stateDirectory: 's', tools: ['shell'], executor: {} })).toThrow(/modelRelay/);
  });
  it('gives the proxy a private place for the control socket', () => {
    const args = proxyCreateArgs(sandboxConfigSchema.parse({ network: 'proxied', modelRelay: true }), 'n', 'image', 'owner');
    expect(args).toEqual(expect.arrayContaining(['AEEIS_RELAY=1', '/run/aeeis:rw,size=1m,uid=65534,gid=65534,mode=0700']));
  });
  it('sends the real key on stdin, never as an argument', async () => {
    const sandbox = new DockerSandbox(sandboxConfigSchema.parse({ network: 'proxied', modelRelay: true, ssh: 'vps', sshWaitSeconds: 0 }), root);
    const image = `sha256:${'a'.repeat(64)}`;
    let info: any;
    const command = vi.spyOn(sandbox as any, 'command').mockImplementation(async (...values: any[]) => {
      const args = values[0] as string[];
      if (args[0] === 'image') return { code: 0, stdout: `${image} linux`, stderr: '' };
      if (args[0] === 'create' && !args.some(item => item.endsWith('-proxy'))) { info = { Id: 'c'.repeat(64), Image: image, Config: { Labels: Object.fromEntries(args.flatMap((a, i) => a === '--label' ? [args[i + 1]!.split('=')] : [])) }, State: { Running: false } }; return { code: 0, stdout: info.Id, stderr: '' }; }
      if (args[0] === 'create') return { code: 0, stdout: 'd'.repeat(64), stderr: '' };
      if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([info]), stderr: '' };
      if (args[0] === 'start') { if (info) info.State.Running = true; return { code: 0, stdout: '', stderr: '' }; }
      if (args.includes('/opt/aeeis/relay_ctl.py')) return { code: 0, stdout: '{"opened":true}', stderr: '' };
      if (args[0] === 'exec' && args.includes('--interactive')) return { code: 0, stdout: JSON.stringify({ schemaVersion: 'sandbox-output/2', status: 'completed', output: { pid: 7 }, files: [] }), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await sandbox.startExecutor(runId, { id: 'session', token: 'session-token', prompt: 'p', argv: ['claude'], env: {}, key: 'sk-real-key', upstream: 'https://api.anthropic.com', budget: 900, seconds: 60 }, []);
    const calls = command.mock.calls as unknown as [string[], number, string?][];
    expect(calls.some(call => call[0].join(' ').includes('sk-real-key'))).toBe(false);
    expect(calls.find(call => call[0].includes('/opt/aeeis/relay_ctl.py'))![2]).toContain('sk-real-key');
    expect(await sandbox.executorRecord(runId)).toEqual({ session: 'session', token: 'session-token', pid: 7 });
  });
});

describe('model relay (python, no Docker)', () => {
  let upstream: Server, proxy: ChildProcess, relayPort: number, socketPath: string, seen: { key?: string; path?: string; body?: string }[];
  const free = () => new Promise<number>(resolve => { const server = createNetServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address() as AddressInfo; server.close(() => resolve(port)); }); });
  const control = (message: object) => new Promise<any>((resolve, reject) => {
    const socket = connect(socketPath, () => socket.end(JSON.stringify(message)));
    let data = ''; socket.on('data', chunk => { data += chunk; }); socket.on('close', () => resolve(JSON.parse(data))); socket.on('error', reject);
  });
  const call = (token: string, path = '/v1/messages', body = '{"model":"m","stream":true}') => fetch(`http://127.0.0.1:${relayPort}${path}`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body });
  beforeEach(async () => {
    seen = [];
    upstream = createHttpServer((incoming, response) => {
      let body = ''; incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => {
        seen.push({ ...(typeof incoming.headers['x-api-key'] === 'string' ? { key: incoming.headers['x-api-key'] } : {}), ...(incoming.url ? { path: incoming.url } : {}), body });
        if (body.includes('"stream":false')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ content: [], usage: { input_tokens: 7, output_tokens: 3 } })); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":1000,"output_tokens":1}}}\n\n');
        response.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}\n\n');
        response.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n');
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    relayPort = await free(); socketPath = join(root, 'r.sock');
    proxy = spawn('python3', ['-I', '-u', join(process.cwd(), 'sandbox/proxy.py')], { env: { PATH: process.env.PATH!, AEEIS_RELAY: '1', AEEIS_RELAY_ALLOW_HTTP: '1', AEEIS_RELAY_PORT: String(relayPort), AEEIS_RELAY_SOCKET: socketPath, AEEIS_PROXY_PORT: String(await free()) }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => { proxy.stdout!.on('data', chunk => { if (String(chunk).includes('"ready"')) resolve(); }); proxy.once('exit', () => reject(new Error('proxy exited'))); });
  });
  afterEach(() => { proxy.kill(); upstream.close(); });
  const open = (budget = 10_000, seconds = 60) => control({ action: 'open', token: 'session-token', key: 'sk-real-key', upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, budget, seconds });

  it('swaps the session token for the real key and counts what the model reports', async () => {
    await open();
    const response = await call('session-token');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('message_delta');
    expect(seen[0]).toMatchObject({ key: 'sk-real-key', path: '/v1/messages', body: '{"model":"m","stream":true}' });
    // 100 input + 50 output + 20 cache writes + 1000 cache reads at a tenth.
    expect(await control({ action: 'status', token: 'session-token' })).toMatchObject({ calls: 1, input: 100, output: 50, cacheWrite: 20, cacheRead: 1000, tokens: 270 });
  });
  it('counts a non-streaming response too', async () => {
    await open();
    await (await call('session-token', '/v1/messages', '{"stream":false}')).text();
    expect(await control({ action: 'status', token: 'session-token' })).toMatchObject({ tokens: 10 });
  });
  it('refuses unknown tokens, other paths and other methods, without calling the provider', async () => {
    await open();
    expect((await call('wrong-token')).status).toBe(401);
    expect((await call('sk-real-key')).status).toBe(401);
    expect((await call('session-token', '/v1/organizations/usage')).status).toBe(403);
    expect((await call('session-token', '/v1/files')).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${relayPort}/v1/messages`, { headers: { 'x-api-key': 'session-token' } })).status).toBe(403);
    expect(seen).toEqual([]);
  });
  it('stops at the budget with an error the client will not retry', async () => {
    await open(100);
    await (await call('session-token')).text();
    const refused = await call('session-token');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { message: expect.stringContaining('budget') } });
    expect(seen).toHaveLength(1);
    expect(await control({ action: 'status', token: 'session-token' })).toMatchObject({ refused: 1 });
  });
  it('ends a session on close and at expiry, and forgets the key', async () => {
    await open();
    expect(await control({ action: 'close', token: 'session-token' })).toMatchObject({ calls: 0 });
    expect((await call('session-token')).status).toBe(401);
    expect(await control({ action: 'status', token: 'session-token' })).toEqual({ error: 'unknown session' });
    await open(1000, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await call('session-token')).status).toBe(403);
    expect(seen).toEqual([]);
  });
});
