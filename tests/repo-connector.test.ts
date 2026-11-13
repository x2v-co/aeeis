import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/docker-sandbox.js';
import { LocalToolGateway } from '../src/local-tools.js';
import { pushMarker, redact, RepoConnector, type ExportedFile, type GitRunner } from '../src/repo-connector.js';
import { decideAction } from '../src/runtime/action-policy.js';
import { createWorkGrantSchema, newWorkGrant, workGrantDigest } from '../src/work-grant-store.js';
import { digestProtocol } from '../src/protocol.js';
import type { ToolInvocation } from '../src/integrations.js';

const TOKEN = 'github_pat_TESTONLY_not_a_real_token';
let root: string, remote: string, tokenFile: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const file = (path: string, text: string, mode: '644' | '755' = '644'): ExportedFile => ({ path, mode, data: Buffer.from(text) });

/** A local bare repository standing in for GitHub, seeded with `main`. */
async function seed(withMain = true) {
  remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  if (!withMain) return;
  const seedDir = join(root, 'seed');
  git(root, 'init', '-q', '-b', 'main', seedDir);
  await writeFile(join(seedDir, 'README.md'), '# sandbox\n');
  git(seedDir, 'add', '.'); git(seedDir, 'commit', '-q', '-m', 'init');
  git(seedDir, 'push', '-q', remote, 'main');
}
const remoteFile = (branch: string, path: string) => git(root, '--git-dir', remote, 'show', `${branch}:${path}`);
const remoteLog = (branch: string) => git(root, '--git-dir', remote, 'log', '--format=%H %s', branch).split('\n');

/** GitHub's pulls API: one open PR per head branch. */
function fakeGitHub(options: { draftUnsupported?: boolean } = {}) {
  const pulls: { number: number; head: string; title: string; draft: boolean; body: string }[] = [];
  const calls: { method: string; url: string; auth: string | null }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    calls.push({ method, url: url.toString(), auth: new Headers(init?.headers).get('authorization') });
    if (method === 'GET') {
      const head = url.searchParams.get('head')!.split(':')[1];
      return new Response(JSON.stringify(pulls.filter(pull => pull.head === head).map(pull => ({ number: pull.number, html_url: `https://github.com/x2v-co/aeeis-bots-repo/pull/${pull.number}`, draft: pull.draft }))));
    }
    const body = JSON.parse(String(init?.body));
    if (body.draft && options.draftUnsupported) return new Response(JSON.stringify({ message: 'Draft pull requests are not supported in this repository.' }), { status: 422 });
    const pull = { number: pulls.length + 1, head: body.head, title: body.title, draft: body.draft, body: body.body };
    pulls.push(pull);
    return new Response(JSON.stringify({ number: pull.number, html_url: `https://github.com/x2v-co/aeeis-bots-repo/pull/${pull.number}`, draft: pull.draft }), { status: 201 });
  });
  return { pulls, calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}
const connector = (github = fakeGitHub(), extra: { git?: GitRunner } = {}) => new RepoConnector(
  [{ name: 'sandbox', url: 'https://github.com/x2v-co/aeeis-bots-repo', tokenFile }],
  { remoteFor: () => `file://${remote}`, allowedProtocols: 'file', fetch: github.fetchImpl, ...extra },
);
const input = (overrides: Record<string, unknown> = {}) => ({ repo: 'sandbox', branch: 'pomodoro', path: 'site', target: 'sites/pomodoro', title: 'Pomodoro timer', body: 'Built by a Bot.', ...overrides });
const RUN = 'run_00000000-0000-4000-8000-000000000001';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aeeis-repo-'));
  tokenFile = join(root, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('repo-push connector', () => {
  it('pushes a workspace folder to a bot branch and opens one draft pull request', async () => {
    await seed();
    const github = fakeGitHub();
    const exported: string[] = [];
    const result = await connector(github).push(input(), `${RUN}:call-1:repo-push`, RUN, async path => { exported.push(path); return [file('index.html', '<h1>Pomodoro</h1>'), file('js/app.js', 'start()'), file('run.sh', 'echo hi', '755')]; });
    expect(result.status).toBe('completed');
    expect(exported).toEqual(['site']);
    expect(result.output).toMatchObject({ repo: 'x2v-co/aeeis-bots-repo', branch: 'bot/pomodoro', pushed: true, files: 3, changedCount: 3, pullRequest: { number: 1, draft: true } });
    expect(remoteFile('bot/pomodoro', 'sites/pomodoro/index.html')).toBe('<h1>Pomodoro</h1>');
    expect(remoteFile('bot/pomodoro', 'README.md')).toBe('# sandbox');
    expect(git(root, '--git-dir', remote, 'ls-tree', 'bot/pomodoro', 'sites/pomodoro/run.sh')).toMatch(/^100755/);
    // main is untouched; the commit carries this call's marker.
    expect(remoteLog('main')).toHaveLength(1);
    expect(git(root, '--git-dir', remote, 'log', '-1', '--format=%B', 'bot/pomodoro')).toContain(`AEEIS-Push: ${pushMarker(`${RUN}:call-1:repo-push`)}`);
    expect(github.pulls).toEqual([expect.objectContaining({ head: 'bot/pomodoro', title: 'Pomodoro timer', draft: true })]);
    expect(github.calls.every(call => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('repeats nothing for the same call, adds a commit for new work, and keeps the pull request', async () => {
    await seed();
    const github = fakeGitHub(), repo = connector(github);
    const first = await repo.push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    const again = await repo.push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    expect(again.output).toMatchObject({ pushed: false, commit: first.output.commit, note: expect.stringMatching(/already landed/) });
    const second = await repo.push(input(), `${RUN}:b:repo-push`, RUN, async () => [file('index.html', 'v2')]);
    expect(second.output).toMatchObject({ pushed: true, pullRequest: { number: 1 } });
    expect(remoteLog('bot/pomodoro').map(line => line.split(' ')[0])).toEqual([second.output.commit, first.output.commit, expect.any(String)]);
    const same = await repo.push(input(), `${RUN}:c:repo-push`, RUN, async () => [file('index.html', 'v2')]);
    expect(same.output).toMatchObject({ pushed: false, commit: second.output.commit, note: expect.stringMatching(/No changes/) });
    expect(github.pulls).toHaveLength(1);
  });

  it('replaces the target folder, so files removed from the workspace go too', async () => {
    await seed();
    const repo = connector();
    await repo.push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'v1'), file('old.css', 'x')]);
    const result = await repo.push(input(), `${RUN}:b:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    expect(result.output.changedFiles).toEqual(['D sites/pomodoro/old.css']);
  });

  it('refuses without pushing when the base branch is missing, a path escapes, or nothing changed', async () => {
    await seed(false);
    const empty = await connector().push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'x')]);
    expect(empty).toMatchObject({ status: 'failed', output: { error: expect.stringMatching(/no main branch yet/) } });
    await rm(remote, { recursive: true }); await seed();
    for (const path of ['../escape', '.git/config', '/abs', 'a/../../b']) {
      const result = await connector().push(input(), `${RUN}:${path}:repo-push`, RUN, async () => [file(path, 'x')]);
      expect(result).toMatchObject({ status: 'failed', output: { error: expect.stringMatching(/Refused workspace file path/) } });
    }
    const same = await connector().push(input({ target: '.' }), `${RUN}:b:repo-push`, RUN, async () => [file('README.md', '# sandbox\n')]);
    expect(same).toMatchObject({ status: 'failed', output: { error: expect.stringMatching(/match main already/) } });
    expect(git(root, '--git-dir', remote, 'branch', '--list')).toBe('* main');
    expect((await connector().push(input({ branch: '../main' }), `${RUN}:c:repo-push`, RUN, async () => [])).status).toBe('failed');
    expect((await connector().push(input({ repo: 'other' }), `${RUN}:d:repo-push`, RUN, async () => [])).output).toMatchObject({ error: expect.stringMatching(/Unknown repo/) });
  });

  it('never overwrites a branch that moved meanwhile', async () => {
    await seed();
    const repo = connector();
    await repo.push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    const racer: GitRunner = async (args, options) => {
      if (args[0] === 'push') {
        const other = join(root, 'other');
        git(root, 'clone', '-q', '-b', 'bot/pomodoro', remote, other);
        await writeFile(join(other, 'person.txt'), 'edited by a person');
        git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'person'); git(other, 'push', '-q', 'origin', 'bot/pomodoro');
      }
      return new Promise(resolve => execFile(args, options, resolve));
    };
    const result = await connector(fakeGitHub(), { git: racer }).push(input(), `${RUN}:b:repo-push`, RUN, async () => [file('index.html', 'v2')]);
    expect(result).toMatchObject({ status: 'failed', output: { error: expect.stringMatching(/moved on GitHub/) } });
    expect(remoteLog('bot/pomodoro')[0]).toMatch(/ person$/);
  });

  it('checks GitHub to settle an interrupted push', async () => {
    await seed();
    const repo = connector();
    expect((await repo.reconcile(input(), `${RUN}:a:repo-push`)).output).toMatchObject({ error: expect.stringMatching(/does not exist on GitHub/) });
    const pushed = await repo.push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    expect(await repo.reconcile(input(), `${RUN}:a:repo-push`)).toMatchObject({ status: 'completed', output: { commit: pushed.output.commit, pushed: true } });
    expect(await repo.reconcile(input(), `${RUN}:other:repo-push`)).toMatchObject({ status: 'failed', output: { error: expect.stringMatching(/safe to push again/) } });
  });

  it('opens a normal pull request where drafts are not available, and keeps the push if the pull request fails', async () => {
    await seed();
    const github = fakeGitHub({ draftUnsupported: true });
    const result = await connector(github).push(input(), `${RUN}:a:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    expect(result.output).toMatchObject({ pullRequest: { number: 1, draft: false } });
    const broken = { fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch, pulls: [], calls: [] };
    const second = await connector(broken).push(input({ branch: 'other' }), `${RUN}:b:repo-push`, RUN, async () => [file('index.html', 'v1')]);
    expect(second).toMatchObject({ status: 'completed', output: { pushed: true, pullRequest: null, pullRequestError: expect.stringMatching(/branch is pushed/) } });
  });

  it('describes a call by its grant scope, and never leaks the token', () => {
    const repo = connector();
    expect(repo.describe(input())).toEqual({ scope: 'repo-push:sandbox', summary: expect.stringContaining('x2v-co/aeeis-bots-repo on bot/pomodoro') });
    expect(repo.describe(input({ repo: 'other' }))).toBeUndefined();
    expect(repo.describe({ repo: 'sandbox' })).toBeUndefined();
    const header = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(redact(`fatal: ${TOKEN} and ${header}`, TOKEN)).toBe('fatal: *** and ***');
  });
});

function execFile(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }, resolve: (value: { code: number; stdout: string; stderr: string }) => void) {
  try { resolve({ code: 0, stdout: execFileSync('git', args, { cwd: options.cwd, env: options.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }); }
  catch (error) { const failure = error as { status?: number; stdout?: string; stderr?: string }; resolve({ code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }); }
}

describe('repo-push through the local tool gateway', () => {
  const load = async () => {
    const filename = join(root, 'config.json');
    await writeFile(filename, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: 'work', stateDirectory: 'state', tools: ['python'], sandbox: { network: 'proxied' },
      repos: [{ name: 'sandbox', url: 'https://github.com/x2v-co/aeeis-bots-repo', tokenFile }] }));
    const gateway = await LocalToolGateway.load(filename);
    gateway.repoConnector = connector();
    return gateway;
  };
  const request = (key = 'call-1'): ToolInvocation => ({ toolId: 'repo-push', toolVersion: '1', taskId: 'task', purpose: 'publish', input: input(), capabilityGrant: `run:${RUN}:repo-push`, idempotencyKey: `${RUN}:${key}:repo-push`, timeoutMs: 60_000 });

  it('lists repo-push as outward, reads files from the Run machine, and answers a repeat from its journal', async () => {
    await seed();
    vi.spyOn(DockerSandbox.prototype, 'imageId').mockResolvedValue(`sha256:${'a'.repeat(64)}`);
    const exportFiles = vi.spyOn(DockerSandbox.prototype, 'exportFiles').mockResolvedValue([file('index.html', 'v1')]);
    const gateway = await load();
    const tool = (await gateway.listTools()).find(item => item.id === 'repo-push');
    expect(tool).toMatchObject({ version: '1', capabilities: ['write', 'network'] });
    expect(await gateway.workspaceContainedTools()).not.toContain('repo-push');
    expect(gateway.outwardAction('repo-push', input())).toMatchObject({ scope: 'repo-push:sandbox' });
    expect(gateway.outwardAction('python', input())).toBeUndefined();
    const first = await gateway.invoke(request());
    expect(first).toMatchObject({ status: 'completed', output: { branch: 'bot/pomodoro', pushed: true }, receipt: { provider: 'aeeis-local-tools', capabilitiesUsed: ['write', 'network'] } });
    expect(exportFiles).toHaveBeenCalledWith(RUN, 'site', expect.objectContaining({ maxFiles: 2000, skip: expect.arrayContaining(['.git', 'node_modules']) }), undefined, expect.any(String));
    expect(await gateway.invoke(request())).toEqual(first);
    expect(exportFiles).toHaveBeenCalledTimes(1);
    // A journal left by a push that was cut off is settled by asking GitHub, not by pushing again.
    const cut = request('call-2');
    const journal = join(root, 'state', `${createHash('sha256').update(cut.idempotencyKey).digest('hex')}.json`);
    await writeFile(journal, JSON.stringify({ requestHash: (gateway as unknown as { requestHash(request: ToolInvocation): string }).requestHash(cut) }));
    expect(await gateway.invoke(cut)).toMatchObject({ status: 'failed', output: { error: expect.stringMatching(/safe to push again/) } });
    expect(exportFiles).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(journal, 'utf8')).result.status).toBe('failed');
    await gateway.close();
  });

  it('refuses a call whose grant names another tool or Run', async () => {
    await seed();
    const gateway = await load();
    expect(await gateway.invoke({ ...request(), capabilityGrant: `run:${RUN}:python` })).toMatchObject({ status: 'failed', output: { error: 'Invalid Run capability grant' } });
    expect(await gateway.invoke({ ...request(), idempotencyKey: `run_${randomUUID()}:x:repo-push` })).toMatchObject({ status: 'failed' });
    await gateway.close();
  });
});

describe('Work Grant pre-approval for outward calls', () => {
  const grant = { grantId: 'wg_1', containedTools: ['read'], agents: [], connectors: ['repo-push:sandbox'] };
  const push = { kind: 'tool' as const, id: 'repo-push', capabilities: ['write', 'network'], scope: 'repo-push:sandbox' };
  it('lets a grant that names the repo cover the push, from any origin', () => {
    expect(decideAction(undefined, 'channel', 'required', push, { grant, untrusted: true })).toMatchObject({ decision: 'allow', rule: 'grant' });
  });
  it('still asks for another repo, without a grant, or without a scope from AEEIS', () => {
    expect(decideAction(undefined, 'owner', 'required', { ...push, scope: 'repo-push:other' }, { grant })).toMatchObject({ decision: 'ask' });
    expect(decideAction(undefined, 'owner', 'required', push, {})).toMatchObject({ decision: 'ask' });
    expect(decideAction(undefined, 'owner', 'required', { ...push, scope: undefined }, { grant })).toMatchObject({ decision: 'ask' });
    expect(decideAction(undefined, 'owner', 'required', push, { grant: { ...grant, connectors: undefined } })).toMatchObject({ decision: 'ask' });
  });
  it('lets the block list win over the grant', () => {
    expect(decideAction({ allow: [], block: ['repo-push'] }, 'owner', 'yolo', push, { grant })).toMatchObject({ decision: 'refuse', rule: 'block' });
  });
  it('needs the tool for a connector, and keeps old grants digesting as before', () => {
    const scope = { owner: 'owner', tenantId: 'local' };
    const budget = { perRun: { tokens: 10 }, total: { tokens: 100 } };
    expect(createWorkGrantSchema.safeParse({ title: 't', tools: ['read'], connectors: ['repo-push:sandbox'], budget, durationHours: 1 }).success).toBe(false);
    expect(createWorkGrantSchema.safeParse({ title: 't', tools: ['read'], connectors: ['shell:any'], budget, durationHours: 1 }).success).toBe(false);
    const withPush = newWorkGrant(scope, { title: 't', tools: ['repo-push'], connectors: ['repo-push:sandbox'], budget, durationHours: 1 }, '2026-11-13T00:00:00.000Z');
    expect(withPush.connectors).toEqual(['repo-push:sandbox']);
    const old = newWorkGrant(scope, { title: 't', tools: ['read'], budget, durationHours: 1 }, '2026-11-13T00:00:00.000Z');
    expect(old.connectors).toBeUndefined();
    expect(workGrantDigest(old)).toBe(digestProtocol({ schemaVersion: 'work-grant/1', grantId: old.grantId, owner: old.owner, tenantId: old.tenantId, tools: old.tools, agents: old.agents, budget: old.budget, expiresAt: old.expiresAt }));
    expect(workGrantDigest(withPush)).not.toBe(workGrantDigest({ ...withPush, connectors: undefined }));
  });
});

describe('workspace export script', () => {
  const run = async (workspace: string, args: Record<string, unknown>) => {
    const { EXPORT_SCRIPT } = await import('../src/docker-sandbox.js');
    const script = EXPORT_SCRIPT.replace("'/workspace'", JSON.stringify(workspace));
    return JSON.parse(execFileSync('python3', ['-I', '-c', script], { input: JSON.stringify({ maxFiles: 10, maxBytes: 1000, skip: ['.git', 'node_modules'], ...args }), encoding: 'utf8' }));
  };
  it('reads regular files only, skips build folders and links, and stays inside the workspace', async () => {
    const workspace = join(root, 'workspace');
    const { mkdir, symlink, chmod } = await import('node:fs/promises');
    await mkdir(join(workspace, 'site', 'js'), { recursive: true }); await mkdir(join(workspace, 'site', 'node_modules', 'x'), { recursive: true });
    await writeFile(join(workspace, 'site', 'index.html'), 'hi'); await writeFile(join(workspace, 'site', 'js', 'run.sh'), 'echo'); await chmod(join(workspace, 'site', 'js', 'run.sh'), 0o755);
    await writeFile(join(workspace, 'site', 'node_modules', 'x', 'a.js'), 'x');
    await writeFile(join(root, 'secret'), 'outside');
    await symlink(join(root, 'secret'), join(workspace, 'site', 'link'));
    await symlink(root, join(workspace, 'site', 'linkdir'));
    await symlink(root, join(workspace, 'escape'));
    const result = await run(workspace, { path: 'site' });
    expect(result.files.map((item: { path: string; mode: string }) => `${item.path}:${item.mode}`).sort()).toEqual(['index.html:644', 'js/run.sh:755']);
    expect(Buffer.from(result.files.find((item: { path: string }) => item.path === 'index.html').data, 'base64').toString()).toBe('hi');
    expect(result.skipped).toBe(3);
    expect(await run(workspace, { path: 'escape' })).toEqual({ error: 'That folder is outside the workspace' });
    expect(await run(workspace, { path: 'missing' })).toMatchObject({ error: expect.stringMatching(/No such folder/) });
    expect(await run(workspace, { path: 'site', maxFiles: 1 })).toMatchObject({ error: expect.stringMatching(/too large/) });
  });
});
