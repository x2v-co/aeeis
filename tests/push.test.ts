import { createDecipheriv, createECDH, createHmac, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApnsSender, FcmSender, InMemoryPushStore, JsonPushStore, PushPump, WebPushSender, encryptWebPush, generateVapidKeys, loadVapidKeys, type PushMessage, type PushSender, type PushSubscription } from '../src/push.js';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
/** The receiving browser's side of RFC 8291, to prove the sender's bytes decrypt. */
function decryptWebPush(body: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16), idLength = body.readUInt8(20), senderPublic = body.subarray(21, 21 + idLength), cipher = body.subarray(21 + idLength);
  const shared = receiver.computeSecret(senderPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const decipher = createDecipheriv('aes-128-gcm', hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16), hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12));
  decipher.setAuthTag(cipher.subarray(-16));
  const plain = Buffer.concat([decipher.update(cipher.subarray(0, -16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}
const scope = { owner: 'owner', tenantId: 'local' };
const message = (key: string): PushMessage => ({ key, title: `等批准：${key}`, body: '计划等你批准', url: `/runs/${key}` });
const webDevice = () => { const receiver = createECDH('prime256v1'); receiver.generateKeys(); const auth = randomBytes(16); return { receiver, auth, input: { channel: 'web' as const, label: 'Chrome', endpoint: `https://push.example.test/send/${randomBytes(4).toString('hex')}`, keys: { p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } }; };

describe('web push', () => {
  it('encrypts a payload the subscribing browser can decrypt', () => {
    const { receiver, auth } = webDevice();
    const body = encryptWebPush(Buffer.from('{"title":"等批准"}'), receiver.getPublicKey(), auth);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decryptWebPush(body, receiver, auth)).toBe('{"title":"等批准"}');
  });

  it('signs a VAPID token for the push service origin and sends the encrypted message', async () => {
    const vapid = generateVapidKeys();
    const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    const sender = new WebPushSender(vapid, 'mailto:ops@example.test', async (url, init) => { sent.push({ url, headers: init.headers, body: Buffer.from(init.body as Uint8Array) }); return { status: 201, text: async () => '' }; });
    const device = webDevice();
    const subscription = await new InMemoryPushStore().add(scope, device.input);
    expect(await sender.send(subscription, message('run_a'))).toEqual({ ok: true });
    const [request] = sent;
    expect(request!.url).toBe(device.input.endpoint);
    expect(request!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', ttl: '86400', urgency: 'high' });
    expect(request!.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(request!.headers.authorization!)!;
    expect(key).toBe(vapid.publicKey);
    const [header, claims, signature] = token!.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({ aud: 'https://push.example.test', sub: 'mailto:ops@example.test' });
    const raw = Buffer.from(key!, 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(JSON.parse(decryptWebPush(request!.body, device.receiver, device.auth))).toEqual({ title: '等批准：run_a', body: '计划等你批准', url: '/runs/run_a', tag: 'run_a' });
  });

  it('reports an expired subscription as gone', async () => {
    const sender = new WebPushSender(generateVapidKeys(), 'mailto:ops@example.test', async () => ({ status: 410, text: async () => '' }));
    const subscription = await new InMemoryPushStore().add(scope, webDevice().input);
    expect(await sender.send(subscription, message('run_a'))).toMatchObject({ ok: false, gone: true });
  });

  it('keeps one VAPID key across restarts', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'aeeis-vapid-')), 'vapid.json');
    const first = await loadVapidKeys(path);
    expect((await loadVapidKeys(path)).publicKey).toBe(first.publicKey);
    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(65);
  });
});

describe('native push senders', () => {
  it('sends an APNs alert with a token key and drops an unregistered device', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const posts: Array<{ origin: string; path: string; headers: Record<string, string>; body: string }> = [];
    let status = 200;
    const sender = new ApnsSender({ keyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), keyId: 'KEY1234567', teamId: 'TEAM123456', bundleId: 'co.x2v.aeeis' }, async (origin, path, headers, body) => { posts.push({ origin, path, headers, body }); return { status, body: status === 200 ? '' : '{"reason":"Unregistered"}' }; });
    const device = await new InMemoryPushStore().add(scope, { channel: 'apns', label: 'iPhone', token: 'ab'.repeat(32), sandbox: true });
    expect(await sender.send(device, message('run_a'))).toEqual({ ok: true });
    expect(posts[0]).toMatchObject({ origin: 'https://api.sandbox.push.apple.com', path: `/3/device/${'ab'.repeat(32)}`, headers: { 'apns-topic': 'co.x2v.aeeis', 'apns-push-type': 'alert' } });
    expect(posts[0]!.headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ aps: { alert: { title: '等批准：run_a', body: '计划等你批准' } }, url: '/runs/run_a' });
    status = 410;
    expect(await sender.send(device, message('run_b'))).toMatchObject({ ok: false, gone: true });
  });

  it('exchanges a service account for an FCM token, reuses it, and drops an unregistered device', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let sendStatus = 200;
    const sender = new FcmSender({ project_id: 'aeeis-test', client_email: 'push@aeeis-test.iam.gserviceaccount.com', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() }, async (url, init) => {
      calls.push({ url, body: String(init.body), headers: init.headers });
      if (url.startsWith('https://oauth2.googleapis.com')) return { status: 200, text: async () => '{"access_token":"tok","expires_in":3600}' };
      return { status: sendStatus, text: async () => sendStatus === 200 ? '{}' : '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' };
    });
    const device = await new InMemoryPushStore().add(scope, { channel: 'fcm', label: 'Pixel', token: 'fcm-token-0123456789abcdef' });
    expect(await sender.send(device, message('run_a'))).toEqual({ ok: true });
    expect(await sender.send(device, message('run_b'))).toEqual({ ok: true });
    expect(calls.filter(call => call.url.startsWith('https://oauth2'))).toHaveLength(1);
    const send = calls.find(call => call.url.includes('/messages:send'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/aeeis-test/messages:send');
    expect(send.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(send.body)).toMatchObject({ message: { token: 'fcm-token-0123456789abcdef', notification: { title: '等批准：run_a' }, data: { url: '/runs/run_a', tag: 'run_a' }, android: { priority: 'HIGH' } } });
    sendStatus = 404;
    expect(await sender.send(device, message('run_c'))).toMatchObject({ ok: false, gone: true });
  });
});

describe('push pump', () => {
  it('announces nothing waiting before, each new item once, again after it comes back, and at most three per scan', async () => {
    const store = new InMemoryPushStore();
    const web = await store.add(scope, webDevice().input);
    await store.add({ owner: 'other', tenantId: 'local' }, { channel: 'fcm', label: 'Pixel', token: 'fcm-token-other-0123456789' });
    const sent: Array<[string, string]> = [];
    const fake: PushSender = { send: async (subscription: PushSubscription, item: PushMessage) => { sent.push([subscription.label, item.key]); return { ok: true }; } };
    let waiting: Record<string, string[]> = { owner: ['backlog'], other: [] };
    const pump = new PushPump(store, { web: fake, fcm: fake }, async target => (waiting[target.owner] ?? []).map(message));
    await pump.tick();
    expect(sent).toEqual([]);
    waiting = { owner: ['backlog', 'run_a'], other: ['run_x'] };
    await pump.tick();
    expect(sent).toEqual([['Chrome', 'run_a'], ['Pixel', 'run_x']]);
    await pump.tick();
    expect(sent).toHaveLength(2);
    waiting = { owner: ['backlog'], other: ['run_x'] };
    await pump.tick();
    waiting = { owner: ['backlog', 'run_a', 'b', 'c', 'd', 'e'], other: ['run_x'] };
    await pump.tick();
    expect(sent.slice(2)).toEqual([['Chrome', 'run_a'], ['Chrome', 'b'], ['Chrome', 'c']]);
    expect((await store.list(scope))[0]!.lastSentAt).toEqual(expect.any(String));
    expect((await store.list(scope))[0]!.id).toBe(web.id);
  });

  it('removes a device the push service no longer knows and records other failures', async () => {
    const store = new InMemoryPushStore();
    await store.add(scope, { channel: 'apns', label: 'iPhone', token: 'cd'.repeat(32), sandbox: false });
    await store.add(scope, { channel: 'fcm', label: 'Pixel', token: 'fcm-token-0123456789abcdef' });
    let waiting: string[] = [];
    const pump = new PushPump(store, {
      apns: { send: async () => ({ ok: false, gone: true, error: 'APNs 410' }) },
      fcm: { send: async () => ({ ok: false, gone: false, error: 'FCM 503' }) },
    }, async () => waiting.map(message));
    await pump.tick();
    waiting = ['run_a'];
    await pump.tick();
    expect((await store.list(scope)).map(item => [item.label, item.lastError])).toEqual([['Pixel', 'FCM 503']]);
  });
});

describe('push store', () => {
  it('keeps one entry per device, scopes removal to its owner, and survives a reload', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'aeeis-push-')), 'push.json');
    const store = new JsonPushStore(path);
    const device = webDevice().input;
    await store.add(scope, device);
    const again = await store.add(scope, { ...device, label: 'Chrome again' });
    expect((await store.list(scope)).map(item => item.label)).toEqual(['Chrome again']);
    expect(await store.remove({ owner: 'other', tenantId: 'local' }, again.id)).toBe(false);
    await store.setSeen(scope, ['run_a']);
    const reloaded = new JsonPushStore(path);
    expect((await reloaded.list(scope)).map(item => item.id)).toEqual([again.id]);
    expect(await reloaded.seen(scope)).toEqual(['run_a']);
    expect(await reloaded.seen({ owner: 'other', tenantId: 'local' })).toBeUndefined();
    expect(await reloaded.remove(scope, again.id)).toBe(true);
    expect(await reloaded.scopes()).toEqual([]);
  });

  it('rejects a push endpoint that is not HTTPS', async () => {
    await expect(new InMemoryPushStore().add(scope, { ...webDevice().input, endpoint: 'http://push.example.test/x' })).rejects.toThrow();
  });
});
