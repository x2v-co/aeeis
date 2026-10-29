import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

/**
 * Envelope encryption for user content at rest (AES-256-GCM).
 *
 * The master key comes from a file. Each tenant has its own random data key,
 * stored wrapped by the master key; rotating the master only rewraps data keys.
 * Stores seal a whole aggregate into one envelope and keep in the clear only the
 * fields their SQL filters on. Hashes are always computed by the application on
 * plaintext before anything reaches a store, so plan hashes, contentHash and
 * manifest digests are identical with or without encryption.
 */
export const SEALED = '$sealed';
const ENVELOPE = 'aeeis-enc/1';
const KEY_BYTES = 32;

export class ContentEncryptionUnavailable extends Error {}

export interface WrappedDataKey { tenantId: string; keyId: string; masterKeyId: string; wrapped: string; createdAt: string }
export interface ContentKeyStore {
  /** Newest first. */
  list(tenantId: string): Promise<WrappedDataKey[]>;
  /** Keeps the existing key when two writers race; returns the stored one. */
  insert(key: WrappedDataKey): Promise<WrappedDataKey>;
  replace?(key: WrappedDataKey): Promise<void>;
  all?(): Promise<WrappedDataKey[]>;
}

export function masterKeyId(key: Buffer): string { return createHash('sha256').update(key).digest('hex').slice(0, 16); }

/** A key is 32 random bytes written as base64 or hex (`openssl rand -base64 32`). */
export function parseMasterKey(value: string): Buffer {
  const text = value.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('A content encryption key must be 32 bytes written as base64 or 64 hex characters');
  return key;
}
export function readMasterKeyFile(path: string): Buffer { return parseMasterKey(readFileSync(path, 'utf8')); }

function gcmSeal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return `${iv.toString('base64url')}.${body.toString('base64url')}`;
}
function gcmOpen(key: Buffer, sealed: string, aad: string): Buffer {
  const [ivText, bodyText] = sealed.split('.');
  if (!ivText || !bodyText) throw new Error('Malformed ciphertext');
  const body = Buffer.from(bodyText, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

export class ContentCipher {
  private readonly masters = new Map<string, Buffer>();
  readonly currentMasterId: string;
  private readonly cache = new Map<string, Promise<{ keyId: string; key: Buffer }>>();
  private readonly byId = new Map<string, Buffer>();

  constructor(master: Buffer, private readonly store: ContentKeyStore, previous: Buffer[] = []) {
    this.currentMasterId = masterKeyId(master);
    for (const key of [master, ...previous]) this.masters.set(masterKeyId(key), key);
  }

  private unwrap(record: WrappedDataKey): Buffer {
    const master = this.masters.get(record.masterKeyId);
    if (!master) throw new ContentEncryptionUnavailable(`Data key ${record.keyId} is wrapped by master key ${record.masterKeyId}, which is not configured`);
    const key = gcmOpen(master, record.wrapped, `aeeis-data-key/1|${record.tenantId}|${record.keyId}`);
    this.byId.set(`${record.tenantId}\0${record.keyId}`, key);
    return key;
  }

  /** The tenant's current data key, created on first use. */
  private activeKey(tenantId: string): Promise<{ keyId: string; key: Buffer }> {
    let pending = this.cache.get(tenantId);
    if (!pending) {
      pending = (async () => {
        const existing = (await this.store.list(tenantId))[0];
        if (existing) return { keyId: existing.keyId, key: this.unwrap(existing) };
        const key = randomBytes(KEY_BYTES);
        const keyId = `dk_${randomBytes(8).toString('hex')}`;
        const master = this.masters.get(this.currentMasterId)!;
        const stored = await this.store.insert({ tenantId, keyId, masterKeyId: this.currentMasterId, wrapped: gcmSeal(master, key, `aeeis-data-key/1|${tenantId}|${keyId}`), createdAt: new Date().toISOString() });
        return { keyId: stored.keyId, key: this.unwrap(stored) };
      })();
      pending.catch(() => this.cache.delete(tenantId));
      this.cache.set(tenantId, pending);
    }
    return pending;
  }

  private async keyById(tenantId: string, keyId: string): Promise<Buffer> {
    const cached = this.byId.get(`${tenantId}\0${keyId}`);
    if (cached) return cached;
    const record = (await this.store.list(tenantId)).find(item => item.keyId === keyId);
    if (!record) throw new ContentEncryptionUnavailable(`Unknown data key ${keyId} for tenant ${tenantId}`);
    return this.unwrap(record);
  }

  async seal(scope: SealScope, value: unknown): Promise<string> {
    const { keyId, key } = await this.activeKey(scope.tenantId);
    return `${ENVELOPE}:${keyId}:${gcmSeal(key, Buffer.from(JSON.stringify(value), 'utf8'), aad(scope))}`;
  }

  async open(scope: SealScope, envelope: string): Promise<unknown> {
    const [tag, keyId, sealed] = splitEnvelope(envelope);
    if (tag !== ENVELOPE) throw new Error('Unsupported content envelope');
    const key = await this.keyById(scope.tenantId, keyId);
    return JSON.parse(gcmOpen(key, sealed, aad(scope)).toString('utf8'));
  }

  /** Rewraps every data key with the current master key. Data stays as it is. */
  async rewrap(): Promise<{ rewrapped: number; current: number }> {
    if (!this.store.all || !this.store.replace) throw new Error('This key store cannot list keys');
    let rewrapped = 0, current = 0;
    for (const record of await this.store.all()) {
      if (record.masterKeyId === this.currentMasterId) { current += 1; continue; }
      const key = this.unwrap(record);
      await this.store.replace({ ...record, masterKeyId: this.currentMasterId, wrapped: gcmSeal(this.masters.get(this.currentMasterId)!, key, `aeeis-data-key/1|${record.tenantId}|${record.keyId}`) });
      rewrapped += 1;
    }
    return { rewrapped, current };
  }
}

export interface SealScope { aggregate: string; tenantId: string; id: string }
function aad(scope: SealScope): string { return `aeeis-content/1|${scope.aggregate}|${scope.tenantId}|${scope.id}`; }
function splitEnvelope(value: string): [string, string, string] {
  const first = value.indexOf(':'), second = value.indexOf(':', first + 1);
  if (first < 0 || second < 0) throw new Error('Malformed content envelope');
  return [value.slice(0, first), value.slice(first + 1, second), value.slice(second + 1)];
}

let active: ContentCipher | undefined;
/** Set once at startup. Missing means stores write plaintext. */
export function configureContentEncryption(cipher: ContentCipher | undefined): void { active = cipher; }
export function contentEncryption(): ContentCipher | undefined { return active; }

export function isSealed(value: unknown): value is Record<string, unknown> & { [SEALED]: string } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>)[SEALED] === 'string';
}

/**
 * Stored form of an aggregate: the plain fields SQL needs, the tenant, and the
 * sealed whole. Without a configured key the aggregate is stored as it is. The
 * ciphertext is bound to aggregate, tenant and id, so it cannot be moved to
 * another row or tenant.
 */
export async function sealAggregate<T>(aggregate: string, tenantId: string | undefined, id: string, value: T, plain: (value: T) => Record<string, unknown> = () => ({})): Promise<T | Record<string, unknown>> {
  const cipher = active;
  if (!cipher || value === undefined || value === null) return value;
  const tenant = tenantId ?? 'local';
  return { ...plain(value), tenantId: tenant, [SEALED]: await cipher.seal({ aggregate, tenantId: tenant, id }, value) };
}

/** Reads both forms, so existing plaintext rows keep working until the backfill reaches them. */
export async function openAggregate<T>(aggregate: string, id: string, stored: unknown): Promise<T> {
  if (!isSealed(stored)) return stored as T;
  const cipher = active;
  if (!cipher) throw new ContentEncryptionUnavailable('This row is encrypted; configure AEEIS_CONTENT_ENCRYPTION_KEY_FILE to read it');
  const tenantId = typeof stored.tenantId === 'string' ? stored.tenantId : 'local';
  return await cipher.open({ aggregate, tenantId, id }, stored[SEALED]) as T;
}

/** One sealed string field inside a larger record (Brain claims share a row across tenants). */
export async function sealField(aggregate: string, tenantId: string | undefined, id: string, value: string): Promise<string> {
  const cipher = active;
  return cipher ? cipher.seal({ aggregate, tenantId: tenantId ?? 'local', id }, value) : value;
}
export async function openField(aggregate: string, tenantId: string | undefined, id: string, value: string): Promise<string> {
  if (!value.startsWith(`${ENVELOPE}:`)) return value;
  const cipher = active;
  if (!cipher) throw new ContentEncryptionUnavailable('This field is encrypted; configure AEEIS_CONTENT_ENCRYPTION_KEY_FILE to read it');
  return String(await cipher.open({ aggregate, tenantId: tenantId ?? 'local', id }, value));
}

/** Picks keys that exist on the value. */
export function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

export class InMemoryContentKeyStore implements ContentKeyStore {
  private readonly keys: WrappedDataKey[] = [];
  async list(tenantId: string): Promise<WrappedDataKey[]> { return this.keys.filter(key => key.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(key => ({ ...key })); }
  async insert(key: WrappedDataKey): Promise<WrappedDataKey> {
    const existing = (await this.list(key.tenantId))[0];
    if (existing) return existing;
    this.keys.push({ ...key });
    return { ...key };
  }
  async replace(key: WrappedDataKey): Promise<void> { const index = this.keys.findIndex(item => item.tenantId === key.tenantId && item.keyId === key.keyId); if (index >= 0) this.keys[index] = { ...key }; }
  async all(): Promise<WrappedDataKey[]> { return this.keys.map(key => ({ ...key })); }
}

export const contentKeysMigration = `CREATE TABLE IF NOT EXISTS aeeis_content_keys (
  tenant_id text NOT NULL, key_id text NOT NULL, master_key_id text NOT NULL, wrapped text NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS aeeis_content_keys_one_per_tenant ON aeeis_content_keys(tenant_id);`;

export class PostgresContentKeyStore implements ContentKeyStore {
  constructor(private readonly pool: pg.Pool) {}
  async list(tenantId: string): Promise<WrappedDataKey[]> {
    const result = await this.pool.query<{ tenant_id: string; key_id: string; master_key_id: string; wrapped: string; created_at: Date }>('SELECT tenant_id, key_id, master_key_id, wrapped, created_at FROM aeeis_content_keys WHERE tenant_id=$1 ORDER BY created_at DESC', [tenantId]);
    return result.rows.map(row => ({ tenantId: row.tenant_id, keyId: row.key_id, masterKeyId: row.master_key_id, wrapped: row.wrapped, createdAt: row.created_at.toISOString() }));
  }
  async insert(key: WrappedDataKey): Promise<WrappedDataKey> {
    await this.pool.query('INSERT INTO aeeis_content_keys(tenant_id, key_id, master_key_id, wrapped, created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [key.tenantId, key.keyId, key.masterKeyId, key.wrapped, key.createdAt]);
    return (await this.list(key.tenantId))[0]!;
  }
  async replace(key: WrappedDataKey): Promise<void> {
    await this.pool.query('UPDATE aeeis_content_keys SET master_key_id=$3, wrapped=$4 WHERE tenant_id=$1 AND key_id=$2', [key.tenantId, key.keyId, key.masterKeyId, key.wrapped]);
  }
  async all(): Promise<WrappedDataKey[]> {
    const result = await this.pool.query<{ tenant_id: string; key_id: string; master_key_id: string; wrapped: string; created_at: Date }>('SELECT tenant_id, key_id, master_key_id, wrapped, created_at FROM aeeis_content_keys ORDER BY tenant_id, created_at');
    return result.rows.map(row => ({ tenantId: row.tenant_id, keyId: row.key_id, masterKeyId: row.master_key_id, wrapped: row.wrapped, createdAt: row.created_at.toISOString() }));
  }
}
