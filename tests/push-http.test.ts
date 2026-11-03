import { afterEach, describe, expect, it } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { buildApp } from '../src/runtime/http.js';
import type { ModelRequest } from '../src/runtime/model.js';
import { InMemoryPushStore, generateVapidKeys } from '../src/push.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const alice = { authorization: 'Bearer alice' };
const bob = { authorization: 'Bearer bob' };
const model = { pin: { model: 'push-fixture', endpoint: 'http://localhost', promptVersion: 'push/1' }, complete: async (request: ModelRequest) => {
  if (request.system.includes('Plan a real deliverable')) return { value: { summary: '先查数据再写说明', nodes: [{ id: 'work', title: 'Work', instruction: 'Do it', dependsOn: [] }] } };
  throw new Error('unexpected model call');
} };
function webSubscription() {
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  return { channel: 'web', label: 'Chrome', endpoint: `https://push.example.test/${randomBytes(4).toString('hex')}`, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
function app(push = true) {
  const repository = new InMemoryRunRepository();
  const engine = new AgentEngine(repository, model);
  const store = new InMemoryPushStore();
  const vapid = generateVapidKeys();
  const server = buildApp({
    repository, engine, dispatcher: { notify: async () => undefined, close: async () => undefined },
    principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] } },
    ...(push ? { push: { store, channels: ['web' as const], webPublicKey: vapid.publicKey } } : {}),
  });
  cleanup.push(() => server.close());
  return { server, repository, engine, store, vapid };
}

describe('push routes', () => {
  it('tells a page which channels this AEEIS can push to', async () => {
    const f = app();
    expect((await f.server.inject({ method: 'GET', url: '/api/push/config', headers: alice })).json()).toEqual({ web: { publicKey: f.vapid.publicKey }, apns: false, fcm: false });
    const off = app(false);
    expect((await off.server.inject({ method: 'GET', url: '/api/push/config', headers: alice })).json()).toEqual({ web: null, apns: false, fcm: false });
    expect((await off.server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: alice, payload: webSubscription() })).statusCode).toBe(409);
  });

  it('subscribes a device, lists it without its push secrets, and lets only its owner remove it', async () => {
    const f = app();
    const created = await f.server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: alice, payload: webSubscription() });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json() as { id: string };
    const listed = await f.server.inject({ method: 'GET', url: '/api/push/subscriptions', headers: alice });
    expect(listed.json().items).toEqual([{ id, channel: 'web', label: 'Chrome', createdAt: expect.any(String) }]);
    expect(listed.body).not.toContain('endpoint');
    expect((await f.server.inject({ method: 'GET', url: '/api/push/subscriptions', headers: bob })).json().items).toEqual([]);
    expect((await f.server.inject({ method: 'DELETE', url: `/api/push/subscriptions/${id}`, headers: bob })).statusCode).toBe(404);
    expect((await f.server.inject({ method: 'DELETE', url: `/api/push/subscriptions/${id}`, headers: alice })).statusCode).toBe(204);
    expect((await f.server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: alice, payload: { channel: 'apns', label: 'iPhone', token: 'ab'.repeat(32) } })).statusCode).toBe(409);
    expect((await f.server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: alice, payload: { ...webSubscription(), endpoint: 'http://push.example.test/x' } })).statusCode).toBe(400);
  });

  it('collects a person\'s waiting approvals as push messages with a link to the Run', async () => {
    const f = app();
    const run = await f.engine.create({ goal: '整理上线说明' }, 'alice', 'team-a');
    await f.engine.advance(run.id);
    expect((await f.repository.get(run.id)).status).toBe('needs_approval');
    expect(await f.server.aeeisPushMessages!({ owner: 'alice', tenantId: 'team-a' })).toEqual([{ key: `run:${run.id}:needs_approval`, url: `/runs/${run.id}`, title: '等你批准：整理上线说明', body: '先查数据再写说明' }]);
    expect(await f.server.aeeisPushMessages!({ owner: 'bob', tenantId: 'team-a' })).toEqual([]);
  });
});

describe('installable web app', () => {
  it('serves the manifest, a service worker allowed at the root, and the icons', async () => {
    const f = app();
    const manifest = await f.server.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
    expect(manifest.json()).toMatchObject({ name: 'AEEIS', display: 'standalone', start_url: '/' });
    for (const icon of manifest.json().icons as Array<{ src: string }>) {
      const response = await f.server.inject({ method: 'GET', url: icon.src });
      expect(response.statusCode, icon.src).toBe(200);
      expect(response.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    }
    const worker = await f.server.inject({ method: 'GET', url: '/sw.js' });
    expect(worker.headers['service-worker-allowed']).toBe('/');
    expect(worker.body).toContain("addEventListener('push'");
    expect((await f.server.inject({ method: 'GET', url: '/icons/../package.json' })).statusCode).toBe(404);
    expect((await f.server.inject({ method: 'GET', url: '/' })).body).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  });
});
