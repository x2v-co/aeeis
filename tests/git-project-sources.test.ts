import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { CombinedProjectSourceProvider, GitProjectSourceProvider } from '../src/adapters/git-project-sources.js';
import { FileProjectSourceCheckpointStore, makeSyncReceipt, projectSourceContentHash, synchronizeProjectSources, type ProjectSourceRecord, type ProjectSourceSyncProvider } from '../src/project-sources.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { FileRunRepository } from '../src/runtime/repository.js';

const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root })).stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aeeis-git-source-')); directories.push(root);
  await git(root, 'init');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'plan.md'), 'Release blocked by the migration.');
  await writeFile(join(root, 'docs', '.env'), 'SECRET=do-not-import');
  await writeFile(join(root, 'docs', 'private.key'), 'do-not-import');
  await writeFile(join(root, 'docs', 'binary.dat'), Buffer.from([0, 1, 2, 0]));
  await writeFile(join(root, 'outside.md'), 'outside approved scope');
  await symlink('../outside.md', join(root, 'docs', 'link.md'));
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'Initial project');
  return root;
}
const request = { query: 'release', tenantId: 'team-a', maxItems: 10 };
function provider(root: string) { return new GitProjectSourceProvider({ id: 'demo', root, tenantId: 'team-a', paths: ['docs'] }); }

describe('Git project source connector', () => {
  it('reads only committed authorized text and binds provenance to the commit', async () => {
    const root = await fixture();
    const head = await git(root, 'rev-parse', 'HEAD');
    expect(await provider(root).health()).toMatchObject({ ready: true });
    expect(await provider(join(root, 'docs')).health()).toMatchObject({ ready: false, detail: 'configured Git root is not the repository root' });
    await writeFile(join(root, 'docs', 'plan.md'), 'uncommitted content');
    await writeFile(join(root, 'docs', 'untracked.md'), 'untracked secret');
    const records = await provider(root).search({ ...request, query: '' });
    const files = records.filter(record => record.id.includes(':file:'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ content: 'Release blocked by the migration.', kind: 'document', tenantId: 'team-a', classification: 'internal', source: `git:demo@${head}:docs/plan.md`, contentHash: projectSourceContentHash('Release blocked by the migration.') });
    const changes = records.find(record => record.id.includes(':commit:'))!;
    expect(changes.content).toContain('docs/plan.md');
    expect(changes.content).not.toContain('.env');
    expect(changes.content).not.toContain('private.key');
    expect(changes.content).not.toContain('outside.md');
    expect(JSON.stringify(records)).not.toContain('do-not-import');
  }, 15_000);

  it('refreshes at a new commit while previous Run context stays frozen', async () => {
    const root = await fixture();
    const sources = provider(root);
    const repository = new FileRunRepository(join(root, 'runs')); await repository.init();
    try {
      const engine = new AgentEngine(repository, { projectSources: sources, model: { pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test/1' }, complete: async () => { throw new Error('not invoked'); } } });
      const run = await engine.create({ goal: 'Summarize release blockers', projectSourceQuery: 'release' }, 'alice', 'team-a');
      expect(run.context.sources).toHaveLength(1);
      const before = run.context.sources[0]!;
      await writeFile(join(root, 'docs', 'plan.md'), 'Release migration complete.');
      await git(root, 'add', 'docs/plan.md');
      await git(root, 'commit', '-m', 'Migration completed');
      const after = (await sources.search(request))[0]!;
      expect(after.content).toBe('Release migration complete.');
      expect(after.source).not.toBe(before.source);
      expect(after.contentHash).not.toBe(before.hash);
      expect((await repository.get(run.id)).context.sources[0]).toEqual(before);
    } finally { await repository.close(); }
  });

  it('denies other tenants and insufficient classifications before touching Git', async () => {
    const sources = provider('/nonexistent/repository');
    expect(await sources.search({ ...request, tenantId: 'team-b' })).toEqual([]);
    expect(await sources.search({ ...request, allowedClassifications: ['public'] })).toEqual([]);
  });

  it('enforces scan limits and literal path configuration', async () => {
    const root = await fixture();
    await expect(new GitProjectSourceProvider({ id: 'demo', root, tenantId: 'team-a', paths: ['docs'], maxBytes: 1 }).search(request)).rejects.toThrow('scan limit');
    expect(() => new GitProjectSourceProvider({ id: 'demo', root, tenantId: 'team-a', paths: ['../outside'] })).toThrow();
    expect(() => new GitProjectSourceProvider({ id: 'demo', root, tenantId: 'team-a', paths: ['.'] })).toThrow();
    expect(await new GitProjectSourceProvider({ id: 'demo', root, tenantId: 'team-a', paths: ['*'] }).search(request)).toEqual([]);
    await expect(provider(join(root, 'docs')).search(request)).rejects.toThrow('repository root');
  });

  it('merges sources with global result limits and rejects duplicate identities', async () => {
    const root = await fixture();
    const first = provider(root);
    const second = new GitProjectSourceProvider({ id: 'second', root, tenantId: 'team-a', paths: ['docs'] });
    const combined = new CombinedProjectSourceProvider([first, second]);
    expect(await combined.search({ ...request, maxItems: 1 })).toHaveLength(1);
    await expect(new CombinedProjectSourceProvider([first, first]).search(request)).rejects.toThrow('duplicate');
  });

  it('keeps the complete bounded view even when the combined cursor is unchanged', async () => {
    const root = await fixture();
    const combined = new CombinedProjectSourceProvider([provider(root)]);
    const first = await combined.sync({ query: 'release', maxItems: 10, tenantId: 'team-a' });
    expect(first.records.length).toBeGreaterThan(0);
    const second = await combined.sync({ query: 'release', maxItems: 10, tenantId: 'team-a', cursor: first.nextCursor });
    expect(second.records).toEqual([]);
    expect(second.receipt.changed).toBe(false);
  });

  it('keeps opaque child cursors separate for paginated connectors', async () => {
    const seen: string[] = [];
    const make = (name: string, cursor: string): ProjectSourceSyncProvider => {
      const record: ProjectSourceRecord = {
        id: `task:${name}`, title: `${name} task`, content: `${name} content`, source: name, kind: 'task',
        tenantId: 'team-a', classification: 'internal', updatedAt: '2026-09-19T00:00:00.000Z', contentHash: projectSourceContentHash(`${name} content`),
      };
      return {
        checkpointIdentity: name,
        search: async () => [record],
        sync: async request => {
          seen.push(`${name}:${request.cursor ?? 'start'}`);
          const records = request.cursor === cursor ? [] : [record];
          const receipt = makeSyncReceipt(name, request, records, cursor, { mode: request.cursor === cursor ? 'unchanged' : 'snapshot' });
          return { records, nextCursor: cursor, receipt };
        },
      };
    };
    const combined = new CombinedProjectSourceProvider([make('linear', 'lin-v2'), make('jira', 'jira-v4')]);
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-combined-checkpoint-')); directories.push(directory);
    const checkpoints = new FileProjectSourceCheckpointStore(join(directory, 'checkpoints.json')); await checkpoints.init();
    try {
    const first = await synchronizeProjectSources(combined, { query: 'task', maxItems: 10, tenantId: 'team-a' }, checkpoints);
    expect(first.records).toHaveLength(2);
    const second = await synchronizeProjectSources(combined, { query: 'task', maxItems: 10, tenantId: 'team-a', cursor: first.nextCursor }, checkpoints);
    expect(second.records).toEqual(first.records);
    expect(seen).toEqual(['linear:start', 'jira:start', 'linear:lin-v2', 'jira:jira-v4']);
    expect(second.receipt.changed).toBe(false);
    } finally { await checkpoints.close(); }
  });
});
