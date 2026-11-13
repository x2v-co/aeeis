import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * Pushes a Bot's work to a GitHub repository on its behalf. The Bot's machine never holds the credential: AEEIS
 * copies the files out of the Run's workspace, commits them in a scratch clone of its own, and pushes with a token
 * only AEEIS reads. Branches are always `bot/<name>` and are never force-pushed, so a push can add commits to a Bot
 * branch but cannot rewrite or delete anything. Every commit carries a trailer derived from the call's idempotency
 * key; that is how an interrupted push is checked against GitHub before anything is tried again.
 */
export const REPO_PUSH_TOOL = 'repo-push';
export const REPO_PUSH_VERSION = '1';
export const BOT_BRANCH_PREFIX = 'bot/';
/** Folders that are rebuilt, not authored. They are never copied out of the workspace. */
export const EXPORT_SKIP = ['.git', 'node_modules', '__pycache__', '.venv', '.cache', '.next'] as const;
export const EXPORT_LIMITS = { maxFiles: 2000, maxBytes: 20 * 1024 * 1024 } as const;

const repoName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'Use a short lowercase name such as sandbox');
const relativeDir = z.string().trim().max(300).default('.').refine(value => value === '.' || (!value.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git')), 'Use a folder path relative to the root, or "."');
const branchSuffix = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}(?:\/[a-z0-9][a-z0-9._-]{0,59}){0,2}$/, 'Use lowercase letters, digits, ".", "_", "-", and at most two "/"')
  .refine(value => !value.includes('..') && value.split('/').every(part => !part.endsWith('.lock') && !part.endsWith('.')), 'Not a valid branch name');

export const repoConfigSchema = z.object({
  /** What Bots and grants call this repository, for example `sandbox`. */
  name: repoName,
  url: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Use https://github.com/<owner>/<repo>, without .git'),
  /** A fine-grained token with Contents and Pull requests write on this repository only. Read for every push. */
  tokenFile: z.string().refine(isAbsolute, 'tokenFile must be an absolute path'),
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/).default('main'),
  committer: z.object({ name: z.string().trim().min(1).max(100), email: z.string().email().max(200) }).strict().default({ name: 'AEEIS Bot', email: 'aeeis-bot@users.noreply.github.com' }),
}).strict();
export const reposConfigSchema = z.array(repoConfigSchema).min(1).max(20).refine(items => new Set(items.map(item => item.name)).size === items.length, 'Duplicate repo names');
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const repoPushInputSchema = z.object({
  repo: repoName,
  /** The part after `bot/`. Pushing to the same branch again adds a commit to it and keeps its pull request. */
  branch: branchSuffix,
  /** Workspace folder to publish. */
  path: relativeDir,
  /** Repository folder it replaces. */
  target: relativeDir,
  title: z.string().trim().min(1).max(200),
  body: z.string().max(5000).default(''),
  message: z.string().trim().min(1).max(2000).optional(),
}).strict();
export type RepoPushInput = z.infer<typeof repoPushInputSchema>;

export interface ExportedFile { path: string; mode: '644' | '755'; data: Buffer }
export type WorkspaceExporter = (path: string) => Promise<ExportedFile[]>;
export interface GitResult { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<GitResult>;
export interface RepoPushOutcome { status: 'completed' | 'failed' | 'unknown'; output: Record<string, unknown> }
export interface RepoConnectorOptions {
  git?: GitRunner;
  fetch?: typeof fetch;
  /** Tests point a repository at a local remote. Production always pushes to its GitHub URL over HTTPS. */
  remoteFor?: (repo: RepoConfig) => string;
  allowedProtocols?: string;
}

class PushFailure extends Error {
  constructor(message: string, readonly outcome: 'failed' | 'unknown' = 'failed') { super(message); }
}

const defaultGit: GitRunner = (args, options) => new Promise(resolve => {
  execFile('git', args, { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
    resolve({ code, stdout, stderr: stderr || (error && code === -1 ? error.message : '') });
  });
});

export function pushMarker(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
}

/** Rejects anything that could leave the target folder or write into Git's own files. */
export function safeExportPath(path: string): boolean {
  return path.length > 0 && path.length <= 500 && !path.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

export class RepoConnector {
  private readonly repos: Map<string, RepoConfig>;
  private readonly git: GitRunner;
  private readonly fetchImpl: typeof fetch;
  constructor(repos: z.input<typeof reposConfigSchema>, private readonly options: RepoConnectorOptions = {}) {
    this.repos = new Map(reposConfigSchema.parse(repos).map(repo => [repo.name, repo]));
    this.git = options.git ?? defaultGit;
    this.fetchImpl = options.fetch ?? fetch;
  }

  description(): string {
    const list = [...this.repos.values()].map(repo => `${repo.name} (${repo.url.replace('https://github.com/', '')}, base ${repo.baseBranch})`).join('; ');
    return `Publish a folder of this Run's workspace to a GitHub repository and open a draft pull request for review. AEEIS makes the commit and pushes it with its own credential; the container has none. The repository folder "target" is replaced by the workspace folder "path" (skipping ${EXPORT_SKIP.join(', ')}), on branch bot/<branch>, created from the base branch the first time and updated with a new commit after that. Nothing is ever force-pushed. Repositories: ${list}.`;
  }
  inputSchema(): unknown { return z.toJSONSchema(repoPushInputSchema, { io: 'input' }); }

  /** The grant scope and a one-line summary of what this call would do, or undefined if it is not a valid call. */
  describe(input: unknown): { scope: string; summary: string } | undefined {
    const parsed = repoPushInputSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const repo = this.repos.get(parsed.data.repo);
    if (!repo) return undefined;
    const value = parsed.data;
    const where = value.target === '.' ? 'the repository root' : `${value.target}/`;
    return {
      scope: `${REPO_PUSH_TOOL}:${repo.name}`,
      summary: `push workspace ${value.path === '.' ? 'root' : `${value.path}/`} to ${where} of ${repo.url.replace('https://github.com/', '')} on ${BOT_BRANCH_PREFIX}${value.branch}, and open a draft pull request "${value.title}"`,
    };
  }

  async push(raw: unknown, idempotencyKey: string, runId: string, exportFiles: WorkspaceExporter): Promise<RepoPushOutcome> {
    let input: RepoPushInput;
    try { input = repoPushInputSchema.parse(raw); }
    catch (error) { return { status: 'failed', output: { error: invalid(error) } }; }
    const repo = this.repos.get(input.repo);
    if (!repo) return { status: 'failed', output: { error: `Unknown repo "${input.repo}". Configured: ${[...this.repos.keys()].join(', ')}` } };
    const token = await readToken(repo).catch(() => '');
    if (!token) return { status: 'failed', output: { error: `AEEIS has no credential for ${repo.name}; nothing was pushed` } };
    let files: ExportedFile[];
    try { files = await exportFiles(input.path); }
    catch (error) { return { status: 'failed', output: { error: `Could not read ${input.path} from the workspace: ${message(error)}. Nothing was pushed.` } }; }
    const bad = files.find(file => !safeExportPath(file.path));
    if (bad) return { status: 'failed', output: { error: `Refused workspace file path ${JSON.stringify(bad.path.slice(0, 200))}; nothing was pushed` } };
    if (!files.length) return { status: 'failed', output: { error: `${input.path} has no files to publish; nothing was pushed` } };
    const branch = BOT_BRANCH_PREFIX + input.branch, marker = pushMarker(idempotencyKey);
    const session = await this.open(repo, token);
    try {
      const heads = await session.heads(repo.baseBranch, branch);
      if (!heads.get(repo.baseBranch)) return { status: 'failed', output: { error: `${repo.url} has no ${repo.baseBranch} branch yet, so there is nothing to open a pull request against. Add a first commit to ${repo.baseBranch}; nothing was pushed.` } };
      const existing = heads.get(branch);
      await session.checkout(existing ? branch : repo.baseBranch);
      const earlier = existing ? await session.findMarker(marker) : undefined;
      let commit: string, changes: string[], pushed: boolean;
      if (earlier) {
        commit = earlier; changes = await session.changes(commit); pushed = false;
      } else {
        await session.replace(input.target, files);
        if (!await session.staged()) {
          if (!existing) return { status: 'failed', output: { error: `The files match ${repo.baseBranch} already; nothing was pushed` } };
          commit = existing; changes = []; pushed = false;
        } else {
          commit = await session.commit(repo, `${input.message ?? input.title}\n\nRun: ${runId}\nAEEIS-Push: ${marker}\n`);
          changes = await session.changes(commit);
          await session.push(branch);
          pushed = true;
        }
      }
      const pullRequest = await this.ensurePullRequest(repo, token, branch, input).then(value => ({ value }), error => ({ error: redact(message(error), token) }));
      return { status: 'completed', output: {
        repo: repo.url.replace('https://github.com/', ''), branch, commit, pushed,
        ...(pushed ? {} : { note: earlier ? 'This push had already landed; nothing was pushed again.' : `No changes since the last push to ${branch}; nothing new was pushed.` }),
        files: files.length, changedFiles: changes.slice(0, 100), changedCount: changes.length,
        compareUrl: `${repo.url}/compare/${encodeURIComponent(repo.baseBranch)}...${encodeURIComponent(branch)}`,
        pullRequest: 'value' in pullRequest ? pullRequest.value : null,
        ...('error' in pullRequest ? { pullRequestError: `The branch is pushed, but the pull request could not be opened: ${pullRequest.error}` } : {}),
      } };
    } catch (error) {
      const outcome = error instanceof PushFailure ? error.outcome : 'unknown';
      return { status: outcome, output: { error: redact(message(error), token) } };
    } finally { await session.close(); }
  }

  /** For an interrupted push: GitHub decides. A commit with this call's marker on the branch means it landed. */
  async reconcile(raw: unknown, idempotencyKey: string): Promise<RepoPushOutcome> {
    const parsed = repoPushInputSchema.safeParse(raw);
    const repo = parsed.success ? this.repos.get(parsed.data.repo) : undefined;
    if (!parsed.success || !repo) return { status: 'failed', output: { error: 'Not a valid repo-push call; nothing was pushed' } };
    const token = await readToken(repo).catch(() => '');
    if (!token) return { status: 'unknown', output: { error: `AEEIS has no credential for ${repo.name}, so it cannot check whether the push landed` } };
    const branch = BOT_BRANCH_PREFIX + parsed.data.branch;
    const session = await this.open(repo, token);
    try {
      const heads = await session.heads(branch);
      if (!heads.get(branch)) return { status: 'failed', output: { error: `${branch} does not exist on GitHub, so the push did not land. It is safe to push again.` } };
      await session.checkout(branch);
      const commit = await session.findMarker(pushMarker(idempotencyKey));
      if (!commit) return { status: 'failed', output: { error: `${branch} has no commit from this call, so the push did not land. It is safe to push again.` } };
      const pullRequest = await this.findPullRequest(repo, token, branch).catch(() => null);
      return { status: 'completed', output: { repo: repo.url.replace('https://github.com/', ''), branch, commit, pushed: true, note: 'Checked on GitHub after an interruption: the push had landed.', compareUrl: `${repo.url}/compare/${encodeURIComponent(repo.baseBranch)}...${encodeURIComponent(branch)}`, pullRequest } };
    } catch (error) {
      return { status: 'unknown', output: { error: `Could not check GitHub: ${redact(message(error), token)}` } };
    } finally { await session.close(); }
  }

  private async open(repo: RepoConfig, token: string) {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-repo-'));
    const work = join(directory, 'repo');
    const remote = this.options.remoteFor?.(repo) ?? `${repo.url}.git`;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, LANG: 'C', LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false', SSH_ASKPASS: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_ALLOW_PROTOCOL: this.options.allowedProtocols ?? 'https',
      // The token travels as a header from the environment: never in a URL, an argument or .git/config.
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
    };
    const run = async (args: string[], timeoutMs = 60_000) => {
      const result = await this.git(args, { cwd: work, env, timeoutMs });
      if (result.code !== 0) throw new PushFailure(`git ${args[0]} failed: ${redact(result.stderr.trim() || result.stdout.trim(), token).slice(0, 500)}`, 'failed');
      return result.stdout;
    };
    await mkdir(work);
    await run(['init', '-q']);
    await run(['remote', 'add', 'origin', remote]);
    return {
      heads: async (...names: string[]) => {
        const out = await run(['ls-remote', '--heads', 'origin', ...names.map(name => `refs/heads/${name}`)]);
        return new Map(out.split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split('\t'); return [ref!.replace(/^refs\/heads\//, ''), sha!] as const; }));
      },
      checkout: async (name: string) => {
        await run(['fetch', '-q', '--no-tags', '--depth=50', 'origin', `refs/heads/${name}`], 120_000);
        await run(['checkout', '-q', '--detach', 'FETCH_HEAD']);
      },
      findMarker: async (marker: string) => {
        const out = await run(['log', '-n', '50', '--format=%H%x1f%B%x1e', 'HEAD']);
        return out.split('\x1e').map(entry => entry.trim().split('\x1f')).find(([, body]) => body?.split('\n').some(line => line.trim() === `AEEIS-Push: ${marker}`))?.[0];
      },
      replace: async (target: string, files: ExportedFile[]) => {
        const root = target === '.' ? work : join(work, target);
        if (target === '.') { for (const entry of await readdir(work)) if (entry !== '.git') await rm(join(work, entry), { recursive: true, force: true }); }
        else await rm(root, { recursive: true, force: true });
        for (const file of files) {
          const path = join(root, file.path);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.data);
          await chmod(path, file.mode === '755' ? 0o755 : 0o644);
        }
        await run(['add', '-A', '--', target]);
      },
      staged: async () => {
        const result = await this.git(['diff', '--cached', '--quiet'], { cwd: work, env, timeoutMs: 60_000 });
        if (result.code !== 0 && result.code !== 1) throw new PushFailure('git diff failed');
        return result.code === 1;
      },
      commit: async (config: RepoConfig, text: string) => {
        const file = join(directory, 'message');
        await writeFile(file, text);
        await run(['-c', `user.name=${config.committer.name}`, '-c', `user.email=${config.committer.email}`, 'commit', '-q', '--no-verify', '--no-gpg-sign', '-F', file]);
        return (await run(['rev-parse', 'HEAD'])).trim();
      },
      changes: async (commit: string) => {
        const out = await this.git(['diff', '--name-status', '--no-renames', `${commit}~1`, commit], { cwd: work, env, timeoutMs: 60_000 });
        return out.code === 0 ? out.stdout.split('\n').filter(Boolean).map(line => line.replace('\t', ' ')) : [];
      },
      push: async (branch: string) => {
        const result = await this.git(['push', '-q', '--porcelain', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work, env, timeoutMs: 180_000 });
        if (result.code === 0) return;
        const full = redact(`${result.stderr}\n${result.stdout}`.trim(), token), detail = full.slice(0, 500);
        if (/\[rejected\]|non-fast-forward|fetch first|stale info|Updates were rejected/.test(full)) throw new PushFailure(`${branch} moved on GitHub while this push was being prepared, so nothing was pushed or overwritten. Push again to build on the new commits.`);
        if (/Authentication failed|Permission to|403|could not read Username|Repository not found|denied/i.test(full)) throw new PushFailure(`GitHub refused the push (${detail}). Nothing was pushed.`);
        throw new PushFailure(`git push did not finish cleanly (${detail}); it may or may not have landed`, 'unknown');
      },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  }

  private async github(repo: RepoConfig, token: string, path: string, init: { method?: string; body?: unknown } = {}) {
    const [owner, name] = repo.url.replace('https://github.com/', '').split('/');
    const response = await this.fetchImpl(`https://api.github.com/repos/${owner}/${name}${path}`, {
      method: init.method ?? 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'aeeis', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) as unknown : null;
  }
  private async findPullRequest(repo: RepoConfig, token: string, branch: string) {
    const owner = repo.url.replace('https://github.com/', '').split('/')[0]!;
    const list = z.array(pullSchema).parse(await this.github(repo, token, `/pulls?state=open&per_page=1&head=${encodeURIComponent(`${owner}:${branch}`)}`));
    return list[0] ? view(list[0]) : null;
  }
  /** One open pull request per Bot branch: reuse it, or open a draft. Private repos on plans without drafts get a normal one. */
  private async ensurePullRequest(repo: RepoConfig, token: string, branch: string, input: RepoPushInput) {
    const found = await this.findPullRequest(repo, token, branch);
    if (found) return found;
    const body = `${input.body ? `${input.body}\n\n` : ''}Pushed by an AEEIS Bot. Review before merging.`;
    const create = (draft: boolean) => this.github(repo, token, '/pulls', { method: 'POST', body: { title: input.title, head: branch, base: repo.baseBranch, body, draft } });
    const created = await create(true).catch(async error => {
      if (/HTTP 422/.test(message(error)) && /draft/i.test(message(error))) return create(false);
      throw error;
    });
    return view(pullSchema.parse(created));
  }
}

const pullSchema = z.object({ number: z.number().int(), html_url: z.string().url(), draft: z.boolean().optional() }).passthrough();
function view(pull: z.infer<typeof pullSchema>) { return { number: pull.number, url: pull.html_url, draft: pull.draft ?? false }; }
async function readToken(repo: RepoConfig): Promise<string> { return (await readFile(repo.tokenFile, 'utf8')).trim(); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function invalid(error: unknown): string {
  return error instanceof z.ZodError ? 'Invalid repo-push arguments: ' + error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') : message(error);
}
/** The token, or the header built from it, must never reach a receipt or the model. */
export function redact(text: string, token: string): string {
  if (!token) return text;
  const header = Buffer.from(`x-access-token:${token}`).toString('base64');
  return text.split(token).join('***').split(header).join('***');
}
