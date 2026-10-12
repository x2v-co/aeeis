import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

describe('run-admin CLI', () => {
  let server: Server, baseUrl: string, status: number, redirect: boolean;
  let requests: { path: string; authorization: string | undefined; body: unknown }[];
  const token = 'cli-fixture-token';
  beforeEach(async () => {
    requests = []; status = 200; redirect = false;
    server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      requests.push({ path: request.url!, authorization: request.headers.authorization, body: JSON.parse(body || '{}') });
      if (redirect) { response.writeHead(302, { location: `${baseUrl}/redirect-target` }); response.end(); return; }
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'fixture' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/run-admin.mjs', ...args], { env: { ...process.env, AEEIS_BASE_URL: baseUrl, AEEIS_TOKEN: token } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  it.each([
    [['cancel', 'run-1', '--reason', 'SRE request'], '/api/runs/run-1/cancel', { reason: 'SRE request' }],
    [['reconcile', 'run-1'], '/api/runs/run-1/reconcile', { source: 'temporal', dry_run: true }],
    [['reconcile', 'run-1', '--apply'], '/api/runs/run-1/reconcile', { source: 'temporal', dry_run: false }],
    [['reconcile', '--all'], '/api/admin/reconcile', { dry_run: true }],
    [['reconcile', '--all', '--apply', '--limit', '10'], '/api/admin/reconcile', { dry_run: false, limit: 10 }],
  ] as const)('sends %j with bearer authentication', async (args, path, body) => {
    const result = await run([...args]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ status: 'fixture' });
    expect(requests).toEqual([{ path, authorization: `Bearer ${token}`, body }]);
    expect(result.stdout + result.stderr).not.toContain(token);
  });
  it('prints JSON but returns nonzero on HTTP errors', async () => {
    status = 403; const result = await run(['reconcile', '--all']);
    expect(result.code).toBe(1); expect(JSON.parse(result.stdout)).toEqual({ status: 'fixture' });
    expect(result.stdout + result.stderr).not.toContain(token);
  });
  it('rejects redirects without forwarding credentials', async () => {
    redirect = true; const result = await run(['cancel', 'run-1']);
    expect(result.code).toBe(1); expect(requests).toHaveLength(1);
    expect(result.stdout + result.stderr).not.toContain(token);
  });
  it('rejects unsupported flags and invalid bounds before sending requests', async () => {
    for (const args of [['cancel', 'run-1', '--apply'], ['reconcile', '--all', 'run-1'], ['reconcile', '--all', '--limit', '1001']]) {
      expect((await run(args)).code).toBe(1);
    }
    expect(requests).toEqual([]);
  });
});
