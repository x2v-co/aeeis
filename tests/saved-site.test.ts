import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import type { AgentRun } from '../src/runtime/contracts.js';
import { PACK_DELIVERABLES, savedSiteFile, siteTicket, siteTicketValid } from '../src/saved-site.js';

const RUN = `run_${'7'.repeat(36)}`;
async function workspace(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'aeeis-pack-'));
  for (const [path, body] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); }
  return root;
}
const pack = (root: string) => JSON.parse(execFileSync('/bin/bash', ['-c', PACK_DELIVERABLES], { env: { ...process.env, AEEIS_PACK_ROOT: root }, encoding: 'utf8' }));
const listTar = (file: string) => execFileSync('tar', ['tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
const exists = (path: string) => stat(path).then(() => true, () => false);

describe('saving what the owner reviews before the machine is reclaimed', () => {
  it('copies the built site and packs the source, leaving out dependencies and its own output', async () => {
    const root = await workspace({ 'index.html': '<script type=module src=/src/main.ts></script>', 'src/main.ts': 'x', 'dist/index.html': '<h1>番茄钟</h1>', 'dist/assets/app.js': 'go()', 'node_modules/dep/index.js': 'dep', '.git/HEAD': 'ref', 'artifacts/screenshots/a.png': 'png' });
    expect(pack(root)).toMatchObject({ source: expect.any(Number), site: { from: 'dist', files: 2 } });
    expect(await readFile(join(root, 'artifacts/site/index.html'), 'utf8')).toBe('<h1>番茄钟</h1>');
    expect(await readFile(join(root, 'artifacts/site/assets/app.js'), 'utf8')).toBe('go()');
    const listed = listTar(join(root, 'artifacts/source.tar.gz'));
    expect(listed).toContain('./src/main.ts');
    expect(listed.some(name => /node_modules|\.git\/|screenshots|artifacts\/site/.test(name))).toBe(false);
  });
  it('uses a plain project folder when nothing was built, and keeps an archive the passed check already made', async () => {
    const root = await workspace({ 'pomodoro/index.html': '<h1>ok</h1>', 'pomodoro/style.css': 'a{}', 'artifacts/source.tar.gz': 'from the check', 'artifacts/notes.md': 'n' });
    expect(pack(root)).toMatchObject({ site: { from: 'pomodoro', files: 2 } });
    expect(await readFile(join(root, 'artifacts/source.tar.gz'), 'utf8')).toBe('from the check');
    // Run again, as a later release would: the old copy is replaced, never nested.
    pack(root);
    expect(await exists(join(root, 'artifacts/site/site'))).toBe(false);
  });
  it('never copies the workspace\'s artifacts into the site when the site is the whole workspace', async () => {
    const root = await workspace({ 'index.html': '<h1>root</h1>', 'artifacts/screenshots/a.png': 'png', 'artifacts/report.md': 'r' });
    expect(pack(root)).toMatchObject({ site: { from: '.', files: 1 } });
    expect(await exists(join(root, 'artifacts/site/artifacts'))).toBe(false);
  });
  it('leaves out a site too large for the export, rather than failing the export', async () => {
    const root = await workspace({ 'dist/index.html': 'x', 'dist/video.bin': Buffer.alloc(7 * 1024 * 1024) });
    expect(pack(root)).toMatchObject({ siteSkipped: 'too large' });
    expect(await exists(join(root, 'artifacts/site'))).toBe(false);
  });
  it('saves nothing when there is nothing to review', async () => {
    const root = await workspace({});
    expect(pack(root)).toEqual({});
  });
});

describe('serving a saved site', () => {
  const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), 'aeeis-site-'));
    const site = join(root, RUN, 'artifacts', 'site');
    await mkdir(join(site, 'docs'), { recursive: true });
    await writeFile(join(site, 'index.html'), '<h1>home</h1>'); await writeFile(join(site, 'docs', 'index.html'), '<h1>docs</h1>'); await writeFile(join(site, 'app.js'), 'go()');
    await writeFile(join(root, 'secret.txt'), 'secret'); await symlink(join(root, 'secret.txt'), join(site, 'leak.txt'));
    return root;
  };
  it('serves only regular files inside the copy', async () => {
    const root = await setup();
    expect(await savedSiteFile(root, RUN, '')).toMatchObject({ type: 'text/html; charset=utf-8' });
    expect((await savedSiteFile(root, RUN, 'docs/'))?.body.toString()).toBe('<h1>docs</h1>');
    expect(await savedSiteFile(root, RUN, 'app.js')).toMatchObject({ type: 'text/javascript; charset=utf-8' });
    for (const path of ['../../secret.txt', 'leak.txt', 'missing.html', 'docs/../../../secret.txt']) expect(await savedSiteFile(root, RUN, path)).toBeUndefined();
    expect(await savedSiteFile(root, 'run_../../x', '')).toBeUndefined();
  });
  it('accepts a link only for its Run and until it expires', () => {
    const secret = Buffer.alloc(32, 1), later = Math.floor(Date.now() / 1000) + 60;
    const ticket = siteTicket(secret, RUN, later);
    expect(siteTicketValid(secret, RUN, ticket)).toBe(true);
    expect(siteTicketValid(secret, `run_${'8'.repeat(36)}`, ticket)).toBe(false);
    expect(siteTicketValid(Buffer.alloc(32, 2), RUN, ticket)).toBe(false);
    expect(siteTicketValid(secret, RUN, ticket, (later + 1) * 1000)).toBe(false);
    expect(siteTicketValid(secret, RUN, `${later + 999}.${ticket.split('.')[1]}`)).toBe(false);
  });
  it('gives the owner a short-lived link, and serves the page cut off from this origin', async () => {
    const { buildApp } = await import('../src/runtime/http.js');
    const root = await setup();
    const repository = new InMemoryRunRepository();
    await repository.create({ id: RUN, goal: 'Site', status: 'failed', owner: 'alice', tenantId: 'team-a', events: [], calls: [], steps: [], artifacts: [] } as never as AgentRun);
    const runComputer = {
      observe: vi.fn(async () => ({ state: 'released', previews: [] }) as never), screenshots: vi.fn(async () => []), screenshot: vi.fn(async () => undefined), sourceArchive: vi.fn(async () => undefined), hostWait: vi.fn(async () => undefined),
      deliverables: vi.fn(async () => ({ savedSite: true, sourceArchive: true })), savedSiteFile: (runId: string, path: string) => savedSiteFile(root, runId, path),
    };
    const app = buildApp({ repository, runComputer, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      const view = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/computer`, headers: { authorization: 'Bearer alice' } });
      expect(view.json()).toMatchObject({ machine: { state: 'released' }, delivery: { savedSite: true, sourceArchive: true } });
      expect((await app.inject({ method: 'GET', url: `/api/runs/${RUN}/computer/site-link`, headers: { authorization: 'Bearer bob' } })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: `/api/runs/${RUN}/computer/site-link` })).statusCode).toBe(401);
      const link = await app.inject({ method: 'GET', url: `/api/runs/${RUN}/computer/site-link`, headers: { authorization: 'Bearer alice' } });
      const { url } = link.json() as { url: string };
      expect(url).toMatch(new RegExp(`^/saved-site/${RUN}/\\d+\\.[\\w-]{43}/$`));
      const page = await app.inject({ method: 'GET', url });
      expect(page.statusCode).toBe(200); expect(page.body).toBe('<h1>home</h1>');
      expect(page.headers['content-security-policy']).toMatch(/^sandbox allow-scripts /);
      expect(page.headers['content-security-policy']).not.toContain('allow-same-origin');
      expect(page.headers['content-security-policy']).toContain("connect-src 'none'");
      expect(page.headers).toMatchObject({ 'referrer-policy': 'no-referrer', 'cache-control': 'private, no-store' });
      // The page's own module scripts come from an opaque origin.
      expect((await app.inject({ method: 'GET', url: `${url}app.js`, headers: { origin: 'null' } })).body).toBe('go()');
      expect((await app.inject({ method: 'GET', url: `${url}leak.txt` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: url.replace(/\.[\w-]{43}\//, `.${'A'.repeat(43)}/`) })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: url.replace(RUN, `run_${'8'.repeat(36)}`) })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
