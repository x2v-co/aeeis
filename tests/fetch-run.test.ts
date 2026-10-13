import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { fetchRunCli } from './support/fetch-run-cli.js';
// The shipped CLI is JavaScript and deliberately runs without a build step.
import { resolveRunTarget, MAX_BUNDLE_BYTES } from '../scripts/fetch-run.mjs';

describe('fetch-run CLI', () => {
  it('resolves run IDs/URLs and never sends installation credentials to a share URL', () => {
    const id = 'run_00000000-0000-0000-0000-000000000001', token = 'a'.repeat(43);
    const env = { AEEIS_BASE_URL: 'https://aeeis.example', AEEIS_TOKEN: 'private-auth' };
    expect(resolveRunTarget(id, env)).toEqual({ url: `https://aeeis.example/api/runs/${id}/debug-bundle`, headers: { authorization: 'Bearer private-auth' } });
    expect(resolveRunTarget(`/runs/${id}`, env)).toEqual(resolveRunTarget(id, env));
    expect(resolveRunTarget(`https://aeeis.example/runs/${id}?ignored=true`, env)).toEqual(resolveRunTarget(id, env));
    expect(resolveRunTarget(`https://other.example/share/${token}`, env)).toEqual({ url: `https://other.example/api/share/${token}/debug-bundle`, headers: {} });
    expect(() => resolveRunTarget(id, {})).toThrow('AEEIS_BASE_URL');
    expect(() => resolveRunTarget(`https://aeeis.example/runs/${id}`, {})).toThrow('AEEIS_TOKEN');
    expect(() => resolveRunTarget(`https://attacker.example/runs/${id}`, env)).toThrow('origin');
    expect(() => resolveRunTarget(`//attacker.example/runs/${id}`, env)).toThrow('Protocol-relative');
    expect(() => resolveRunTarget(`https://aeeis.example/runs/${id}`, { AEEIS_TOKEN: 'x' })).toThrow('AEEIS_BASE_URL');
    expect(() => resolveRunTarget(`http://other.example/share/${token}`, env)).toThrow('HTTPS');
    expect(() => resolveRunTarget('https://aeeis.example/api/runs', env)).toThrow('Expected');
  });
  it('resolves thread IDs, URLs and bare share tokens with the same credential boundary', () => {
    const id = 'thread_00000000-0000-0000-0000-000000000001', token = 't'.repeat(43);
    const env = { AEEIS_BASE_URL: 'https://aeeis.example', AEEIS_TOKEN: 'private-auth' };
    const target = { url: `https://aeeis.example/api/threads/${id}/debug-bundle`, headers: { authorization: 'Bearer private-auth' } };
    for (const input of [id, `/threads/${id}`, `https://user:password@aeeis.example/threads/${id}?token=ignored#fragment`]) expect(resolveRunTarget(input, env)).toEqual(target);
    expect(resolveRunTarget(token, env)).toEqual({ url: `https://aeeis.example/api/share/${token}/debug-bundle`, headers: {} });
    expect(resolveRunTarget(`https://other.example/share/${token}`, env).headers).toEqual({});
    for (const input of [`https://attacker.example/threads/${id}`, `https://aeeis.example:444/threads/${id}`]) expect(() => resolveRunTarget(input, env)).toThrow('origin');
    expect(() => resolveRunTarget(`//attacker.example/threads/${id}`, env)).toThrow('Protocol-relative');
    expect(() => resolveRunTarget(id, { AEEIS_BASE_URL: env.AEEIS_BASE_URL })).toThrow('AEEIS_TOKEN');
    expect(() => resolveRunTarget(token, {})).toThrow('AEEIS_BASE_URL');
    expect(() => resolveRunTarget(id, { ...env, AEEIS_BASE_URL: 'http://aeeis.example' })).toThrow('HTTPS');
    expect(() => resolveRunTarget(`/threads/${id}`, { ...env, AEEIS_BASE_URL: 'ftp://localhost' })).toThrow('HTTPS');
    for (const base of ['http://127.0.0.1:4323', 'http://localhost:4323', 'http://[::1]:4323']) expect(resolveRunTarget(id, { ...env, AEEIS_BASE_URL: base }).url).toBe(`${base}/api/threads/${id}/debug-bundle`);
  });
  it('downloads a real debug bundle for a share URL, run URL and bare ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aeeis-fetch-run-'));
    const repo = new FileRunRepository(join(root, 'runs')); await repo.init();
    const engine = new AgentEngine(repo, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async () => ({ value: {} }) });
    const run = await engine.create({ goal: 'Fetch this run' });
    const app = buildApp({ repository: repo, token: 'access-token' });
    try {
      const base = 'http://127.0.0.1:4323';
      const share = (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: { authorization: 'Bearer access-token' } })).json();
      for (const [input, env] of [
        [`${base}${share.url}`, {}],
        [`${base}/runs/${run.id}`, { AEEIS_TOKEN: 'access-token', AEEIS_BASE_URL: base }],
        [run.id, { AEEIS_TOKEN: 'access-token', AEEIS_BASE_URL: base }],
      ] as const) {
        const filename = await fetchRunCli(input, root, env, async request => {
          const response = await app.inject({ url: new URL(request.url).pathname, headers: request.headers });
          return { status: response.statusCode, body: response.body };
        });
        expect(filename).toBe(`run-${run.id}.debug.json`);
        const bundle = JSON.parse(await readFile(join(root, `run-${run.id}.debug.json`), 'utf8'));
        expect(bundle).toMatchObject({ schemaVersion: 'aeeis-debug-bundle/2', run: { id: run.id, goal: 'Fetch this run' } });
        expect((await stat(join(root, filename))).mode & 0o777).toBe(0o600);
        // Repeated exports must restore permissions on an existing output file.
        await chmod(join(root, filename), 0o644);
      }
    } finally { await app.close(); await repo.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('rejects redirects, oversized responses and invalid bundle IDs without writing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aeeis-fetch-run-errors-'));
    const token = 'a'.repeat(43), requests: string[] = [];
    try {
      for (const mode of ['redirect', 'declared', 'streamed', 'invalid']) {
        await expect(fetchRunCli(`https://other.example/share/${token}`, root, { AEEIS_TOKEN: 'private-auth' }, async request => {
          requests.push(new URL(request.url).pathname);
          expect(request.headers).toEqual({}); expect(request.redirect).toBe('error');
          if (mode === 'redirect') return { status: 302, headers: { location: 'https://attacker.example/exfiltrate' }, body: '' };
          if (mode === 'declared') return { status: 200, headers: { 'content-length': String(MAX_BUNDLE_BYTES + 1) }, body: '{}' };
          if (mode === 'streamed') return { status: 200, body: 'x'.repeat(MAX_BUNDLE_BYTES + 1) };
          return { status: 200, body: JSON.stringify({ kind: 'thread', schemaVersion: 'aeeis-thread-debug-bundle/1', thread: { id: '../../outside' }, runs: [] }) };
        })).rejects.toThrow(mode === 'redirect' ? 'fetch failed' : mode === 'invalid' ? 'Invalid thread ID' : 'size limit');
      }
      expect(requests).toEqual(Array(4).fill(`/api/share/${token}/debug-bundle`));
      expect(await readdir(root)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15000);
});
