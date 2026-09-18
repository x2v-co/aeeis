import Fastify from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AgentEngine, Conflict, event } from './engine.js';
import { NotFound, type RunRepository } from './repository.js';
import type { Dispatcher } from './dispatcher.js';
import { brainClaimInputSchema, type BrainGrant, type GovernedBrain } from '../brain.js';
import type { FileBrainStore } from '../brain.js';

interface Options { repository: RunRepository; engine?: AgentEngine; dispatcher?: Dispatcher; token?: string; workerToken?: string; brain?: GovernedBrain; brainStore?: FileBrainStore }
function matches(expected: string | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(`Bearer ${expected}`), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function buildApp(options: Options) {
  const app = Fastify({ bodyLimit: 700000, logger: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return reply.code(403).send({ error: 'Untrusted host' });
    if (request.headers.origin && request.headers.origin !== `http://${host}`) return reply.code(403).send({ error: 'Cross-origin access denied' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Cross-site access denied' });
    if (request.url.startsWith('/internal/')) {
      if (!matches(options.workerToken, request.headers.authorization)) return reply.code(401).send({ error: 'Worker authentication required' });
    } else if (request.url.startsWith('/api/') && options.token && !matches(options.token, request.headers.authorization)) {
      return reply.code(401).send({ error: 'Local access token required' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', issues: error.issues.map(i => ({ path: i.path, message: i.message })) });
    if (error instanceof NotFound) return reply.code(404).send({ error: error.message });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    const e = error as { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'Invalid HTTP request' });
    console.error('Request failed', error instanceof Error ? error.name : 'Error');
    return reply.code(500).send({ error: 'Internal operation failed; inspect the server log' });
  });
  app.get('/health', async () => ({ status: 'ok', service: 'aeeis-agent' }));
  const assets: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  for (const [route, [file, type]] of Object.entries(assets)) {
    app.get(route, async (_request, reply) => reply.type(type).send(await readFile(file === 'app.js' ? new URL('../../dist/ui/app.js', import.meta.url) : new URL(`../../public/${file}`, import.meta.url), 'utf8')));
  }
  app.get('/api/status', async () => ({ modelConfigured: Boolean(options.engine), model: options.engine?.modelPin ?? null, runner: options.dispatcher?.constructor.name ?? 'unconfigured', mode: 'single-owner-local' }));
  app.get<{ Params: { scope: string }; Querystring: { classification?: 'public' | 'internal' | 'confidential' | 'private' } }>('/api/brain/:scope', async request => {
    if (!options.brain) return { error: 'Brain is not configured' };
    return { scope: request.params.scope, claims: options.brain.read(request.params.scope, 'owner', request.query.classification ?? 'internal') };
  });
  app.post('/api/brain/claims', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const claim = options.brain.addClaim(brainClaimInputSchema.parse(request.body), 'owner');
    await options.brainStore.save(options.brain); return claim;
  });
  app.post('/api/brain/grants', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    const grant = options.brain.grant(request.body as Omit<BrainGrant, 'id'>, 'owner');
    await options.brainStore.save(options.brain); return grant;
  });
  app.post<{ Params: { id: string } }>('/api/brain/grants/:id/revoke', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    options.brain.revoke(request.params.id, 'owner'); await options.brainStore.save(options.brain); return { status: 'revoked' };
  });
  app.delete<{ Params: { scope: string } }>('/api/brain/:scope', async request => {
    if (!options.brain || !options.brainStore) throw new Error('Brain is not configured');
    options.brain.deleteScope(request.params.scope, 'owner'); await options.brainStore.save(options.brain); return { status: 'deleted' };
  });
  app.get('/api/runs', async () => (await options.repository.list()).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ id, goal, status, updatedAt }) => ({ id, goal, status, updatedAt })));
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => options.repository.get(request.params.id));
  async function notify(id: string): Promise<void> {
    try { await options.dispatcher?.notify(id); }
    catch {
      await options.repository.mutate(id, run => { event(run, 'dispatch.failed'); run.error = 'Execution service unavailable. Restore it and use resume dispatch.'; });
    }
  }
  app.post('/api/runs', async (request, reply) => {
    if (!options.engine || !options.dispatcher) return reply.code(503).send({ error: 'Configure AEEIS_MODEL_BASE_URL and AEEIS_MODEL before starting an agent run' });
    const run = await options.engine.create(request.body);
    await notify(run.id); return reply.code(202).send({ id: run.id });
  });
  app.post<{ Params: { id: string; action: string } }>('/api/runs/:id/:action', async (request, reply) => {
    if (!options.engine) return reply.code(503).send({ error: 'Model is not configured' });
    const { id, action } = request.params;
    await options.repository.get(id);
    if (action !== 'dispatch') await options.engine.command(id, action, request.body);
    await notify(id); return options.repository.get(id);
  });
  app.post<{ Params: { id: string } }>('/internal/runs/:id/advance', async (request, reply) => {
    if (!options.engine) return reply.code(503).send({ error: 'Model is not configured' });
    return { status: await options.engine.advance(request.params.id) };
  });
  return app;
}
