import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileProjectionOutbox, type ProjectionEvent, type ProjectionSink } from '../src/collaboration-projection.js';

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
});
