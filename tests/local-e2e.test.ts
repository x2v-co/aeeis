import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentEngine } from '../src/runtime/engine.js';
import { HttpModelAdapter } from '../src/runtime/model.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { LocalDispatcher } from '../src/runtime/dispatcher.js';
import { buildApp } from '../src/runtime/http.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

describe('local HTTP model to AEEIS run', () => {
  it('executes a run through the public API using an explicit fixture model', async () => {
    const modelServer = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      const system = parsed.messages[0]!.content;
      const input = JSON.parse(parsed.messages[1]!.content) as { goal?: string; sourceCatalog?: Array<{ id: string }>; observations?: unknown[] };
      let value: unknown;
      if (system.includes('Plan a real deliverable')) value = { summary: 'A fixture plan', nodes: [{ id: 'deliver', title: 'Deliver', instruction: 'Write a grounded report', dependsOn: [] }] };
      else if (system.includes('Independently review')) value = { verdict: 'accepted', summary: 'Fixture review passed', issues: [] };
      else if (!(input.observations?.length ?? 0)) value = { type: 'tool', tool: 'sources.read', argument: input.sourceCatalog?.[0]?.id };
      else value = { type: 'finish', title: 'Fixture report', content: 'The report is grounded in the supplied source.', evidenceRefs: [input.sourceCatalog?.[0]?.id] };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    await new Promise<void>(resolve => { servers.push(modelServer); modelServer.listen(0, '127.0.0.1', resolve); });
    const modelPort = (modelServer.address() as { port: number }).port;
    const repository = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-e2e-'))); await repository.init();
    const engine = new AgentEngine(repository, new HttpModelAdapter('http://127.0.0.1:' + modelPort, 'fixture-model', ''));
    const dispatcher = new LocalDispatcher(engine);
    const app = buildApp({ repository, engine, dispatcher });
    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: { goal: 'Write a release report', materials: [{ title: 'Release brief', source: 'fixture', content: 'Ship with evidence.' }] } });
    expect(created.statusCode).toBe(202);
    const id = created.json().id as string;
    let run: { status: string; plans: unknown[]; artifacts: Array<{ title: string }>; review?: { verdict: string } } | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      run = (await app.inject({ method: 'GET', url: '/api/runs/' + id })).json();
      if (run!.status === 'needs_approval') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(run?.status).toBe('needs_approval');
    const plan = (run?.plans.at(-1) as { hash: string });
    const approved = await app.inject({ method: 'POST', url: '/api/runs/' + id + '/approve', payload: { planHash: plan.hash } });
    expect(approved.statusCode).toBe(200);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      run = (await app.inject({ method: 'GET', url: '/api/runs/' + id })).json();
      if (run!.status === 'succeeded' || run!.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(run?.status, run?.error).toBe('succeeded');
    expect(run?.artifacts[0]?.title).toBe('Fixture report');
    expect(run?.review?.verdict).toBe('accepted');
    await app.close(); await dispatcher.close(); await repository.close();
  });
});
