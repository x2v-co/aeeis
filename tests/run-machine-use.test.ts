import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileConversationStore } from '../src/adapters/conversation-store.js';
import { DockerSandbox } from '../src/docker-sandbox.js';
import { LocalToolGateway } from '../src/local-tools.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { LocalDispatcher } from '../src/runtime/dispatcher.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';

const image = `sha256:${'a'.repeat(64)}`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!(); });

describe('approved execution uses this Run machine', () => {
  it('opens the machine only after an approved workspace tool, then the reaper collects it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aeeis-run-machine-use-'));
    const filename = join(root, 'tools.json');
    await writeFile(filename, JSON.stringify({
      schemaVersion: 'local-tools/1', workspaceRoot: 'work', stateDirectory: 'state',
      tools: ['glob'], defaultAllowedTools: ['glob'], sandbox: { network: 'none' }, webHosts: [],
    }));
    let container: { Id: string; Image: string; Config: { Labels: Record<string, string> }; State: { Running: boolean } } | undefined;
    const calls: string[][] = [];
    const command = vi.spyOn(DockerSandbox.prototype as unknown as { command: (...args: unknown[]) => Promise<unknown> }, 'command').mockImplementation(async (...values: unknown[]) => {
      const args = values[0] as string[];
      const input = values[2] as string | undefined;
      calls.push(args);
      if (args[0] === 'context') return ok('unix:///tmp/docker.sock');
      if (args[0] === 'image') return ok(`${image} linux`);
      if (args[0] === 'info') return ok('linux');
      if (args[0] === 'create') {
        const labels = Object.fromEntries(args.flatMap((arg, index) => arg === '--label' && args[index + 1] ? [args[index + 1]!.split('=')] : []));
        container = { Id: 'c'.repeat(64), Image: image, Config: { Labels: labels }, State: { Running: false } };
        return ok(container.Id);
      }
      if (args[0] === 'inspect') return container ? ok(JSON.stringify([container])) : { code: 1, stdout: '', stderr: 'No such container' };
      if (args[0] === 'start') { if (container) container.State.Running = true; return ok(); }
      if (args[0] === 'kill') { if (container) container.State.Running = false; return ok(); }
      if (args[0] === 'rm') { container = undefined; return ok(); }
      if (args[0] === 'exec' && args.includes('--interactive')) {
        const request = input ? JSON.parse(input) as { tool?: string } : {};
        return ok(JSON.stringify({ schemaVersion: 'sandbox-output/2', status: 'completed', output: { matches: [] }, files: request.tool === '__snapshot' ? [] : null }));
      }
      return ok();
    });
    const gateway = await LocalToolGateway.load(filename);
    const directory = join(root, 'data');
    const repository = new FileRunRepository(join(directory, 'runs')); await repository.init();
    const store = new FileConversationStore(join(directory, 'conversations')); await store.init();
    const model: ModelAdapter = {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1', promptVersion: 'fixture/1' },
      async complete(request) {
        if (request.system.includes('Plan a real deliverable')) return { value: { summary: 'List the workspace', nodes: [{ id: 'look', title: 'Look', instruction: 'List files in this Run workspace', dependsOn: [] }] } };
        if (request.system.includes('Independently review')) return { value: { verdict: 'accepted', summary: 'The workspace listing is on the receipt', issues: [] } };
        if (request.system.includes('task working-memory summarizer')) {
          const sliceId = (request.input as { slices?: Array<{ id?: string }> }).slices?.[0]?.id;
          return { value: { items: [{ text: 'Untrusted workspace note.', references: sliceId ? [sliceId] : [] }] } };
        }
        const observations = (request.input as { observations?: Array<{ result?: { outputRefs?: string[] } }> }).observations ?? [];
        if (!observations.length) return { value: { type: 'capability', toolId: 'glob', toolVersion: '3', input: { pattern: '**/*', limit: 20 }, purpose: 'List this Run workspace' } };
        return { value: { type: 'finish', title: 'Workspace listed', content: 'Listed the workspace on this Run machine.', evidenceRefs: observations.at(-1)?.result?.outputRefs ?? [] } };
      },
    };
    const engine = new AgentEngine(repository, { model, tools: gateway });
    const dispatcher = new LocalDispatcher(engine);
    const app = buildApp({
      repository, engine, dispatcher, conversationStore: store, tools: gateway, localToolDefaults: ['glob'],
      runMachines: runId => gateway.describe(runId),
      principalTokens: {
        alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
        bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
      },
    });
    cleanup.push(async () => {
      await dispatcher.close(); await gateway.close(); await app.close(); await store.close(); await repository.close();
      await rm(root, { recursive: true, force: true });
    });
    const headers = { authorization: 'Bearer alice' };
    const created = await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { title: '发布', agentId: 'demo.release' } });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json().id as string;
    const taskOf = (body: { tasks: Array<{ title: string; latestRunId?: string; machine?: { state: string; ready: boolean } }> }, title: string) => body.tasks.find(task => task.title === title);
    const discuss = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { text: '先讨论，不看工作区', newTask: { title: '只讨论' }, intent: 'discuss', focus: 'keep', expectedRevision: created.json().revision },
    });
    expect(discuss.statusCode, discuss.body).toBe(200);
    expect(taskOf(discuss.json().conversation, '只讨论')?.machine).toBeUndefined();
    expect(calls.filter(args => args[0] === 'create')).toEqual([]);
    const started = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: {
        text: '看一下工作区', newTask: { title: '看工作区' }, intent: 'execute', focus: 'keep',
        expectedRevision: discuss.json().conversation.revision,
        runOptions: { allowedTools: ['glob'], executionReview: 'required' },
      },
    });
    expect(started.statusCode, started.body).toBe(202);
    const runId = started.json().runId as string;
    expect(taskOf(started.json().conversation, '看工作区')?.machine).toEqual({ state: 'absent', ready: false });
    expect(taskOf(started.json().conversation, '只讨论')?.machine).toBeUndefined();
    let run = await repository.get(runId);
    for (let attempt = 0; attempt < 100 && run.status !== 'needs_approval' && run.status !== 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      run = await repository.get(runId);
    }
    expect(run.status, run.error).toBe('needs_approval');
    const frozen = { allowedTools: [...run.allowedTools], allowedAgents: [...run.allowedAgents], maxModelCalls: run.maxModelCalls, modelBudget: run.modelBudget, externalBudget: run.externalBudget };
    expect(frozen.allowedTools).toEqual(['glob']);
    expect(calls.filter(args => args[0] === 'create')).toEqual([]);
    const waiting = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers });
    expect(taskOf(waiting.json(), '看工作区')?.machine).toEqual({ state: 'absent', ready: false });
    const talked = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { text: '讨论不启动机器', expectedRevision: waiting.json().revision, intent: 'discuss' },
    });
    expect(talked.statusCode, talked.body).toBe(200);
    expect(talked.json().runId).toBeUndefined();
    expect(taskOf(talked.json().conversation, '看工作区')?.machine).toEqual({ state: 'absent', ready: false });
    expect(calls.filter(args => args[0] === 'create')).toEqual([]);
    const plan = run.plans.at(-1)!;
    const approved = await app.inject({ method: 'POST', url: `/api/runs/${runId}/approve`, headers, payload: { planHash: plan.hash, planVersion: plan.version } });
    expect(approved.statusCode, approved.body).toBe(200);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      run = await repository.get(runId);
      const view = taskOf((await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers })).json(), '看工作区');
      if (view?.machine?.state === 'present' && view.machine.ready) break;
      if (run.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(run.status, run.error).not.toBe('failed');
    const present = taskOf((await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers })).json(), '看工作区');
    expect(present?.machine).toEqual({ state: 'present', ready: true });
    const createdArgs = calls.filter(args => args[0] === 'create');
    expect(createdArgs).toHaveLength(1);
    expect(createdArgs[0]?.join(' ')).toContain(`aeeis.run=${runId}`);
    expect(createdArgs[0]?.join(' ')).toContain('--network=none');
    expect(createdArgs[0]?.join(' ')).not.toMatch(/--(?:mount|volume|privileged)=|docker\.sock/);
    expect(command).toHaveBeenCalled();
    for (let attempt = 0; attempt < 200 && run.status !== 'succeeded' && run.status !== 'failed'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      run = await repository.get(runId);
    }
    expect(run.status, run.error).toBe('succeeded');
    expect({ allowedTools: [...run.allowedTools], allowedAgents: [...run.allowedAgents], maxModelCalls: run.maxModelCalls, modelBudget: run.modelBudget, externalBudget: run.externalBudget }).toEqual(frozen);
    await gateway.reap(async id => (await repository.get(id)).status);
    const collected = taskOf((await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers })).json(), '看工作区');
    expect(collected?.machine).toEqual({ state: 'released', ready: false });
    const creates = calls.filter(args => args[0] === 'create').length;
    const after = await app.inject({
      method: 'POST', url: `/api/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { text: '收掉以后继续讨论', expectedRevision: (await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers })).json().revision, intent: 'discuss' },
    });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().runId).toBeUndefined();
    expect(taskOf(after.json().conversation, '看工作区')?.machine).toEqual({ state: 'released', ready: false });
    expect(taskOf(after.json().conversation, '只讨论')?.machine).toBeUndefined();
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(creates);
    const other = await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers: { authorization: 'Bearer bob' } });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain(runId);
    expect(other.body).not.toContain('present');
  });
});
