import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelDigestDelivery } from '../src/channel-digest.js';
import { channelAttention, channelNoiseMigration, channelNoiseSettingsSchema, defaultChannelNoiseSettings, InMemoryChannelNoiseStore, inChannelQuietHours, JsonChannelNoiseStore } from '../src/channel-noise.js';
import { InMemorySessionEventRepository, JsonSessionEventRepository } from '../src/session-events.js';
import { channelPushAllowed, InMemoryPushStore, PushPump, type PushMessage } from '../src/push.js';
import { TENANT_POLICIES } from '../src/adapters/postgres-pool.js';
import { noiseAt, noiseDraft, noiseScope } from './support/channel-noise.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function fixture() {
  const repository = new InMemorySessionEventRepository();
  const settings = new InMemoryChannelNoiseStore();
  let now = noiseAt;
  const delivery = new ChannelDigestDelivery(repository, settings, () => now);
  const write = (key: string, extra: Parameters<typeof noiseDraft>[1] = {}) => delivery.write(noiseDraft(key, extra), item => repository.append(item));
  return { repository, settings, delivery, write, advance: (ms: number) => { now += ms; } };
}

describe('频道防噪和持久化摘要', () => {
  it('并发时第六条通过、第七条排队，滑动窗口左边界移出后恢复；频道互不占额度', async () => {
    const f = fixture();
    const messages = await Promise.all(Array.from({ length: 7 }, (_, i) => f.write(`message-${i}`)));
    expect(messages.map(item => item.botDelivery?.mode)).toEqual([...Array(6).fill('immediate'), 'digest']);
    expect((await f.write('other', { roomId: 'room.other' })).botDelivery?.mode).toBe('immediate');
    f.advance(10 * 60_000 - 1);
    expect((await f.write('still-full')).botDelivery?.mode).toBe('digest');
    f.advance(1);
    expect((await f.write('recovered')).botDelivery?.mode).toBe('immediate');
    expect((await f.write('message-0')).id).toBe(messages[0]!.id);
  });

  it('上线前十分钟内的旧 Bot 消息也占窗口，审批历史不占额度', async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) await f.repository.append(noiseDraft(`legacy-${i}`));
    await f.repository.append(noiseDraft('legacy-approval', { type: 'decision' }));
    expect((await f.write('first-after-upgrade')).botDelivery?.mode).toBe('digest');
    f.advance(10 * 60_000);
    expect((await f.write('after-legacy-window')).botDelivery?.mode).toBe('immediate');
  });

  it('普通进展满 15 分钟合并；摘要本身只占一条，空队列和重放不发消息', async () => {
    const f = fixture();
    expect(await f.delivery.pump()).toBe(0);
    const originals = await Promise.all([f.write('progress-1', { type: 'task_update' }), f.write('progress-2', { type: 'system' })]);
    expect(originals.every(item => item.botDelivery?.mode === 'digest')).toBe(true);
    f.advance(15 * 60_000 - 1); expect(await f.delivery.pump()).toBe(0);
    f.advance(1); expect(await f.delivery.pump()).toBe(1);
    const events = (await f.repository.page(noiseScope.roomId, noiseScope, 200)).items;
    expect(events.at(-1)).toMatchObject({ type: 'digest', content: '已合并 2 条', digest: { eventIds: originals.map(item => item.id), minutes: 15 }, botDelivery: { mode: 'immediate' } });
    expect(await f.delivery.pump()).toBe(0);
    for (let i = 0; i < 5; i++) expect((await f.write(`after-digest-${i}`)).botDelivery?.mode).toBe('immediate');
    expect((await f.write('after-digest-full')).botDelivery?.mode).toBe('digest');
    f.advance(30 * 60_000); expect(await f.delivery.pump()).toBe(1);
    f.advance(30 * 60_000); expect(await f.delivery.pump()).toBe(0);
  });

  it('同一批超过一页时仍在下一张摘要全部合并', async () => {
    const f = fixture();
    for (let i = 0; i < 205; i++) await f.write(`many-${i}`, { type: 'task_update' });
    f.advance(15 * 60_000);
    expect(await f.delivery.pump()).toBe(1);
    const page = await f.repository.pageBefore(noiseScope.roomId, noiseScope, 1);
    expect(page.items[0]).toMatchObject({ type: 'digest', content: '已合并 205 条' });
    expect(page.items[0]!.digest?.eventIds).toHaveLength(205);
    expect(await f.delivery.pump()).toBe(0);
  });

  it('超限完整进入下一次摘要；摘要到期而窗口已满时继续排队', async () => {
    const f = fixture();
    await f.write('early-progress', { type: 'task_update' });
    f.advance(14 * 60_000);
    for (let i = 0; i < 8; i++) await f.write(`burst-${i}`);
    f.advance(60_000); expect(await f.delivery.pump()).toBe(0);
    f.advance(9 * 60_000); expect(await f.delivery.pump()).toBe(1);
    expect((await f.repository.page(noiseScope.roomId, noiseScope, 200)).items.at(-1)!.content).toBe('已合并 3 条');
  });

  it('频率可改到 30 分钟，按照新频率生效；拒绝越界、非整数和无效时区', async () => {
    const f = fixture();
    await f.write('progress', { type: 'task_update' });
    await f.settings.put(noiseScope, { digestMinutes: 30 });
    f.advance(15 * 60_000); expect(await f.delivery.pump()).toBe(0);
    f.advance(15 * 60_000); expect(await f.delivery.pump()).toBe(1);
    for (const digestMinutes of [14, 31, 15.5]) expect(channelNoiseSettingsSchema.safeParse({ digestMinutes }).success).toBe(false);
    expect(channelNoiseSettingsSchema.safeParse({ digestMinutes: 15 }).success).toBe(true);
    expect(channelNoiseSettingsSchema.safeParse({ quietHours: { start: '22:00', end: '08:00', timeZone: 'Mars/Olympus' } }).success).toBe(false);
    expect(channelNoiseSettingsSchema.safeParse({ quietHours: { start: '08:00', end: '08:00', timeZone: 'UTC' } }).success).toBe(false);
  });

  it('审批、提问、升级、阻塞和上报失败集中分类，既不吞消息也不占额度', async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) await f.write(`before-${i}`);
    for (const key of ['bot-fail:a', 'bot-task-fail:a', 'bot-escalate:a', 'bot-propose-receipt:a']) expect((await f.write(key, { type: 'system' })).botDelivery).toBeUndefined();
    expect((await f.write('approval', { type: 'decision' })).botDelivery).toBeUndefined();
    expect((await f.write('upgrade', { type: 'system', notificationKind: 'channel-upgrade' })).botDelivery).toBeUndefined();
    expect((await f.write('block', { type: 'system', taskAction: { schemaVersion: 'channel-task-action/1', kind: 'hand_up', conversationId: 'conv.noise', taskId: 'task.noise' } })).botDelivery).toBeUndefined();
    for (const kind of ['approval', 'question', 'channel-upgrade', 'blocked', 'failure', 'escalation']) expect(channelAttention({ kind })).toBe('decision');
    expect((await f.write('seventh')).botDelivery?.mode).toBe('digest');
    f.advance(10 * 60_000); expect((await f.write('after')).botDelivery?.mode).toBe('immediate');
  });

  it('不同受众或隐私级别分开摘要，原始上下文绑定不变', async () => {
    const f = fixture();
    const first = await f.write('internal', { type: 'task_update', classification: 'internal' });
    const second = await f.write('private', { type: 'task_update', classification: 'private' });
    f.advance(15 * 60_000); expect(await f.delivery.pump()).toBe(1);
    let events = (await f.repository.page(noiseScope.roomId, noiseScope, 200)).items;
    expect(events.at(-1)!.digest?.eventIds).toEqual([first.id]);
    f.advance(15 * 60_000); expect(await f.delivery.pump()).toBe(1);
    events = (await f.repository.page(noiseScope.roomId, noiseScope, 200)).items;
    expect(events.at(-1)).toMatchObject({ classification: 'private', digest: { eventIds: [second.id] }, contextManifestHash: second.contextManifestHash });
  });

  it('JSON 设置和队列重启后仍在；摘要提交后重启不会重复投递', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-noise-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const start = async () => {
      const repository = new JsonSessionEventRepository(join(directory, 'events.json')); await repository.init();
      const settings = new JsonChannelNoiseStore(join(directory, 'noise.json')); await settings.init();
      return { repository, settings };
    };
    let now = noiseAt;
    const first = await start();
    await first.settings.put(noiseScope, { digestMinutes: 20, mode: 'lively' });
    const delivery = new ChannelDigestDelivery(first.repository, first.settings, () => now);
    await delivery.write(noiseDraft('progress', { type: 'task_update' }), item => first.repository.append(item));
    await first.repository.close(); await first.settings.close();
    const second = await start();
    expect(await second.settings.get(noiseScope)).toMatchObject({ digestMinutes: 20, mode: 'lively' });
    now += 20 * 60_000;
    expect(await new ChannelDigestDelivery(second.repository, second.settings, () => now).pump()).toBe(1);
    await second.repository.close(); await second.settings.close();
    const third = await start();
    try { expect(await new ChannelDigestDelivery(third.repository, third.settings, () => now).pump()).toBe(0); }
    finally { await third.repository.close(); await third.settings.close(); }
  });

  it('正式 migration 与适配器一致，RLS 清单包含频道设置与私聊绑定', async () => {
    expect(await readFile('src/adapters/migrations/006-channel-noise.sql', 'utf8')).toBe(channelNoiseMigration);
    expect(TENANT_POLICIES).toHaveLength(39);
    expect(TENANT_POLICIES.map(item => item.table)).toContain('aeeis_channel_noise_settings');
  });
});

describe('安静时段和三个推送通道', () => {
  const settings = channelNoiseSettingsSchema.parse({ quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Singapore' } });
  it('按频道时区判断跨午夜区间，起点包含、终点不包含，也支持日内区间和 DST', () => {
    for (const at of ['2026-11-03T14:00Z', '2026-11-03T16:00Z', '2026-11-03T23:59Z']) expect(inChannelQuietHours(settings, Date.parse(at))).toBe(true);
    for (const at of ['2026-11-03T13:59Z', '2026-11-04T00:00Z']) expect(inChannelQuietHours(settings, Date.parse(at))).toBe(false);
    const day = channelNoiseSettingsSchema.parse({ quietHours: { start: '09:00', end: '17:00', timeZone: 'America/New_York' } });
    expect(inChannelQuietHours(day, Date.parse('2026-07-01T13:00Z'))).toBe(true);
    expect(inChannelQuietHours(day, Date.parse('2026-12-01T13:00Z'))).toBe(false);
    expect(inChannelQuietHours(defaultChannelNoiseSettings(), noiseAt)).toBe(false);
  });
  it('普通进展只积累在事件源，Web Push、APNs、FCM 都只发审批和需要人的事', async () => {
    const f = fixture();
    const store = new InMemoryPushStore();
    await store.add(noiseScope, { channel: 'web', label: 'browser', endpoint: 'https://push.example.test/push', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
    await store.add(noiseScope, { channel: 'apns', label: 'phone', token: 'ab'.repeat(32), sandbox: false });
    await store.add(noiseScope, { channel: 'fcm', label: 'android', token: 'a'.repeat(100) });
    const sent: string[] = [];
    const sender = { send: async (subscription: { channel: string }, message: PushMessage) => { sent.push(`${subscription.channel}:${message.key}`); return { ok: true as const }; } };
    let waiting: PushMessage[] = [];
    const pump = new PushPump(store, { web: sender, apns: sender, fcm: sender }, async () => waiting, undefined, async message => channelPushAllowed(message, settings, Date.parse('2026-11-03T16:00Z')));
    await pump.tick();
    const original = await f.write('ordinary', { type: 'task_update' });
    waiting = ['progress', 'approval', 'channel-upgrade', 'blocked', 'failure'].map(kind => ({ key: kind, kind, roomId: noiseScope.roomId, title: kind, body: '', url: '/' }));
    await pump.tick();
    expect(sent).toEqual(['web:approval', 'web:channel-upgrade', 'web:blocked', 'apns:approval', 'apns:channel-upgrade', 'apns:blocked', 'fcm:approval', 'fcm:channel-upgrade', 'fcm:blocked']);
    expect(await f.repository.get(original.id)).toMatchObject({ content: 'ordinary', botDelivery: { mode: 'digest' } });
    expect(channelPushAllowed(waiting[4]!, settings, Date.parse('2026-11-03T16:00Z'))).toBe(true);
    expect(channelPushAllowed(waiting[0]!, settings, Date.parse('2026-11-04T04:00Z'))).toBe(true);
  });
});
