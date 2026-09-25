import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { CachedPrincipalDirectory, HttpPrincipalDirectory, InMemoryPrincipalDirectory, PrincipalDirectoryUnavailable, type PrincipalDirectory } from '../src/security/principal-directory.js';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import type { ModelAdapter } from '../src/runtime/model.js';
import { buildApp } from '../src/runtime/http.js';
import { InMemoryRoomMembershipRepository } from '../src/room-membership.js';

describe('principal directory invitation boundary', () => {
  it('coalesces concurrent lookups, caches negative results, and supports explicit invalidation', async () => {
    let calls = 0;
    let current: { principalId: string; tenantId: string; status: 'active' | 'suspended' } | undefined;
    const backend: PrincipalDirectory = {
      lookup: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return current; },
      health: async () => ({ ready: true, detail: 'backend ready' }),
    };
    const directory = new CachedPrincipalDirectory(backend, { ttlMs: 50, maxEntries: 2 });
    const results = await Promise.all([
      directory.lookup('bob', 'team-a'), directory.lookup('bob', 'team-a'), directory.lookup('bob', 'team-a'),
    ]);
    expect(results).toEqual([undefined, undefined, undefined]);
    expect(calls).toBe(1);
    current = { principalId: 'bob', tenantId: 'team-a', status: 'active' };
    await expect(directory.lookup('bob', 'team-a')).resolves.toBeUndefined();
    expect(calls).toBe(1);
    directory.invalidate('bob', 'team-a');
    await expect(directory.lookup('bob', 'team-a')).resolves.toMatchObject({ principalId: 'bob' });
    expect(calls).toBe(2);
    await expect(directory.health()).resolves.toEqual({ ready: true, detail: 'backend ready' });
  });

  it('does not cache directory outages and never falls back to stale identity data', async () => {
    let calls = 0;
    const backend: PrincipalDirectory = { lookup: async () => { calls += 1; throw new PrincipalDirectoryUnavailable('offline'); } };
    const directory = new CachedPrincipalDirectory(backend, { ttlMs: 10_000 });
    await expect(directory.lookup('bob', 'team-a')).rejects.toBeInstanceOf(PrincipalDirectoryUnavailable);
    await expect(directory.lookup('bob', 'team-a')).rejects.toBeInstanceOf(PrincipalDirectoryUnavailable);
    expect(calls).toBe(2);
    await expect(directory.health()).resolves.toEqual({ ready: false, detail: 'Principal directory health probe unavailable' });
  });

  it('expires cached identity state at the configured TTL', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let status: 'active' | 'suspended' = 'active';
      const directory = new CachedPrincipalDirectory({ lookup: async () => { calls += 1; return { principalId: 'bob', tenantId: 'team-a', status }; } }, { ttlMs: 25 });
      await expect(directory.lookup('bob', 'team-a')).resolves.toMatchObject({ status: 'active' });
      status = 'suspended';
      await vi.advanceTimersByTimeAsync(26);
      await expect(directory.lookup('bob', 'team-a')).resolves.toMatchObject({ status: 'suspended' });
      expect(calls).toBe(2);
    } finally { vi.useRealTimers(); }
  });

  it('does not repopulate an entry after invalidation or close races an in-flight lookup', async () => {
    let release!: (value: { principalId: string; tenantId: string; status: 'active' }) => void;
    const pending = new Promise<{ principalId: string; tenantId: string; status: 'active' }>(resolve => { release = resolve; });
    const backend: PrincipalDirectory = { lookup: async () => pending };
    const directory = new CachedPrincipalDirectory(backend, { ttlMs: 10_000 });
    const lookup = directory.lookup('bob', 'team-a');
    directory.invalidate('bob', 'team-a');
    release({ principalId: 'bob', tenantId: 'team-a', status: 'active' });
    await expect(lookup).resolves.toMatchObject({ principalId: 'bob' });
    expect(directory.cacheSize).toBe(0);

    let releaseSecond!: (value: { principalId: string; tenantId: string; status: 'active' }) => void;
    const second = new Promise<{ principalId: string; tenantId: string; status: 'active' }>(resolve => { releaseSecond = resolve; });
    const closing = new CachedPrincipalDirectory({ lookup: async () => second }, { ttlMs: 10_000 });
    const inFlight = closing.lookup('bob', 'team-a');
    await closing.close();
    releaseSecond({ principalId: 'bob', tenantId: 'team-a', status: 'active' });
    await expect(inFlight).resolves.toMatchObject({ principalId: 'bob' });
    expect(closing.cacheSize).toBe(0);
  });

  it('rejects a directory response for a different principal', async () => {
    const directory = new InMemoryPrincipalDirectory([{ principalId: 'actual', tenantId: 'team-a', status: 'active' }]);
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships, { lookup: async () => ({ principalId: 'actual', tenantId: 'team-a', status: 'active' }) });
    const room = await domain.createRoom({ title: 'Directory room' }, undefined, 'alice', 'team-a');
    await expect(domain.addRoomMember(room.id, 'requested', 'viewer', 'alice', 'team-a')).rejects.toThrow('not in this tenant');
    await expect(directory.lookup('actual', 'team-a')).resolves.toMatchObject({ principalId: 'actual' });
  });

  it('accepts only an active principal from the same tenant', async () => {
    const directory = new InMemoryPrincipalDirectory([
      { principalId: 'bob', tenantId: 'team-a', status: 'active' },
      { principalId: 'suspended', tenantId: 'team-a', status: 'suspended' },
      { principalId: 'other', tenantId: 'team-b', status: 'active' },
    ]);
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships, directory);
    const room = await domain.createRoom({ title: 'Directory room' }, undefined, 'alice', 'team-a');
    await expect(domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a')).resolves.toMatchObject({ principalId: 'bob', status: 'active' });
    await expect(domain.addRoomMember(room.id, 'missing', 'viewer', 'alice', 'team-a')).rejects.toThrow('not in this tenant');
    await expect(domain.addRoomMember(room.id, 'suspended', 'viewer', 'alice', 'team-a')).rejects.toThrow('not active');
    await expect(domain.addRoomMember(room.id, 'other', 'viewer', 'alice', 'team-a')).rejects.toThrow('not in this tenant');
  });

  it('fails closed when the configured directory is unavailable', async () => {
    const unavailable: PrincipalDirectory = { lookup: async () => { throw new PrincipalDirectoryUnavailable('offline'); } };
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships, unavailable);
    const room = await domain.createRoom({ title: 'Directory room' }, undefined, 'alice', 'team-a');
    await expect(domain.addRoomMember(room.id, 'bob', 'viewer', 'alice', 'team-a')).rejects.toBeInstanceOf(PrincipalDirectoryUnavailable);
    await expect(memberships.list(room.id, 'team-a')).resolves.toEqual([]);
  });

  it('keeps local development behavior when no directory is configured', async () => {
    const memberships = new InMemoryRoomMembershipRepository();
    const domain = new AeeisService(new InMemoryStore(), [], memberships);
    const room = await domain.createRoom({ title: 'Local room' }, undefined, 'alice', 'team-a');
    await expect(domain.addRoomMember(room.id, 'arbitrary-principal', 'agent', 'alice', 'team-a')).resolves.toMatchObject({ principalId: 'arbitrary-principal' });
  });

  it('uses the HTTP directory contract without exposing credentials in the URL', async () => {
    const server = createServer((request, response) => {
      expect(request.headers.authorization).toBe('Bearer directory-secret');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('content-type', 'application/json');
      if (url.searchParams.get('principalId') === 'bob') {
        expect(url.searchParams.get('tenantId')).toBe('team-a');
        response.end(JSON.stringify({ principalId: 'bob', tenantId: 'team-a', status: 'active' }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const directory = new HttpPrincipalDirectory(`http://127.0.0.1:${address.port}/lookup`, 'directory-secret');
      await expect(directory.lookup('bob', 'team-a')).resolves.toMatchObject({ principalId: 'bob', status: 'active' });
      await expect(directory.health()).resolves.toEqual({ ready: true, detail: 'principal directory reachable' });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('makes a configured directory a required readiness dependency', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-principal-directory-ready-'))); await repo.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }), health: async () => ({ ready: true, detail: 'fixture ready' }) };
    const directory: PrincipalDirectory = { lookup: async () => undefined, health: async () => ({ ready: false, detail: 'directory unavailable' }) };
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, model), principalDirectory: directory });
    try {
      const response = await app.inject('/readyz');
      expect(response.statusCode).toBe(503);
      expect(response.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'principalDirectory', required: true, ready: false, detail: 'directory unavailable' })]));
    } finally { await app.close(); await repo.close(); }
  });

  it('does not silently skip a directory adapter without a health probe', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-principal-directory-no-health-'))); await repo.init();
    const model: ModelAdapter = { pin: { model: 'fixture', endpoint: 'http://127.0.0.1/chat', promptVersion: 'fixture/1' }, complete: async () => ({ value: {} }), health: async () => ({ ready: true, detail: 'fixture ready' }) };
    const directory: PrincipalDirectory = { lookup: async () => undefined };
    const app = buildApp({ repository: repo, engine: new AgentEngine(repo, model), principalDirectory: directory });
    try {
      const response = await app.inject('/readyz');
      expect(response.statusCode).toBe(503);
      expect(response.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'principalDirectory', required: true, ready: false, detail: 'Principal directory health probe unavailable' })]));
    } finally { await app.close(); await repo.close(); }
  });

  it('maps directory outage to HTTP 503 and preserves membership state', async () => {
    const repo = new FileRunRepository(await mkdtemp(join(tmpdir(), 'aeeis-principal-directory-http-'))); await repo.init();
    const domainStore = new InMemoryStore();
    const memberships = new InMemoryRoomMembershipRepository();
    const directory: PrincipalDirectory = { lookup: async () => { throw new PrincipalDirectoryUnavailable('offline'); }, health: async () => ({ ready: false, detail: 'directory unavailable' }) };
    const domain = new AeeisService(domainStore, [], memberships, directory);
    const app = buildApp({ repository: repo, domain, principalDirectory: directory, principalTokens: { alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] } } });
    try {
      const created = await app.inject({ method: 'POST', url: '/api/rooms', headers: { authorization: 'Bearer alice' }, payload: { title: 'HTTP directory room' } });
      const room = created.json() as { id: string };
      const invited = await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/members`, headers: { authorization: 'Bearer alice' }, payload: { principalId: 'bob', role: 'viewer' } });
      expect(invited.statusCode).toBe(503);
      await expect(memberships.list(room.id, 'team-a')).resolves.toEqual([]);
      expect((await app.inject({ url: '/readyz', headers: { authorization: 'Bearer alice' } })).statusCode).toBe(503);
    } finally { await app.close(); await repo.close(); await memberships.close(); }
  });
});
