import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpDependencyProbe } from '../src/dependency-health.js';
import { HttpProjectionSink } from '../src/collaboration-projection.js';
import { FileKnowledgeProvider, HttpKnowledgeProvider } from '../src/knowledge.js';
import { FileProjectSourceProvider, HttpProjectSourceProvider } from '../src/project-sources.js';
import { CombinedProjectSourceProvider } from '../src/adapters/git-project-sources.js';
import { validateRuntimeConfig } from '../src/config-validation.js';

describe('connector dependency probes', () => {
  it('checks only the explicit health endpoint and reports outage, recovery and redirects without exposing credentials', async () => {
    const requests: Array<{ url?: string; method?: string; authorization?: string }> = [];
    let status = 503;
    const server = createServer((req, res) => {
      requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
      res.statusCode = status;
      if (status === 302) res.setHeader('location', '/search');
      res.end('secret-provider-error');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const providers = [new HttpKnowledgeProvider(`${url}/search`, 'secret-token', 1000, `${url}/health`), new HttpProjectSourceProvider(`${url}/search`, 'secret-token', 1000, `${url}/health`), new HttpProjectionSink(`${url}/events`, 'secret-token', 1000, `${url}/health`)];
      for (const provider of providers) {
        status = 503;
        expect(await provider.health()).toMatchObject({ ready: false, detail: 'provider health endpoint returned HTTP 503' });
        status = 200;
        expect(await provider.health()).toMatchObject({ ready: true });
        status = 302;
        expect(await provider.health()).toMatchObject({ ready: false, detail: 'provider health endpoint unreachable or timed out' });
      }
      expect(requests).toHaveLength(9);
      expect(requests.every(req => req.url === '/health' && req.method === 'GET' && req.authorization === 'Bearer secret-token')).toBe(true);
      expect(await new HttpKnowledgeProvider(`${url}/search`).health()).toMatchObject({ ready: false, detail: expect.stringContaining('unavailable') });
      expect(await new HttpProjectionSink(`${url}/events`).health()).toMatchObject({ ready: false, detail: expect.stringContaining('unavailable') });
      expect(requests).toHaveLength(9);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('bounds a hanging HTTP health endpoint', async () => {
    const server = createServer(() => {});
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(await new HttpDependencyProbe(url, `${url}/health`, undefined, 30).health()).toMatchObject({ ready: false });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(['KNOWLEDGE', 'PROJECT_SOURCES', 'PROJECTION_SINK'])('rejects orphaned and unsafe %s health configuration before startup', name => {
    const key = `AEEIS_${name}_HEALTH_URL`;
    expect(() => validateRuntimeConfig({ [key]: 'https://connector.example/health' })).toThrow('requires');
    for (const endpoint of ['https://other.example/health', 'https://connector.example/health?token=secret', 'https://user:password@connector.example/health', 'ftp://connector.example/health']) {
      expect(() => validateRuntimeConfig({ [`AEEIS_${name}_URL`]: 'https://connector.example/search', [key]: endpoint })).toThrow(key);
      expect(() => new HttpDependencyProbe('https://connector.example/search', endpoint)).toThrow();
    }
    expect(() => validateRuntimeConfig({ [`AEEIS_${name}_URL`]: 'https://connector.example/search', [key]: 'https://connector.example/health' })).not.toThrow();
  });

  it('detects missing files and directories without searching or loading records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-provider-health-'));
    const path = join(directory, 'source.json');
    try {
      for (const Provider of [FileKnowledgeProvider, FileProjectSourceProvider]) {
        await expect(new Provider(path).health()).rejects.toThrow();
        expect(await new Provider(directory).health()).toMatchObject({ ready: false });
      }
      await writeFile(path, 'content intentionally not parsed by a liveness probe');
      for (const Provider of [FileKnowledgeProvider, FileProjectSourceProvider]) {
        expect(await new Provider(path).health()).toMatchObject({ ready: true });
      }
      const combined = new CombinedProjectSourceProvider([new FileProjectSourceProvider(path), { search: async () => { throw new Error('must not search'); } }]);
      expect(await combined.health()).toMatchObject({ ready: false, detail: expect.stringContaining('unavailable') });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
