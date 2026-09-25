import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeishuAppProjectionSink, FeishuWebhookProjectionSink, FileProjectionOutbox, HermesCliProjectionSink, HttpProjectionSink, ProjectionOutcomeUnknown, RoutingProjectionSink, type ProjectionEvent, type ProjectionSink } from '../src/collaboration-projection.js';
import { createServer, type Server } from 'node:http';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

describe('collaboration projection outbox', () => {
  it('uses a read-only same-origin health endpoint without delivering a projection', async () => {
    let posts = 0;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ status: 'ok' })); return; }
      if (request.method === 'POST' && request.url === '/events') { posts += 1; response.end(JSON.stringify({ schemaVersion: 'aeeis-projection-ack/1', accepted: true })); return; }
      response.statusCode = 404; response.end('{}');
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const sink = new HttpProjectionSink(`http://127.0.0.1:${address.port}/events`, 'projection-token', 5000, `http://127.0.0.1:${address.port}/health`);
    await expect(sink.health()).resolves.toMatchObject({ ready: true, detail: 'provider health endpoint reachable' });
    expect(posts).toBe(0);
  });

  it('accepts Room lifecycle snapshots produced by the domain projection intent', async () => {
    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-projection-room-'))); await outbox.init();
    const event = await outbox.enqueue({ channel: 'hermes', destination: 'room.1', aggregateType: 'room', aggregateId: 'room_123', payload: { id: 'room_123', status: 'active' }, idempotencyKey: 'hermes:room.1:room_123:v1' });
    expect(event).toMatchObject({ aggregateType: 'room', aggregateId: 'room_123', status: 'pending' });
    await outbox.close();
  });

  it('deduplicates snapshots by channel and idempotency key', async () => {
    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-projection-'))); await outbox.init();
    const input = { channel: 'feishu', destination: 'chat.1', aggregateType: 'debate' as const, aggregateId: 'debate.1', payload: { status: 'active' }, idempotencyKey: 'feishu:debate.1:v1' };
    const first = await outbox.enqueue(input); const second = await outbox.enqueue({ ...input, payload: { status: 'changed' } });
    expect(second.id).toBe(first.id); expect((await outbox.list())).toHaveLength(1); expect(second.snapshotHash).toBe(first.snapshotHash);
    await outbox.close();
  });

  it('records failed delivery and allows a later retry to settle delivered', async () => {
    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-projection-retry-'))); await outbox.init();
    const event = await outbox.enqueue({ channel: 'hermes', destination: 'group.1', aggregateType: 'debate', aggregateId: 'debate.2', payload: { message: 'hello' }, idempotencyKey: 'hermes:debate.2:v1' });
    let attempts = 0;
    const sink: ProjectionSink = { deliver: async (_event: ProjectionEvent) => { attempts += 1; if (attempts === 1) throw new Error('temporary sink failure'); return { externalId: 'msg.1' }; } };
    await expect(outbox.deliver(event.id, sink)).rejects.toThrow('temporary');
    expect((await outbox.get(event.id)).status).toBe('failed');
    const delivered = await outbox.deliver(event.id, sink);
    expect(delivered.status).toBe('delivered'); expect(delivered.attempts).toBe(2); expect(delivered.externalId).toBe('msg.1');
    await outbox.close();
  });

  it('holds an ambiguous delivery as unknown until an explicit reconciliation', async () => {
    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-projection-unknown-'))); await outbox.init();
    const event = await outbox.enqueue({ channel: 'hermes', destination: 'group.unknown', aggregateType: 'competition', aggregateId: 'competition.1', payload: { status: 'active' }, idempotencyKey: 'hermes:competition.1:v1' });
    const sink: ProjectionSink = { deliver: async () => { throw new ProjectionOutcomeUnknown('response lost'); } };
    await expect(outbox.deliver(event.id, sink)).rejects.toThrow('response lost');
    expect((await outbox.get(event.id)).status).toBe('unknown');
    await expect(outbox.deliver(event.id, sink)).resolves.toMatchObject({ status: 'unknown', attempts: 1 });
    const reconciled = await outbox.reconcile(event.id, 'completed', 'Provider receipt confirmed', 'msg.confirmed');
    expect(reconciled.status).toBe('delivered'); expect(reconciled.externalId).toBe('msg.confirmed');
    await expect(outbox.reconcile(event.id, 'failed', 'duplicate')).rejects.toThrow('only unknown');
    await outbox.close();
  });

  it('shares one in-flight delivery and drains pending events with a bounded batch', async () => {
    const outbox = new FileProjectionOutbox(await mkdtemp(join(tmpdir(), 'aeeis-projection-batch-'))); await outbox.init();
    const first = await outbox.enqueue({ channel: 'feishu', destination: 'chat.1', aggregateType: 'debate', aggregateId: 'debate.3', payload: { n: 1 }, idempotencyKey: 'k1' });
    await outbox.enqueue({ channel: 'feishu', destination: 'chat.1', aggregateType: 'debate', aggregateId: 'debate.4', payload: { n: 2 }, idempotencyKey: 'k2' });
    let calls = 0;
    const sink: ProjectionSink = { deliver: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return {}; } };
    const [one, two] = await Promise.all([outbox.deliver(first.id, sink), outbox.deliver(first.id, sink)]);
    expect(one.id).toBe(two.id); expect(calls).toBe(1);
    const drained = await outbox.deliverPending(sink, 10);
    expect(drained.delivered).toBe(1); expect(drained.failed).toBe(0); expect(calls).toBe(2);
    await outbox.close();
  });

  it('renders a bounded Feishu card and refuses private context', async () => {
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      received.push(JSON.parse(body)); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ code: 0, msg: 'ok' }));
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const sink = new FeishuWebhookProjectionSink(`http://127.0.0.1:${address.port}/hook`);
    const event = { schemaVersion: 1 as const, id: 'projection_00000000-0000-4000-8000-000000000001', idempotencyKey: 'feishu:debate.5:v1', channel: 'feishu', destination: 'chat.1', aggregateType: 'debate' as const, aggregateId: 'debate.5', snapshotHash: 'a'.repeat(64), payload: { status: 'active', room: { goal: 'Decide', context: { classification: 'internal' }, messages: [{ speakerAgentId: 'agent.one', type: 'position', content: 'Use evidence' }] } }, status: 'pending' as const, attempts: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' } satisfies ProjectionEvent;
    expect(await sink.deliver(event)).toEqual({ externalId: event.idempotencyKey });
    expect((received[0] as { msg_type: string }).msg_type).toBe('interactive');
    const privateEvent = { ...event, payload: { ...event.payload, room: { ...event.payload.room, context: { classification: 'private' } } } };
    await expect(sink.deliver(privateEvent)).rejects.toThrow('private');
    const restricted = new FeishuAppProjectionSink('app-test', 'secret-test', `http://127.0.0.1:${address.port}`, false, new Set(['oc_other_chat']));
    await expect(restricted.deliver(event)).rejects.toThrow('not allowlisted');
  });

  it('uses a cached Feishu app token and sends an idempotent chat projection', async () => {
    let tokenCalls = 0; const messages: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      response.setHeader('content-type', 'application/json');
      if (request.url?.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        tokenCalls += 1; expect(JSON.parse(body)).toEqual({ app_id: 'app-test', app_secret: 'secret-test' });
        response.end(JSON.stringify({ code: 0, tenant_access_token: 'tenant-token', expire: 3600 })); return;
      }
      if (request.url?.startsWith('/open-apis/im/v1/messages')) {
        messages.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
        response.end(JSON.stringify({ code: 0, data: { message_id: 'om_app_1' } })); return;
      }
      response.statusCode = 404; response.end(JSON.stringify({ code: 1, msg: 'missing route' }));
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const sink = new FeishuAppProjectionSink('app-test', 'secret-test', `http://127.0.0.1:${address.port}`);
    const event = { schemaVersion: 1 as const, id: 'projection_00000000-0000-4000-8000-000000000002', idempotencyKey: 'feishu:debate.app:v1', channel: 'feishu', destination: 'oc_chat_1', aggregateType: 'debate' as const, aggregateId: 'debate.app', snapshotHash: 'b'.repeat(64), payload: { status: 'closed', room: { goal: 'Decide', context: { classification: 'internal' }, messages: [] } }, status: 'pending' as const, attempts: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' } satisfies ProjectionEvent;
    const secondEvent = { ...event, id: 'projection_00000000-0000-4000-8000-000000000003', idempotencyKey: 'feishu:debate.app:v2' };
    await expect(Promise.all([sink.deliver(event), sink.deliver(secondEvent)])).resolves.toEqual([{ externalId: 'om_app_1' }, { externalId: 'om_app_1' }]);
    expect(tokenCalls).toBe(1); expect(messages).toHaveLength(2);
    expect(messages[0]?.authorization).toBe('Bearer tenant-token'); expect(messages[0]?.body).toMatchObject({ receive_id: 'oc_chat_1', msg_type: 'interactive', uuid: expect.any(String) });
    expect(typeof messages[0]?.body.content).toBe('string');
    const privateEvent = { ...event, payload: { ...event.payload, room: { ...event.payload.room, context: { classification: 'private' } } } };
    await expect(sink.deliver(privateEvent)).rejects.toThrow('private');
    const directPrivateEvent = { ...event, payload: { ...event.payload, classification: 'private' } };
    await expect(sink.deliver(directPrivateEvent)).rejects.toThrow('private');
  });

  it('uses the local Hermes send contract and keeps ambiguous CLI failures unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-hermes-cli-'));
    const executable = join(directory, 'hermes-fixture.mjs');
    await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--list')) { console.log(JSON.stringify({ platforms: { feishu: [] } })); process.exit(0); }
if (process.env.HERMES_FIXTURE_FAIL === '1') { console.error('provider timeout'); process.exit(1); }
console.log(JSON.stringify({ success: true, message_id: 'om_hermes_1', target: args[args.indexOf('--to') + 1] }));
`);
    await chmod(executable, 0o755);
    const sink = new HermesCliProjectionSink(executable);
    await expect(sink.health()).resolves.toMatchObject({ ready: true });
    const event = { schemaVersion: 1 as const, id: 'projection_00000000-0000-4000-8000-000000000004', idempotencyKey: 'hermes:debate.cli:v1', channel: 'hermes', destination: 'feishu:oc_chat_1', aggregateType: 'debate' as const, aggregateId: 'debate.cli', snapshotHash: 'c'.repeat(64), payload: { status: 'closed', room: { goal: 'Decide', context: { classification: 'internal' }, messages: [{ speakerAgentId: 'agent.one', type: 'position', content: 'Use evidence' }] } }, status: 'pending' as const, attempts: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' } satisfies ProjectionEvent;
    await expect(sink.deliver(event)).resolves.toEqual({ externalId: 'om_hermes_1' });
    const privateEvent = { ...event, payload: { ...event.payload, room: { ...event.payload.room, context: { classification: 'private' } } } };
    await expect(sink.deliver(privateEvent)).rejects.toThrow('private');
  });

  it('routes multiple projection channels without collapsing their delivery boundaries', async () => {
    const delivered: string[] = [];
    const makeSink = (label: string): ProjectionSink => ({
      deliver: async event => { delivered.push(`${label}:${event.channel}`); return { externalId: label }; },
      health: async () => ({ ready: true, detail: `${label} ready` }),
    });
    const sink = new RoutingProjectionSink({ feishu: makeSink('feishu'), hermes: makeSink('hermes') }, makeSink('fallback'));
    const base = { schemaVersion: 1 as const, id: 'projection_00000000-0000-4000-8000-000000000005', idempotencyKey: 'k-routing', destination: 'target', aggregateType: 'goal' as const, aggregateId: 'goal.routing', snapshotHash: 'd'.repeat(64), payload: { status: 'active' }, status: 'pending' as const, attempts: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' };
    await expect(sink.deliver({ ...base, channel: 'feishu' })).resolves.toEqual({ externalId: 'feishu' });
    await expect(sink.deliver({ ...base, channel: 'hermes', id: 'projection_00000000-0000-4000-8000-000000000006' })).resolves.toEqual({ externalId: 'hermes' });
    await expect(sink.deliver({ ...base, channel: 'linear', id: 'projection_00000000-0000-4000-8000-000000000007' })).resolves.toEqual({ externalId: 'fallback' });
    expect(delivered).toEqual(['feishu:feishu', 'hermes:hermes', 'fallback:linear']);
    await expect(sink.health()).resolves.toMatchObject({ ready: true });
  });
});
