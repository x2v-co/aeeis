import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentCipher, InMemoryContentKeyStore, SEALED, configureContentEncryption, isSealed, masterKeyId, openAggregate, openField, parseMasterKey, sealAggregate, sealField } from '../src/content-encryption.js';
import { currentDbScope, withSystemScope, withTenantScope } from '../src/adapters/postgres-pool.js';
import { InMemoryRunRepository } from '../src/adapters/in-memory-run-repository.js';
import { buildApp } from '../src/runtime/http.js';

afterEach(() => configureContentEncryption(undefined));

describe('content encryption', () => {
  it('seals with a per-tenant data key and binds the ciphertext to its row', async () => {
    const store = new InMemoryContentKeyStore();
    const cipher = new ContentCipher(randomBytes(32), store);
    configureContentEncryption(cipher);
    const value = { id: 'run_1', status: 'running', content: 'private notes', nested: { items: [1, 'two'] } };
    const sealed = await sealAggregate('run', 'team-a', 'run_1', value, run => ({ id: run.id, status: run.status }));
    expect(sealed).toMatchObject({ id: 'run_1', status: 'running', tenantId: 'team-a' });
    expect(JSON.stringify(sealed)).not.toContain('private notes');
    expect(await openAggregate('run', 'run_1', sealed)).toEqual(value);
    // Moved to another row, aggregate or tenant, it does not open.
    await expect(openAggregate('run', 'run_2', sealed)).rejects.toThrow();
    await expect(openAggregate('conversation', 'run_1', sealed)).rejects.toThrow();
    await expect(openAggregate('run', 'run_1', { ...(sealed as object), tenantId: 'team-b' })).rejects.toThrow();
    // Tampering is detected.
    const envelope = (sealed as Record<string, string>)[SEALED]!;
    await expect(openAggregate('run', 'run_1', { ...(sealed as object), [SEALED]: `${envelope.slice(0, -4)}AAAA` })).rejects.toThrow();
    // One data key per tenant, wrapped by the master.
    await sealAggregate('run', 'team-b', 'run_9', { id: 'run_9' });
    const keys = await store.all();
    expect(keys.map(key => key.tenantId).sort()).toEqual(['team-a', 'team-b']);
    expect(new Set(keys.map(key => key.keyId)).size).toBe(2);
    expect(JSON.stringify(keys)).not.toContain('private notes');
  });

  it('reads plaintext rows unchanged and leaves content alone without a key', async () => {
    const plain = { id: 'x', content: 'old row' };
    expect(await openAggregate('run', 'x', plain)).toBe(plain);
    expect(await sealAggregate('run', 'team-a', 'x', plain)).toBe(plain);
    expect(await sealField('brain-claim', 'team-a', 'c@1', 'text')).toBe('text');
    configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
    const sealed = await sealAggregate('run', 'team-a', 'x', plain);
    configureContentEncryption(undefined);
    await expect(openAggregate('run', 'x', sealed)).rejects.toThrow('AEEIS_CONTENT_ENCRYPTION_KEY_FILE');
  });

  it('seals single fields for rows shared by tenants', async () => {
    configureContentEncryption(new ContentCipher(randomBytes(32), new InMemoryContentKeyStore()));
    const sealed = await sealField('brain-claim', 'team-a', 'claim_1@1', 'a fact');
    expect(sealed.startsWith('aeeis-enc/1:')).toBe(true);
    expect(await openField('brain-claim', 'team-a', 'claim_1@1', sealed)).toBe('a fact');
    expect(await openField('brain-claim', 'team-a', 'claim_1@1', 'legacy text')).toBe('legacy text');
    await expect(openField('brain-claim', 'team-b', 'claim_1@1', sealed)).rejects.toThrow();
  });

  it('rotates the master key by rewrapping data keys only', async () => {
    const store = new InMemoryContentKeyStore();
    const oldMaster = randomBytes(32), newMaster = randomBytes(32);
    configureContentEncryption(new ContentCipher(oldMaster, store));
    const sealed = await sealAggregate('memory', 'team-a', 'memory_1', { id: 'memory_1', content: 'remember this' });
    // The new master alone cannot read data keys wrapped by the old one.
    configureContentEncryption(new ContentCipher(newMaster, store));
    await expect(openAggregate('memory', 'memory_1', sealed)).rejects.toThrow(masterKeyId(oldMaster));
    const both = new ContentCipher(newMaster, store, [oldMaster]);
    expect(await both.rewrap()).toEqual({ rewrapped: 1, current: 0 });
    configureContentEncryption(new ContentCipher(newMaster, store));
    expect(await openAggregate('memory', 'memory_1', sealed)).toEqual({ id: 'memory_1', content: 'remember this' });
    expect(isSealed(sealed)).toBe(true);
  });

  it('accepts a 32-byte key as base64 or hex only', () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString('base64'))).toEqual(key);
    expect(parseMasterKey(`${key.toString('hex')}\n`)).toEqual(key);
    expect(() => parseMasterKey('short')).toThrow('32 bytes');
    expect(() => parseMasterKey(randomBytes(16).toString('base64'))).toThrow('32 bytes');
  });
});

describe('database scope for requests', () => {
  it('runs a principal\'s handler as its tenant, operators and unauthenticated routes as the system', async () => {
    expect(currentDbScope()).toEqual({ kind: 'system' });
    expect(withTenantScope('team-a', () => withSystemScope(() => currentDbScope()))).toEqual({ kind: 'system' });
    const repository = new InMemoryRunRepository();
    const app = buildApp({ repository, principalTokens: { a: { id: 'alice', tenantId: 'team-a', roles: ['owner'] }, op: { id: 'ops', tenantId: 'team-ops', roles: ['operator'] } } });
    const seen: unknown[] = [];
    app.post('/api/scope-probe', async () => { await new Promise(resolve => setTimeout(resolve, 5)); seen.push(currentDbScope()); return { ok: true }; });
    app.get('/api/agents/scope-probe', async () => { seen.push(currentDbScope()); return { ok: true }; });
    app.get('/webhooks/scope-probe', async () => { seen.push(currentDbScope()); return { ok: true }; });
    try {
      const headers = { host: '127.0.0.1:4323' };
      expect((await app.inject({ method: 'POST', url: '/api/scope-probe', headers: { ...headers, authorization: 'Bearer a', 'content-type': 'application/json' }, payload: { large: 'x'.repeat(50_000) } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/agents/scope-probe', headers: { ...headers, authorization: 'Bearer op' } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/webhooks/scope-probe', headers })).statusCode).toBe(200);
      expect(seen).toEqual([{ kind: 'tenant', tenantId: 'team-a' }, { kind: 'system' }, { kind: 'system' }]);
    } finally { await app.close(); }
  });
});
