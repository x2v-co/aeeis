import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { connect } from 'node:http2';
import { mkdir, readFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { withPostgresMigrationLock } from './adapters/postgres-migration.js';
import { createPostgresPool } from './adapters/postgres-pool.js';
import type { Ownership } from './security/principal.js';

/**
 * Interaction-design §9.4 push: the S1 items (an approval, a question, a channel block) reach a person's phone or
 * installed web app even when no AEEIS page is open. Three channels share one subscription list and one rule:
 * opt-in per device, each item once, nothing for the backlog that was already waiting.
 */
export const pushChannelSchema = z.enum(['web', 'apns', 'fcm']);
export type PushChannel = z.infer<typeof pushChannelSchema>;
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const pushSubscriptionInputSchema = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('web'), label: z.string().trim().min(1).max(200), endpoint: z.string().url().max(2000).refine(value => value.startsWith('https://'), 'Push endpoints must be HTTPS'), keys: z.object({ p256dh: base64url.max(200), auth: base64url.max(100) }).strict() }).strict(),
  z.object({ channel: z.literal('apns'), label: z.string().trim().min(1).max(200), token: z.string().regex(/^[a-f0-9]{64,200}$/i), sandbox: z.boolean().default(false) }).strict(),
  z.object({ channel: z.literal('fcm'), label: z.string().trim().min(1).max(200), token: z.string().regex(/^[A-Za-z0-9_:.-]{20,4096}$/) }).strict(),
]);
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;
const subscriptionSchema = z.object({
  id: z.string().regex(/^push_[0-9a-f-]{36}$/), owner: z.string().min(1).max(200), tenantId: z.string().min(1).max(200),
  createdAt: z.string().datetime({ offset: true }), lastSentAt: z.string().datetime({ offset: true }).optional(), lastError: z.string().max(500).optional(),
}).and(pushSubscriptionInputSchema);
export type PushSubscription = z.infer<typeof subscriptionSchema>;
/** What a person sees about a device, without its push secrets. */
export type PushSubscriptionView = Pick<PushSubscription, 'id' | 'channel' | 'label' | 'createdAt' | 'lastSentAt' | 'lastError'>;
export const pushSubscriptionView = (item: PushSubscription): PushSubscriptionView => ({ id: item.id, channel: item.channel, label: item.label, createdAt: item.createdAt, ...(item.lastSentAt ? { lastSentAt: item.lastSentAt } : {}), ...(item.lastError ? { lastError: item.lastError } : {}) });
const seenSchema = z.object({ owner: z.string(), tenantId: z.string(), keys: z.array(z.string().max(500)).max(500) }).strict();

export interface PushStore {
  init?(): Promise<void>;
  add(scope: Ownership, input: PushSubscriptionInput, now?: string): Promise<PushSubscription>;
  list(scope: Ownership): Promise<PushSubscription[]>;
  /** Every scope that has at least one device. */
  scopes(): Promise<Ownership[]>;
  remove(scope: Ownership, id: string): Promise<boolean>;
  mark(id: string, result: { sentAt?: string; error?: string }): Promise<void>;
  /** S1 keys already announced for a scope; undefined until the first scan, which announces nothing. */
  seen(scope: Ownership): Promise<string[] | undefined>;
  setSeen(scope: Ownership, keys: string[]): Promise<void>;
  close?(): Promise<void>;
}
const owned = (scope: Ownership) => (item: { owner: string; tenantId: string }) => item.owner === scope.owner && item.tenantId === scope.tenantId;
const sameDevice = (left: PushSubscriptionInput, right: PushSubscriptionInput) => left.channel === right.channel && (left.channel === 'web' ? left.endpoint === (right as typeof left).endpoint : left.token === (right as { token: string }).token);
function makeSubscription(scope: Ownership, input: PushSubscriptionInput, now: string): PushSubscription {
  return subscriptionSchema.parse({ ...pushSubscriptionInputSchema.parse(input), id: `push_${randomUUID()}`, owner: scope.owner, tenantId: scope.tenantId, createdAt: now });
}
function distinctScopes(items: readonly PushSubscription[]): Ownership[] {
  return [...new Map(items.map(item => [`${item.tenantId}\u0000${item.owner}`, { owner: item.owner, tenantId: item.tenantId }])).values()];
}

interface PushState { subscriptions: PushSubscription[]; seen: Array<z.infer<typeof seenSchema>> }
abstract class StatePushStore implements PushStore {
  protected state: PushState = { subscriptions: [], seen: [] };
  protected abstract change(update: (state: PushState) => PushState): Promise<void>;
  protected abstract read(): Promise<PushState>;
  async add(scope: Ownership, input: PushSubscriptionInput, now = new Date().toISOString()): Promise<PushSubscription> {
    const parsed = pushSubscriptionInputSchema.parse(input);
    let created!: PushSubscription;
    // The same device subscribing again replaces its old entry, so a phone is never notified twice.
    await this.change(state => { created = makeSubscription(scope, parsed, now); return { ...state, subscriptions: [...state.subscriptions.filter(item => !sameDevice(item, parsed)), created] }; });
    return created;
  }
  async list(scope: Ownership) { return (await this.read()).subscriptions.filter(owned(scope)); }
  async scopes() { return distinctScopes((await this.read()).subscriptions); }
  async remove(scope: Ownership, id: string) {
    let removed = false;
    await this.change(state => { const next = state.subscriptions.filter(item => !(item.id === id && owned(scope)(item))); removed = next.length !== state.subscriptions.length; return { ...state, subscriptions: next }; });
    return removed;
  }
  async mark(id: string, result: { sentAt?: string; error?: string }) {
    await this.change(state => ({ ...state, subscriptions: state.subscriptions.map(item => {
      if (item.id !== id) return item;
      const { lastError: _error, ...rest } = item;
      return subscriptionSchema.parse({ ...rest, ...(result.sentAt ? { lastSentAt: result.sentAt } : {}), ...(result.error ? { lastError: result.error.slice(0, 500) } : {}) });
    }) }));
  }
  async seen(scope: Ownership) { return (await this.read()).seen.find(owned(scope))?.keys; }
  async setSeen(scope: Ownership, keys: string[]) {
    await this.change(state => ({ ...state, seen: [...state.seen.filter(item => !owned(scope)(item)), { owner: scope.owner, tenantId: scope.tenantId, keys: keys.slice(0, 500) }] }));
  }
}

export class InMemoryPushStore extends StatePushStore {
  protected async read() { return this.state; }
  protected async change(update: (state: PushState) => PushState) { this.state = update(this.state); }
}

export class JsonPushStore extends StatePushStore {
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) { super(); }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation); this.queue = next.catch(() => {}); return next; }
  async init() { await this.serial(() => this.load()); }
  async close() { await this.queue; }
  protected async read() { await this.serial(() => this.load()); return this.state; }
  protected async change(update: (state: PushState) => PushState) {
    await this.serial(async () => { await this.load(); await this.save(update(this.state)); });
  }
  private async load() {
    if (this.loaded) return;
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PushState>;
      this.state = { subscriptions: z.array(subscriptionSchema).parse(raw.subscriptions ?? []), seen: z.array(seenSchema).parse(raw.seen ?? []) };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save(state: PushState) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(`${JSON.stringify(state)}\n`); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path); this.state = state;
    } finally { await unlink(temp).catch(() => undefined); }
  }
}

export class PostgresPushStore implements PushStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPostgresPool(connectionString); }
  async init() {
    await withPostgresMigrationLock(this.pool, 'push-subscriptions', async client => {
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_push_subscriptions (id text PRIMARY KEY, tenant_id text NOT NULL, owner text NOT NULL, device_key text NOT NULL UNIQUE, body jsonb NOT NULL)');
      await client.query('CREATE TABLE IF NOT EXISTS aeeis_push_seen (tenant_id text NOT NULL, owner text NOT NULL, keys jsonb NOT NULL, PRIMARY KEY (tenant_id, owner))');
    });
  }
  private deviceKey(input: PushSubscriptionInput) { return input.channel === 'web' ? `web:${input.endpoint}` : `${input.channel}:${input.token}`; }
  async add(scope: Ownership, input: PushSubscriptionInput, now = new Date().toISOString()) {
    const created = makeSubscription(scope, input, now);
    await this.pool.query('INSERT INTO aeeis_push_subscriptions(id, tenant_id, owner, device_key, body) VALUES($1,$2,$3,$4,$5) ON CONFLICT (device_key) DO UPDATE SET id=EXCLUDED.id, tenant_id=EXCLUDED.tenant_id, owner=EXCLUDED.owner, body=EXCLUDED.body', [created.id, scope.tenantId, scope.owner, this.deviceKey(created), created]);
    return created;
  }
  async list(scope: Ownership) {
    const result = await this.pool.query<{ body: unknown }>('SELECT body FROM aeeis_push_subscriptions WHERE tenant_id=$1 AND owner=$2 ORDER BY body->>\'createdAt\'', [scope.tenantId, scope.owner]);
    return result.rows.map(row => subscriptionSchema.parse(row.body));
  }
  async scopes() {
    const result = await this.pool.query<{ owner: string; tenant_id: string }>('SELECT DISTINCT owner, tenant_id FROM aeeis_push_subscriptions');
    return result.rows.map(row => ({ owner: row.owner, tenantId: row.tenant_id }));
  }
  async remove(scope: Ownership, id: string) {
    const result = await this.pool.query('DELETE FROM aeeis_push_subscriptions WHERE id=$1 AND tenant_id=$2 AND owner=$3', [id, scope.tenantId, scope.owner]);
    return (result.rowCount ?? 0) > 0;
  }
  async mark(id: string, result: { sentAt?: string; error?: string }) {
    const patch = { ...(result.sentAt ? { lastSentAt: result.sentAt } : {}), ...(result.error ? { lastError: result.error.slice(0, 500) } : {}) };
    await this.pool.query('UPDATE aeeis_push_subscriptions SET body = (body - \'lastError\') || $2::jsonb WHERE id=$1', [id, patch]);
  }
  async seen(scope: Ownership) {
    const result = await this.pool.query<{ keys: string[] }>('SELECT keys FROM aeeis_push_seen WHERE tenant_id=$1 AND owner=$2', [scope.tenantId, scope.owner]);
    return result.rows[0]?.keys;
  }
  async setSeen(scope: Ownership, keys: string[]) {
    await this.pool.query('INSERT INTO aeeis_push_seen(tenant_id, owner, keys) VALUES($1,$2,$3) ON CONFLICT (tenant_id, owner) DO UPDATE SET keys=EXCLUDED.keys', [scope.tenantId, scope.owner, JSON.stringify(keys.slice(0, 500))]);
  }
  async close() { await this.pool.end(); }
}

/** One S1 item as it is pushed. The url opens it in AEEIS: a Run page, or a group by its hash. */
export interface PushMessage { key: string; title: string; body: string; url: string }
export type PushOutcome = { ok: true } | { ok: false; gone: boolean; error: string };
export interface PushSender { send(subscription: PushSubscription, message: PushMessage): Promise<PushOutcome> }

const b64u = (value: Buffer) => value.toString('base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
function jwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: KeyObject, algorithm: 'ES256' | 'RS256'): string {
  const input = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(claims)))}`;
  const signature = algorithm === 'ES256' ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }) : sign('sha256', Buffer.from(input), key);
  return `${input}.${b64u(signature)}`;
}
const payloadOf = (message: PushMessage) => ({ title: message.title.slice(0, 120), body: message.body.slice(0, 240), url: message.url, tag: message.key });

/** RFC 8291 message encryption (aes128gcm) for one Web Push subscription. Exported for tests. */
export function encryptWebPush(plaintext: Buffer, receiverPublicKey: Buffer, authSecret: Buffer, salt = randomBytes(16)): Buffer {
  const sender = createECDH('prime256v1');
  const senderPublic = sender.generateKeys();
  const shared = sender.computeSecret(receiverPublicKey);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublicKey, senderPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'binary')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'binary')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, body]);
}

/** VAPID key pair for Web Push. The private key is kept as a JWK in the data directory unless supplied. */
export interface VapidKeys { publicKey: string; privateJwk: Record<string, unknown> }
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return vapidFromJwk(privateKey.export({ format: 'jwk' }) as Record<string, unknown>);
}
export function vapidFromJwk(privateJwk: Record<string, unknown>): VapidKeys {
  const jwk = createPublicKey(createPrivateKey({ key: privateJwk as never, format: 'jwk' })).export({ format: 'jwk' }) as { x: string; y: string };
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), privateJwk };
}
export async function loadVapidKeys(path: string, supplied?: string): Promise<VapidKeys> {
  if (supplied) return vapidFromJwk(JSON.parse(supplied) as Record<string, unknown>);
  try { return vapidFromJwk(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const keys = generateVapidKeys();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600).catch(async error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; });
  if (!file) return vapidFromJwk(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>);
  try { await file.writeFile(JSON.stringify(keys.privateJwk)); await file.sync(); } finally { await file.close(); }
  return keys;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string | Uint8Array; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export class WebPushSender implements PushSender {
  private readonly key: KeyObject;
  constructor(private readonly vapid: VapidKeys, private readonly subject: string, private readonly fetcher: Fetch = fetch as unknown as Fetch) {
    this.key = createPrivateKey({ key: vapid.privateJwk as never, format: 'jwk' });
  }
  async send(subscription: PushSubscription, message: PushMessage): Promise<PushOutcome> {
    if (subscription.channel !== 'web') return { ok: false, gone: false, error: 'Not a Web Push subscription' };
    const endpoint = new URL(subscription.endpoint);
    const token = jwt({ typ: 'JWT', alg: 'ES256' }, { aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: this.subject }, this.key, 'ES256');
    const body = encryptWebPush(Buffer.from(JSON.stringify(payloadOf(message))), Buffer.from(subscription.keys.p256dh, 'base64url'), Buffer.from(subscription.keys.auth, 'base64url'));
    const response = await this.fetcher(subscription.endpoint, { method: 'POST', headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', topic: topicOf(message.key), authorization: `vapid t=${token}, k=${this.vapid.publicKey}` }, body, signal: AbortSignal.timeout(10_000) });
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, gone: response.status === 404 || response.status === 410, error: `Web Push ${response.status}` };
  }
}
/** Web Push topics are at most 32 URL-safe characters; a later message with the same topic replaces an undelivered one. */
const topicOf = (key: string) => createHmac('sha256', 'aeeis-push-topic').update(key).digest('base64url').slice(0, 32);

export interface ApnsConfig { keyPem: string; keyId: string; teamId: string; bundleId: string }
type Http2Post = (origin: string, path: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>;
const http2Post: Http2Post = (origin, path, headers, body) => new Promise((resolve, reject) => {
  const session = connect(origin);
  session.once('error', reject);
  const request = session.request({ ':method': 'POST', ':path': path, ...headers });
  let status = 0; const chunks: Buffer[] = [];
  request.setTimeout(10_000, () => { request.close(); session.close(); reject(new Error('APNs request timed out')); });
  request.on('response', head => { status = Number(head[':status']); });
  request.on('data', chunk => chunks.push(chunk as Buffer));
  request.on('end', () => { session.close(); resolve({ status, body: Buffer.concat(chunks).toString('utf8') }); });
  request.on('error', error => { session.close(); reject(error); });
  request.end(body);
});

/** Apple Push Notification service with a token (.p8) key. */
export class ApnsSender implements PushSender {
  private readonly key: KeyObject;
  private token?: { value: string; at: number };
  constructor(private readonly config: ApnsConfig, private readonly post: Http2Post = http2Post) { this.key = createPrivateKey(config.keyPem); }
  private bearer() {
    // Apple wants a token refreshed at most every 20 minutes and at least every hour.
    if (!this.token || Date.now() - this.token.at > 40 * 60_000) this.token = { value: jwt({ alg: 'ES256', kid: this.config.keyId }, { iss: this.config.teamId, iat: Math.floor(Date.now() / 1000) }, this.key, 'ES256'), at: Date.now() };
    return this.token.value;
  }
  async send(subscription: PushSubscription, message: PushMessage): Promise<PushOutcome> {
    if (subscription.channel !== 'apns') return { ok: false, gone: false, error: 'Not an APNs device' };
    const payload = payloadOf(message);
    const response = await this.post(subscription.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', `/3/device/${subscription.token}`, {
      authorization: `bearer ${this.bearer()}`, 'apns-topic': this.config.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': topicOf(message.key), 'content-type': 'application/json',
    }, JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body }, sound: 'default', 'thread-id': 'aeeis-s1' }, url: payload.url, tag: payload.tag }));
    if (response.status === 200) return { ok: true };
    const reason = (() => { try { return String((JSON.parse(response.body) as { reason?: string }).reason ?? ''); } catch { return ''; } })();
    return { ok: false, gone: response.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered', error: `APNs ${response.status}${reason ? ` ${reason}` : ''}` };
  }
}

export interface FcmServiceAccount { project_id: string; client_email: string; private_key: string }
/** Firebase Cloud Messaging HTTP v1 with a service account. */
export class FcmSender implements PushSender {
  private readonly key: KeyObject;
  private access?: { token: string; expiresAt: number };
  constructor(private readonly account: FcmServiceAccount, private readonly fetcher: Fetch = fetch as unknown as Fetch) { this.key = createPrivateKey(account.private_key); }
  private async accessToken() {
    if (this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token;
    const iat = Math.floor(Date.now() / 1000);
    const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: this.account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }, this.key, 'RS256');
    const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) throw new Error(`FCM token exchange ${response.status}`);
    const body = JSON.parse(await response.text()) as { access_token: string; expires_in: number };
    this.access = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.access.token;
  }
  async send(subscription: PushSubscription, message: PushMessage): Promise<PushOutcome> {
    if (subscription.channel !== 'fcm') return { ok: false, gone: false, error: 'Not an FCM device' };
    const payload = payloadOf(message);
    const response = await this.fetcher(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.account.project_id)}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ message: { token: subscription.token, notification: { title: payload.title, body: payload.body }, data: { url: payload.url, tag: payload.tag }, android: { priority: 'HIGH', collapse_key: topicOf(message.key), notification: { tag: topicOf(message.key), channel_id: 'aeeis-s1' } } } }),
    });
    if (response.status === 200) return { ok: true };
    const text = await response.text();
    return { ok: false, gone: response.status === 404 || /UNREGISTERED/.test(text), error: `FCM ${response.status}` };
  }
}

/**
 * Scans each subscribed person's S1 items and pushes the new ones. The first scan for a person only records what is
 * already waiting. An item that leaves and comes back is new again; nothing is repeated to nag. At most three
 * messages per person per scan, so a burst never floods a phone.
 */
export class PushPump {
  private running: Promise<void> | undefined;
  constructor(private readonly store: PushStore, private readonly senders: Partial<Record<PushChannel, PushSender>>, private readonly collect: (scope: Ownership) => Promise<PushMessage[]>, private readonly log: (message: string) => void = () => {}) {}
  tick(): Promise<void> {
    this.running ??= this.scan().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async scan() {
    for (const scope of await this.store.scopes()) {
      try { await this.scanScope(scope); }
      catch (error) { this.log(`Push scan failed for ${scope.tenantId}/${scope.owner}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  private async scanScope(scope: Ownership) {
    const waiting = await this.collect(scope);
    const seen = await this.store.seen(scope);
    await this.store.setSeen(scope, waiting.map(item => item.key));
    if (!seen) return;
    const fresh = waiting.filter(item => !seen.includes(item.key)).slice(0, 3);
    if (!fresh.length) return;
    for (const subscription of await this.store.list(scope)) {
      const sender = this.senders[subscription.channel];
      if (!sender) continue;
      for (const message of fresh) {
        let outcome: PushOutcome;
        try { outcome = await sender.send(subscription, message); }
        catch (error) { outcome = { ok: false, gone: false, error: error instanceof Error ? error.message : 'Push failed' }; }
        if (outcome.ok) { await this.store.mark(subscription.id, { sentAt: new Date().toISOString() }); continue; }
        if (outcome.gone) { await this.store.remove(scope, subscription.id); break; }
        await this.store.mark(subscription.id, { error: outcome.error });
      }
    }
  }
}
