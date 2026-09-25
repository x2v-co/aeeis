import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { projectSourceContentHash, projectSourceProtocolHash, projectSourceRecordSchema, makeSyncReceipt, synchronizeProjectSources, searchProjectSources, validateProjectSources, validateProjectSourceSync, type ProjectSourceCheckpointStore, type ProjectSourceProvider, type ProjectSourceProviderHealth, type ProjectSourceRecord, type ProjectSourceSearchRequest, type ProjectSourceSyncProvider, type ProjectSourceSyncRequest, type ProjectSourceSyncResult } from '../project-sources.js';

const execute = promisify(execFile);
const relativePath = z.string().min(1).max(500).refine(value => !value.startsWith('/') && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Use explicit repository-relative files or directories');
export const gitProjectConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  root: z.string().refine(isAbsolute, 'Repository root must be absolute'),
  tenantId: z.string().trim().min(1).max(200),
  paths: z.array(relativePath).min(1).max(30),
  classification: z.enum(['public', 'internal', 'confidential', 'private']).default('internal'),
  maxFiles: z.number().int().min(1).max(1000).default(300),
  maxBytes: z.number().int().min(1).max(10_000_000).default(2_000_000),
  recentCommits: z.number().int().min(0).max(20).default(5),
}).strict();
export type GitProjectConfig = z.input<typeof gitProjectConfigSchema>;

/** Reads immutable Git objects, never working files, symlink targets, hooks or
 * text conversion filters. Repository access is installation configuration. */
export class GitProjectSourceProvider implements ProjectSourceSyncProvider {
  readonly checkpointIdentity: string;
  private readonly config: z.output<typeof gitProjectConfigSchema>;
  constructor(config: GitProjectConfig) { this.config = gitProjectConfigSchema.parse(config); this.checkpointIdentity = `git:${projectSourceProtocolHash(this.config)}`; }

  async health(): Promise<ProjectSourceProviderHealth> {
    const root = await realpath(this.config.root);
    const top = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== root) return { ready: false, detail: 'configured Git root is not the repository root' };
    const head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    assertObjectId(head);
    return { ready: true, detail: `git repository reachable at ${head.slice(0, 12)}` };
  }

  async search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]> {
    return (await this.collect(request)).records;
  }

  async sync(request: ProjectSourceSyncRequest): Promise<ProjectSourceSyncResult> {
    if (request.tenantId !== this.config.tenantId || !(request.allowedClassifications ?? ['public', 'internal']).includes(this.config.classification)) {
      const nextCursor = 'denied';
      const records: ProjectSourceRecord[] = [];
      const receipt = makeSyncReceipt(`git:${this.config.id}`, request, records, nextCursor, { mode: 'snapshot' });
      return validateProjectSourceSync(request, { records, nextCursor, receipt });
    }
    const head = (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    assertObjectId(head);
    const records = request.cursor === head ? [] : (await this.collect(request, head)).records;
    const receipt = makeSyncReceipt(`git:${this.config.id}`, request, records, head, { mode: request.cursor === head ? 'unchanged' : 'snapshot' });
    return validateProjectSourceSync(request, { records, nextCursor: head, receipt });
  }

  private async collect(request: ProjectSourceSearchRequest, pinnedHead?: string): Promise<{ records: ProjectSourceRecord[]; cursor: string }> {
    if (request.tenantId !== this.config.tenantId || !(request.allowedClassifications ?? ['public', 'internal']).includes(this.config.classification)) return { records: [], cursor: 'denied' };
    const root = await realpath(this.config.root);
    const top = (await this.git(['rev-parse', '--show-toplevel'])).trim();
    if (await realpath(top) !== root) throw new Error('Configured Git root must be the repository root');
    const head = pinnedHead ?? (await this.git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    assertObjectId(head);
    const updatedAt = (await this.git(['show', '-s', '--format=%cI', head])).trim();
    const paths = this.config.paths.map(path => `:(literal)${path}`);
    const tree = await this.git(['ls-tree', '-rlz', '--full-tree', head, '--', ...paths]);
    const files = tree.split('\0').filter(Boolean).flatMap(entry => {
      const match = /^(100644|100755) blob ([a-f0-9]{40,64})\s+(\d+)\t([\s\S]+)$/.exec(entry);
      if (!match || !this.allowed(match[4]!) || Number(match[3]) > 100_000) return [];
      return [{ oid: match[2]!, bytes: Number(match[3]), path: match[4]! }];
    });
    if (files.length > this.config.maxFiles || files.reduce((total, file) => total + file.bytes, 0) > this.config.maxBytes) throw new Error('Git project source scan limit exceeded; narrow the configured paths');
    const records: ProjectSourceRecord[] = [];
    for (const file of files) {
      const content = await this.git(['cat-file', 'blob', file.oid], 110_000);
      if (!content || /[\x00\ufffd]/.test(content)) continue;
      records.push(this.record(`file:${projectSourceContentHash(file.path)}`, file.path, content, `git:${this.config.id}@${head}:${file.path}`, updatedAt, /\.(md|mdx|txt|rst|adoc)$/i.test(file.path) ? 'document' : 'code'));
    }
    if (this.config.recentCommits > 0) {
      const commits = (await this.git(['rev-list', `--max-count=${this.config.recentCommits}`, head, '--', ...paths])).trim().split('\n').filter(Boolean);
      for (const commit of commits) {
        assertObjectId(commit);
        const changed = (await this.git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit, '--', ...paths])).split('\0').filter(path => path && this.allowed(path));
        if (!changed.length) continue;
        const date = (await this.git(['show', '-s', '--format=%cI', commit])).trim();
        // File names and status are sufficient to expose change evidence without
        // reading deleted secrets or unbounded patches into model context.
        const content = `Commit: ${commit}\nChanged paths in authorized scope:\n${changed.map(path => `- ${path}`).join('\n')}`;
        if (content.length > 100_000) throw new Error('Git change record exceeds the source size limit');
        records.push(this.record(`commit:${commit}`, `Code changes ${commit.slice(0, 12)}`, content, `git:${this.config.id}@${commit}`, date, 'code'));
      }
    }
    return { records: searchProjectSources(request, records), cursor: head };
  }

  private allowed(path: string): boolean {
    if (!this.config.paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false;
    if (/[\x00-\x1f\x7f]/.test(path)) return false;
    return !path.split('/').some(part => /^(?:\.git|\.ssh|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));
  }

  private record(id: string, title: string, content: string, source: string, updatedAt: string, kind: 'document' | 'code'): ProjectSourceRecord {
    return projectSourceRecordSchema.parse({ id: `git:${this.config.id}:${id}`, title: `${this.config.id} / ${title}`, content, source, kind, tenantId: this.config.tenantId, classification: this.config.classification, updatedAt, contentHash: projectSourceContentHash(content) });
  }

  private async git(args: string[], maxBuffer = 2_000_000): Promise<string> {
    // Ignore inherited Git directory/index/config overrides. All Git commands
    // use argument arrays and immutable object IDs, without a shell.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const { stdout } = await execute('git', ['--no-replace-objects', ...args], {
      cwd: this.config.root, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', timeout: 10_000, maxBuffer,
    });
    return stdout;
  }
}

function assertObjectId(value: string): void { if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Invalid Git object ID'); }

/** Each child commits its cursor with its evidence before global selection.
 * A failed sibling or a full Run context cannot consume another child's data. */
export class CombinedProjectSourceProvider implements ProjectSourceProvider, ProjectSourceSyncProvider {
  readonly checkpointIdentity: string;
  constructor(private readonly providers: ProjectSourceProvider[]) {
    this.checkpointIdentity = `combined-v2:${projectSourceProtocolHash(providers.map(provider => provider.checkpointIdentity ?? provider.constructor?.name ?? 'project-source'))}`;
  }
  async health(): Promise<ProjectSourceProviderHealth> {
    const results: ProjectSourceProviderHealth[] = [];
    for (const provider of this.providers) {
      if (!provider.health) {
        results.push({ ready: false, detail: `${provider.constructor?.name ?? 'project source'} health probe unavailable` });
        continue;
      }
      results.push(await provider.health());
    }
    const failed = results.find(result => !result.ready);
    return failed ?? { ready: true, detail: `all ${results.length} project source providers reachable` };
  }
  async search(request: ProjectSourceSearchRequest): Promise<ProjectSourceRecord[]> {
    const records: ProjectSourceRecord[] = [];
    for (const provider of this.providers) records.push(...validateProjectSources(request, await provider.search(request)));
    validateProjectSources({ ...request, maxItems: records.length }, records);
    return searchProjectSources(request, records, false);
  }

  async sync(request: ProjectSourceSyncRequest, checkpoints?: ProjectSourceCheckpointStore): Promise<ProjectSourceSyncResult> {
    if (request.cursor !== undefined && !checkpoints) {
      // Without a durable child snapshot, a reused combined cursor can only
      // be acknowledged. Callers that need reusable context must supply the
      // checkpoint store; this avoids pretending an empty page is a deletion.
      if (!/^[a-f0-9]{64}$/.test(request.cursor)) throw new Error('Combined cursor is malformed or belongs to an unsupported version');
      const receipt = makeSyncReceipt('combined', request, [], request.cursor, { mode: 'unchanged' });
      return validateProjectSourceSync(request, { records: [], nextCursor: request.cursor, receipt });
    }
    const records: ProjectSourceRecord[] = [];
    const children: { cursor: string; records: string; partial: boolean }[] = [];
    const { cursor: _ignoredCursor, ...childRequest } = request;
    for (const provider of this.providers) {
      const result = await synchronizeProjectSources(provider, childRequest, checkpoints);
      records.push(...result.records);
      children.push({ cursor: result.nextCursor, records: projectSourceProtocolHash(result.records), partial: result.scanInProgress });
    }
    validateProjectSources({ ...request, maxItems: records.length }, records);
    const cursor = projectSourceProtocolHash(children);
    const selected = searchProjectSources(request, records, false);
    // Always return a complete bounded view; unchanged children are retained.
    const receipt = { ...makeSyncReceipt('combined', request, selected, cursor, { mode: 'snapshot' }), partial: children.some(child => child.partial) };
    return validateProjectSourceSync(request, { records: selected, nextCursor: cursor, receipt });
  }
}
