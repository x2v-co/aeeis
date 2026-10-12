import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
// The shipped CLI is JavaScript and deliberately runs without a build step.
import { resolveRunTarget } from '../scripts/fetch-run.mjs';
const cli = fileURLToPath(new URL('../scripts/fetch-run.mjs', import.meta.url));
const exec = promisify(execFile);

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
  it('downloads a real debug bundle for a share URL, run URL and bare ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aeeis-fetch-run-'));
    const repo = new FileRunRepository(join(root, 'runs')); await repo.init();
    const engine = new AgentEngine(repo, { pin: { model: 'fixture', endpoint: 'http://localhost', promptVersion: 'test' }, complete: async () => ({ value: {} }) });
    const run = await engine.create({ goal: 'Fetch this run' });
    const app = buildApp({ repository: repo, token: 'access-token' });
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const share = (await app.inject({ method: 'POST', url: `/api/runs/${run.id}/share`, headers: { authorization: 'Bearer access-token' } })).json();
      for (const [input, env] of [
        [`${base}${share.url}`, {}],
        [`${base}/runs/${run.id}`, { AEEIS_TOKEN: 'access-token', AEEIS_BASE_URL: base }],
        [run.id, { AEEIS_TOKEN: 'access-token', AEEIS_BASE_URL: base }],
      ] as const) {
        const result = await exec(process.execPath, [cli, input], { cwd: root, env: { ...process.env, AEEIS_TOKEN: '', AEEIS_BASE_URL: '', ...env } });
        expect(result.stdout.trim()).toBe(`run-${run.id}.debug.json`);
        const bundle = JSON.parse(await readFile(join(root, `run-${run.id}.debug.json`), 'utf8'));
        expect(bundle).toMatchObject({ schemaVersion: 'aeeis-debug-bundle/2', run: { id: run.id, goal: 'Fetch this run' } });
      }
    } finally { await app.close(); await repo.close(); await rm(root, { recursive: true, force: true }); }
  });
});
