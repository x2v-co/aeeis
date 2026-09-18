import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeishuWebhookProjectionSink, FileProjectionOutbox, ProjectionOutcomeUnknown, type ProjectionEvent, type ProjectionSink } from '../src/collaboration-projection.js';
import { createServer, type Server } from 'node:http';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

describe('collaboration projection outbox', () => {
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
  });
});
