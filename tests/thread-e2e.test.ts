import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ThreadService } from '../src/application/thread-service.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelAdapter, ModelRequest } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { fetchRunCli } from './support/fetch-run-cli.js';

describe('threads through HTTP and the shipped CLI', () => {
  it('executes independent runs, freezes redacted history, replays after restart, and exports/revokes cutoff shares', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-thread-e2e-'));
    const requests: ModelRequest[] = [];
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'test/1' },
      async complete(request) {
        requests.push(request);
        const input = request.input as { goal: string; answers?: unknown[]; threadHistory?: { sources: Array<{ id: string; origin: { ref: string } }> } };
        if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'Make a report', nodes: [{ id: 'report', title: 'Report', instruction: 'Use presented evidence', dependsOn: [] }] } };
        if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'Supported report', issues: [] } };
        if (input.goal === 'Follow up' && !input.answers?.length) return { value: { type: 'question', question: 'Which audience?' } };
        const source = input.threadHistory?.sources.find(source => !source.origin.ref.includes('#'));
        return { value: { type: 'finish', title: 'Report', content: input.goal === 'Root' ? 'Root evidence: approved facts. Bearer root-secret-credential' : `${input.goal} report based on root evidence.`, evidenceRefs: source ? [source.id] : [] } };
      },
    };
    let repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const notify = vi.fn(async () => undefined);
    const start = () => buildApp({ repository, engine: new AgentEngine(repository, model), workerToken: 'worker',
      dispatcher: { notify, close: async () => undefined }, principalTokens: {
        alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
        bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
        outsider: { id: 'alice', tenantId: 'team-b', roles: ['owner'] },
      } });
    let app = start(); const base = 'http://127.0.0.1:4323';
    const call = async (method: string, path: string, payload?: unknown, token = 'alice', key?: string) => {
      const response = await app.inject({ method: method as 'GET' | 'POST' | 'DELETE', url: path, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'idempotency-key': key } : {}),
      }, ...(payload === undefined ? {} : { payload }) });
      const text = response.body;
      return { status: response.statusCode, headers: response.headers, body: text, data: text ? JSON.parse(text) : undefined };
    };
    const advance = async (id: string) => {
      const response = await call('POST', `/internal/runs/${id}/advance`, undefined, 'worker');
      expect(response.status).toBe(200); return response.data.status;
    };
    const planAndApprove = async (id: string) => {
      expect(await advance(id)).toBe('needs_approval');
      const run = (await call('GET', `/api/runs/${id}`)).data;
      expect(run.approval.approved).toBe(false);
      expect((await call('POST', `/api/runs/${id}/approve`, { planHash: run.plans.at(-1).hash })).status).toBe(200);
    };
    const finish = async (id: string) => {
      for (let tick = 0; tick < 5; tick++) if (await advance(id) === 'succeeded') return;
      throw new Error('Run did not finish');
    };
    try {
      // Existing unthreaded creation remains usable; attach it through HTTP.
      const root = (await call('POST', '/api/runs', { goal: 'Root' })).data;
      const created = await call('POST', '/api/threads', { title: 'Reports', initialRunId: root.id });
      expect(created.status).toBe(201); const thread = created.data, url = `/api/threads/${thread.id}/runs`;
      await planAndApprove(root.id); await finish(root.id);
      const parent = (await call('GET', `/api/runs/${root.id}`)).data;
      const payload = { request: { goal: 'Follow up' } };
      const response = await call('POST', url, payload, 'alice', 'followup-key');
      expect(response.status).toBe(202); const child = response.data;
      expect(child).toMatchObject({ threadId: thread.id, threadSequence: 2, parentRunId: root.id });
      expect(JSON.stringify(child.context.threadHistory)).toContain('Root evidence: approved facts');
      expect(JSON.stringify(child.context.threadHistory)).not.toContain('root-secret-credential');
      expect((await call('POST', url, payload, 'alice', 'followup-key')).data).toEqual(child);
      expect((await call('POST', url, { request: { goal: 'Different' } }, 'alice', 'followup-key')).status).toBe(409);
      await planAndApprove(child.id);
      expect(await advance(child.id)).toBe('needs_input');
      expect((await call('POST', url, { request: { goal: 'Too early' } }, 'alice', 'live-parent')).status).toBe(409);
      expect((await call('POST', `/api/runs/${child.id}/answer`, { answer: 'The team' })).status).toBe(200);
      await finish(child.id);
      expect((await call('GET', `/api/runs/${child.id}`)).data.answers).toMatchObject([{ answer: 'The team' }]);
      const phases = requests.filter(request => (request.input as { goal: string }).goal === 'Follow up');
      expect(phases).toHaveLength(4); // Planner, question, executor, reviewer.
      for (const request of phases) {
        const history = (request.input as { threadHistory: { hash: string; content: string } }).threadHistory;
        expect(history.hash).toBe(child.context.threadHistory.hash);
        expect(history.content).toContain('Root evidence'); expect(history.content).not.toContain('root-secret-credential');
        expect(request.system).toContain('untrusted historical evidence');
      }
      expect((await call('GET', `/api/runs/${root.id}`)).data).toEqual(parent);

      // Include a private branch before capturing the share, then append a later run.
      const privateRun = (await call('POST', url, { request: { goal: 'Private branch', privacy: 'private' }, parentRunId: root.id }, 'alice', 'private-key')).data;
      expect(privateRun).toMatchObject({ threadSequence: 3, parentRunId: root.id });
      await planAndApprove(privateRun.id); await finish(privateRun.id);
      const shared = (await call('POST', `/api/threads/${thread.id}/share`, {})).data;
      expect(shared.throughSequence).toBe(3);
      const later = (await call('POST', url, { request: { goal: 'Later branch' }, parentRunId: child.id }, 'alice', 'later-key')).data;
      expect(later.threadSequence).toBe(4);
      const beforeRestart = requests.length;
      await app.close(); await repository.close();
      repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
      await new ThreadService(repository, new AgentEngine(repository, model)).recover();
      app = start();
      const replay = await call('POST', url, payload, 'alice', 'followup-key');
      expect(replay.data.id).toBe(child.id); expect(replay.data.threadSequence).toBe(child.threadSequence); expect(replay.data.context.threadHistory.hash).toBe(child.context.threadHistory.hash); expect(requests).toHaveLength(beforeRestart);
      const timeline = (await call('GET', `/api/threads/${thread.id}?limit=2`)).data;
      expect(timeline.runs.map((run: { id: string }) => run.id)).toEqual([root.id, child.id]);
      expect(timeline.nextAfterSequence).toBe(2);
      expect((await call('GET', `/api/threads/${thread.id}?afterSequence=2`)).data.runs.map((run: { id: string }) => run.id)).toEqual([privateRun.id, later.id]);
      for (const token of ['bob', 'outsider']) {
        expect((await call('GET', `/api/threads/${thread.id}/debug-bundle`, undefined, token)).status).toBe(404);
        expect((await call('POST', url, payload, token, 'unauthorized')).status).toBe(404);
      }
      const view = await call('GET', `/api/share/${shared.token}`, undefined, '');
      expect(view.status).toBe(200); expect(view.headers['cache-control']).toBe('no-store');
      expect(view.data).toMatchObject({ kind: 'thread', throughSequence: 3 });
      expect(view.data.runs.map((run: { id: string }) => run.id)).toEqual([root.id, child.id]);
      for (const text of ['root-secret-credential', 'threadHistory', privateRun.id, 'Private branch', later.id, 'Later branch']) expect(view.body).not.toContain(text);
      expect((await call('GET', `/api/threads/${thread.id}`, undefined, shared.token)).status).toBe(401);
      const download = (input: string, token?: string) => fetchRunCli(input, directory, { AEEIS_BASE_URL: base, AEEIS_TOKEN: token ?? '' }, async request => {
        expect(new URL(request.url).origin).toBe(base); expect(request.redirect).toBe('error');
        const response = await app.inject({ url: new URL(request.url).pathname, headers: request.headers });
        return { status: response.statusCode, body: response.body };
      });
      for (const input of [`${base}${shared.url}`, shared.token, thread.id, `${base}/threads/${thread.id}`]) {
        const owner = input.includes('thread_');
        const filename = await download(input, owner ? 'alice' : 'unused-installation-token');
        const path = join(directory, filename), text = await readFile(path, 'utf8'), bundle = JSON.parse(text);
        expect(bundle).toMatchObject({ schemaVersion: 'aeeis-thread-debug-bundle/1', kind: 'thread', access: owner ? 'owner' : 'share', thread: { id: thread.id }, throughSequence: owner ? 4 : 3 });
        expect(bundle.runs.map((run: { id: string }) => run.id)).toEqual(owner ? [root.id, child.id, privateRun.id, later.id] : [root.id, child.id]);
        expect(text).not.toContain('root-secret-credential');
        if (owner) expect(bundle.runs[1].context.threadHistory.hash).toBe(child.context.threadHistory.hash);
        else for (const value of ['threadHistory', privateRun.id, later.id]) expect(text).not.toContain(value);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      expect((await call('DELETE', `/api/threads/${thread.id}/share/${shared.id}`)).status).toBe(204);
      for (const path of [shared.url, `/api/share/${shared.token}`, `/api/share/${shared.token}/debug-bundle`]) expect((await call('GET', path, undefined, '')).status).toBe(404);
      await expect(download(`${base}${shared.url}`)).rejects.toThrow('HTTP 404');
    } finally { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  }, 30000);
});
