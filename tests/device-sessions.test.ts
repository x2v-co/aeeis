import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { InMemoryDeviceSessionRepository, JsonDeviceSessionRepository } from '../src/device-sessions.js';

describe('multi-terminal device sessions', () => {
  const resources: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(resources.splice(0).map(resource => resource.close())); });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-device-sessions-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const deviceSessions = new InMemoryDeviceSessionRepository();
    const app = buildApp({ repository, deviceSessions, principalTokens: {
      alice: { id: 'alice', tenantId: 'team-a', roles: ['owner'] },
      bob: { id: 'bob', tenantId: 'team-a', roles: ['owner'] },
      agent: { id: 'agent', tenantId: 'team-a', roles: ['agent'] },
      otherTenant: { id: 'other', tenantId: 'team-b', roles: ['owner'] },
    } });
    const close = async () => { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); };
    resources.push({ close });
    return { app, deviceSessions };
  }

  it('registers, lists, authenticates and revokes a device session', async () => {
    const { app } = await fixture();
    const auth = { authorization: 'Bearer alice' };
    const registered = await app.inject({ method: 'POST', url: '/api/devices', headers: auth, payload: { label: 'Laptop', capabilities: ['read', 'execute'] } });
    expect(registered.statusCode).toBe(201);
    const device = registered.json();
    expect(device).toMatchObject({ owner: 'alice', tenantId: 'team-a', label: 'Laptop', capabilities: ['read', 'execute'] });
    expect(device.id).toMatch(/^device_[0-9a-f-]{36}$/);

    const listed = await app.inject({ method: 'GET', url: '/api/devices', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const withDevice = await app.inject({ method: 'GET', url: '/api/status', headers: { ...auth, 'x-aeeis-device-id': device.id } });
    expect(withDevice.statusCode).toBe(200);
    expect(withDevice.json()).toMatchObject({ deviceSessionsConfigured: true, principal: 'alice' });

    const revoked = await app.inject({ method: 'POST', url: `/api/devices/${device.id}/revoke`, headers: auth });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().revokedAt).toEqual(expect.any(String));
    const revokedAgain = await app.inject({ method: 'POST', url: `/api/devices/${device.id}/revoke`, headers: auth });
    expect(revokedAgain.statusCode).toBe(200);
    expect(revokedAgain.json().revokedAt).toBe(revoked.json().revokedAt);
    const denied = await app.inject({ method: 'GET', url: '/api/status', headers: { ...auth, 'x-aeeis-device-id': device.id } });
    expect(denied.statusCode).toBe(401);
  });

  it('keeps device ownership and tenant boundaries isolated', async () => {
    const { app } = await fixture();
    const registered = await app.inject({ method: 'POST', url: '/api/devices', headers: { authorization: 'Bearer alice' }, payload: { label: 'Phone', capabilities: ['read'] } });
    const id = registered.json().id as string;
    const bob = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer bob', 'x-aeeis-device-id': id } });
    expect(bob.statusCode).toBe(401);
    const otherTenant = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer otherTenant', 'x-aeeis-device-id': id } });
    expect(otherTenant.statusCode).toBe(401);
    const agentRegister = await app.inject({ method: 'POST', url: '/api/devices', headers: { authorization: 'Bearer agent' }, payload: { label: 'Agent', capabilities: ['read'] } });
    expect(agentRegister.statusCode).toBe(403);
    const malformed = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer alice', 'x-aeeis-device-id': 'not-a-device' } });
    expect(malformed.statusCode).toBe(400);
  });

  it('preserves compatibility for clients without a device header', async () => {
    const { app } = await fixture();
    const response = await app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer alice' } });
    expect(response.statusCode).toBe(200);
  });

  it('persists device sessions across a JSON repository restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-device-store-'));
    const path = join(directory, 'device-sessions.json');
    const first = new JsonDeviceSessionRepository(path); await first.init();
    const created = await first.register({ owner: 'alice', tenantId: 'team-a', label: 'Tablet', capabilities: ['read'] });
    await first.close();
    const second = new JsonDeviceSessionRepository(path); await second.init();
    await expect(second.get(created.id, { owner: 'alice', tenantId: 'team-a' })).resolves.toMatchObject({ id: created.id, label: 'Tablet' });
    await expect(second.touch(created.id, { owner: 'alice', tenantId: 'team-a' })).resolves.toMatchObject({ id: created.id });
    await expect(second.revoke(created.id, { owner: 'alice', tenantId: 'team-a' })).resolves.toMatchObject({ id: created.id, revokedAt: expect.any(String) });
    await second.close();
    await rm(directory, { recursive: true, force: true });
  });
});
