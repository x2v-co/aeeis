import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalToolGateway, CombinedToolGateway } from '../src/local-tools.js';
import { receiptSchema, type ToolInvocation } from '../src/integrations.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { buildApp } from '../src/runtime/http.js';

let root: string, configFile: string, gateway: LocalToolGateway, runId: string;
const tools = ['read', 'write', 'diff', 'glob', 'grep', 'python', 'shell', 'process', 'web-fetch'];
const request = (toolId: string, input: unknown, overrides: Partial<ToolInvocation> = {}): ToolInvocation => ({ toolId, toolVersion: toolId === 'web-fetch' ? '1' : '3', input, taskId: 'task', purpose: 'sandbox verification', capabilityGrant: `run:${runId}:${toolId}`, idempotencyKey: `${runId}:${randomUUID()}`, timeoutMs: 10000, ...overrides });
const output = async (toolId: string, input: unknown) => {
  const result = await gateway.invoke(request(toolId, input));
  expect(result.status, JSON.stringify(result.output)).toBe('completed');
  expect(receiptSchema.safeParse(result.receipt).success).toBe(true);
  expect(result.outputRefs).toEqual([result.receipt.receiptId]); return result.output as any;
};

describe.skipIf(process.env.AEEIS_TEST_SANDBOX !== '1')('real persistent Linux sandboxes', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aeeis-real-sandbox-')); configFile = join(root, 'tools.json');
    await writeFile(configFile, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: 'workspaces', stateDirectory: 'receipts', tools, defaultAllowedTools: tools, sandbox: { ports: [8000] }, webHosts: ['weather.example'] }));
    gateway = await LocalToolGateway.load(configFile); runId = `run_${randomUUID()}`;
  });
  afterEach(async () => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    try { await gateway.reap(async () => 'cancelled'); } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('loads a stable pinned catalog, validates configuration and rejects duplicate gateways', async () => {
    expect((await gateway.listTools()).map(tool => tool.id)).toEqual(tools);
    const second = await LocalToolGateway.load(configFile);
    expect(await second.listTools()).toEqual(await gateway.listTools()); await second.close();
    await expect(new CombinedToolGateway([gateway, gateway]).listTools()).rejects.toThrow('Duplicate');
    await writeFile(configFile, JSON.stringify({ ...gateway.config, tools: ['read'], defaultAllowedTools: ['shell'] }));
    await expect(LocalToolGateway.load(configFile)).rejects.toThrow('Default tools');
  });
  it('supports write/read/diff/glob/grep with overwrite protection and persisted artifacts', async () => {
    const path = 'artifacts/report.md', content = '# 报告\n北京\nHELLO\n';
    const first = await output('write', { path, content });
    const read = await output('read', { path, startLine: 2, maxLines: 1 }); expect(read.content).toBe('2: 北京');
    const diff = await output('diff', { path, content: '# 报告\n上海\nHELLO\n' }); expect(diff.diff).toContain('-北京');
    expect((await gateway.invoke(request('write', { path, content: 'lost' }))).status).toBe('failed');
    expect((await output('glob', { pattern: '**/*.md' })).paths).toEqual([path]);
    expect((await output('grep', { pattern: 'hello', ignoreCase: true })).matches[0].line).toBe(3);
    await output('write', { path, content: '# 报告\n上海\nHELLO\n', expectedHash: first.sha256 });
    expect(await readFile(join(root, 'workspaces', runId, path), 'utf8')).toContain('上海');
    expect((await gateway.invoke(request('write', { path, content: 'stale', expectedHash: first.sha256 }))).status).toBe('failed');
  });
  it('supports full system commands, a writable container root, venv and Git across calls/restarts', async () => {
    await output('shell', { command: 'python3 -m venv /opt/testenv && printf installed > /opt/package-marker && git init -q project && mkdir -p node_modules && touch node_modules/local-module' });
    await gateway.close(); gateway = await LocalToolGateway.load(configFile);
    const result = await output('shell', { command: 'test -f /opt/package-marker && /opt/testenv/bin/python -c "print(6*7)" && git -C project status --short' });
    expect(result.stdout).toContain('42');
    expect((await output('glob', { pattern: 'node_modules/*' })).paths).toEqual(['node_modules/local-module']);
    runId = `run_${randomUUID()}`;
    const other = await output('shell', { command: 'test ! -e /opt/package-marker && echo isolated' }); expect(other.stdout).toContain('isolated');
  });
  it('isolates host files and credentials while enforcing cgroup limits', async () => {
    const marker = join(root, 'host-only'); await writeFile(marker, 'private'); vi.stubEnv('AEEIS_MODEL_API_KEY', 'test-secret');
    const result = await output('python', { code: `import os,pathlib
assert os.getuid()==0
assert "AEEIS_MODEL_API_KEY" not in os.environ
assert not pathlib.Path(${JSON.stringify(marker)}).exists()
assert not pathlib.Path("/var/run/docker.sock").exists()
assert not pathlib.Path(${JSON.stringify(join(process.cwd(), '.env'))}).exists()
cg=pathlib.Path("/sys/fs/cgroup")
assert int((cg/"memory.max").read_text())==1073741824
assert int((cg/"pids.max").read_text())==256
q,p=map(int,(cg/"cpu.max").read_text().split()); assert q/p==2
print("verified")` });
    expect(result.stdout).toContain('verified');
  });
  it('keeps background services, exposes loopback ports, bounds logs and supports stop', async () => {
    const proc = await output('process', { action: 'start', command: 'exec python3 -u -m http.server 8000 --bind 0.0.0.0' });
    const service = await output('shell', { command: 'for i in {1..30}; do curl -fsS http://127.0.0.1:8000/ && exit 0; sleep 0.1; done; exit 1' });
    expect(service.stdout).toContain('Directory listing');
    await gateway.close(); gateway = await LocalToolGateway.load(configFile);
    expect((await output('process', { action: 'list' })).processes[0].processId).toBe(proc.processId);
    expect((await output('process', { action: 'logs', processId: proc.processId })).stderr).toContain('GET /');
    const ports = await output('process', { action: 'ports' }); expect(ports.bindings).toMatch(/8000\/tcp -> 127\.0\.0\.1:\d+/);
    const address = ports.bindings.match(/127\.0\.0\.1:\d+/)[0];
    expect((await fetch(`http://${address}/`, { signal: AbortSignal.timeout(5000) })).status).toBe(200);
    await output('process', { action: 'stop', processId: proc.processId });
    expect((await output('process', { action: 'list' })).processes[0].state).toBe('exited');
  });
  it('returns unknown on timeout and oversized output, stops services, preserves files and never replays side effects', async () => {
    await output('write', { path: 'counter.txt', content: '1' });
    await output('process', { action: 'start', command: 'sleep 100' });
    const call = request('python', { code: 'import pathlib,time; pathlib.Path("counter.txt").write_text("2"); print("started"); time.sleep(20)' }, { timeoutMs: 300 });
    const result = await gateway.invoke(call); expect(result.status).toBe('unknown');
    expect((result.output as any).details.stdout).toContain('started');
    await gateway.close(); gateway = await LocalToolGateway.load(configFile);
    expect(await gateway.invoke(call)).toEqual(result); expect(await gateway.reconcile(call, result.receipt)).toEqual(result);
    expect((await output('read', { path: 'counter.txt' })).content).toBe('1: 2');
    expect((await output('process', { action: 'list' })).processes).toEqual([]);
    expect((await gateway.invoke(request('python', { code: 'print("x" * 100000)' }))).status).toBe('unknown');
  });
  it('rejects traversal and unsafe artifact exports without modifying the previous host snapshot', async () => {
    await output('write', { path: 'artifacts/safe.txt', content: 'safe' });
    expect((await gateway.invoke(request('read', { path: '../etc/passwd' }))).status).toBe('failed');
    const leak = await gateway.invoke(request('shell', { command: 'ln -s /etc/passwd artifacts/leak' })); expect(leak.status).toBe('unknown');
    expect(await readdir(join(root, 'workspaces', runId, 'artifacts'))).toEqual(['safe.txt']);
    await output('shell', { command: 'rm artifacts/leak' });
  });
  it('exports artifacts before terminal cleanup, stops published services and prevents silent recreation', async () => {
    await output('write', { path: 'artifacts/report.md', content: '# Done' });
    await output('process', { action: 'start', command: 'sleep 100' });
    await gateway.reap(async () => 'succeeded');
    expect(await readFile(join(root, 'workspaces', runId, 'artifacts/report.md'), 'utf8')).toBe('# Done');
    const result = await gateway.invoke(request('shell', { command: 'echo should-not-run' }));
    expect(result.status).toBe('failed'); expect((result.output as any).error).toContain('released');
  });
  it('completes a runtime Run using real sandbox receipts and exports its deliverable', async () => {
    const repository = new FileRunRepository(join(root, 'runs')); await repository.init();
    const engine = new AgentEngine(repository, { tools: gateway, model: {
      pin: { model: 'test-protocol', endpoint: 'http://localhost', promptVersion: 'test/1' },
      async complete(request) {
        if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'calculate', nodes: [{ id: 'calculate', title: 'Calculate', instruction: 'Use Python', dependsOn: [] }] } };
        if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Verified', issues: [] } };
        const input = request.input as { observations: { result: { outputRefs: string[] } }[] };
        if (!input.observations.length) return { value: { type: 'capability', toolId: 'python', toolVersion: '3', input: { code: 'from pathlib import Path; Path("artifacts/answer.md").write_text("# Result\\n42"); print(42)' }, purpose: 'Calculate answer' } };
        return { value: { type: 'finish', title: 'Answer', content: '# Result\n42', evidenceRefs: input.observations[0]!.result.outputRefs } };
      },
    } });
    const app = buildApp({ repository, tools: gateway, localToolDefaults: tools, token: 'local-test' });
    try {
      expect((await app.inject({ url: '/api/tools' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/api/tools', headers: { authorization: 'Bearer local-test' } })).json().defaultAllowedTools).toEqual(tools);
      const run = await engine.create({ goal: 'Compute six times seven', allowedTools: ['python'] });
      for (let tick = 0; tick < 12; tick++) {
        const current = await repository.get(run.id);
        if (current.status === 'needs_approval') await engine.command(run.id, 'approve', { planHash: current.plans.at(-1)!.hash });
        if (current.status === 'succeeded') break;
        await engine.advance(run.id);
      }
      const final = await repository.get(run.id); expect(final.status, final.error).toBe('succeeded');
      expect(final.toolReceipts[0]?.provider).toBe('aeeis-local-tools'); expect(final.toolReceipts[0]?.authorization?.decision).toBe('authorized');
      await gateway.reap(async id => (await repository.get(id)).status);
      expect(await readFile(join(root,'workspaces',run.id,'artifacts/answer.md'),'utf8')).toContain('42');
    } finally { await app.close(); await repository.close(); }
  });
});
