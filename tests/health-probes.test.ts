import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthProbes, HealthProbeTimeout, type ProbeHealth } from '../src/runtime/health-probes.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import type { ToolGateway } from '../src/integrations.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const good: ProbeHealth = { ready: true, detail: 'tool manifest reachable' };

describe('cached read-only health probes', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('shares concurrent probes and caches serial calls until the TTL expires', async () => {
    const cache = new HealthProbes();
    const operation = vi.fn(async () => good);
    expect(await Promise.all([cache.get('tools', operation), cache.get('tools', operation)])).toEqual([good, good]);
    expect(await cache.get('tools', operation)).toEqual(good);
    expect(operation).toHaveBeenCalledTimes(1);
    vi.setSystemTime(12_001);
    expect(await cache.get('tools', operation)).toMatchObject({ ready: true, stale: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(await cache.get('tools', operation)).toEqual(good);
  });

  it('returns a last-good result immediately during slow refresh and fails after grace expires', async () => {
    const cache = new HealthProbes();
    const held = deferred<ProbeHealth>();
    const operation = vi.fn().mockResolvedValueOnce(good).mockImplementation(() => held.promise);
    await cache.get('tools', operation);
    vi.setSystemTime(12_001);
    expect(await cache.get('tools', operation)).toMatchObject({ ready: true, stale: true, lastGoodAt: new Date(10_000).toISOString() });
    expect(await cache.get('tools', operation)).toMatchObject({ ready: true });
    expect(operation).toHaveBeenCalledTimes(2);
    vi.setSystemTime(20_001);
    const pending = cache.get('tools', operation);
    const rejected = expect(pending).rejects.toBeInstanceOf(HealthProbeTimeout);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    // The timed-out provider is still single-flight, and repeated checks are cached.
    await expect(cache.get('tools', operation)).rejects.toBeInstanceOf(HealthProbeTimeout);
    expect(operation).toHaveBeenCalledTimes(2);
    held.resolve(good);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.get('tools', operation)).toEqual(good);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each(['failure', 'exception'] as const)('does not extend last-good grace on %s', async mode => {
    const cache = new HealthProbes();
    const operation = vi.fn().mockResolvedValueOnce(good).mockImplementation(async () => {
      if (mode === 'exception') throw new Error('private provider failure');
      return { ready: false, detail: 'tool registry unavailable' };
    });
    await cache.get('tools', operation);
    vi.setSystemTime(12_001);
    expect(await cache.get('tools', operation)).toMatchObject({ ready: true, stale: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.get('tools', operation)).toMatchObject({ ready: true, detail: expect.stringContaining('last successful probe') });
    vi.setSystemTime(20_001);
    const pending = cache.get('tools', operation);
    if (mode === 'exception') await expect(pending).rejects.toThrow('private provider failure');
    else expect(await pending).toEqual({ ready: false, detail: 'tool registry unavailable' });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('bounds cold hanging probes, caches timeouts and retains late successes', async () => {
    const cache = new HealthProbes();
    const held = deferred<ProbeHealth>();
    const operation = vi.fn(() => held.promise);
    const rejected = expect(cache.get('tools', operation)).rejects.toBeInstanceOf(HealthProbeTimeout);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    await expect(cache.get('tools', operation)).rejects.toBeInstanceOf(HealthProbeTimeout);
    expect(operation).toHaveBeenCalledTimes(1);
    held.resolve(good);
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.get('tools', operation)).toEqual(good);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('handles a late rejection and can recover on the next probe', async () => {
    const cache = new HealthProbes();
    const held = deferred<ProbeHealth>();
    const operation = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(good);
    const rejected = expect(cache.get('tools', operation)).rejects.toBeInstanceOf(HealthProbeTimeout);
    await vi.advanceTimersByTimeAsync(500); await rejected;
    held.reject(new Error('private failure'));
    await vi.advanceTimersByTimeAsync(0);
    await expect(cache.get('tools', operation)).rejects.toThrow('private failure');
    vi.setSystemTime(12_501);
    expect(await cache.get('tools', operation)).toEqual(good);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('validates cache/deadline settings', () => {
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { cacheTtlMs: -1 }, { lastGoodGraceMs: NaN }]) expect(() => new HealthProbes(options)).toThrow();
  });
});

describe('HTTP readiness health caching', () => {
  it('shares cached tools health across readyz, status and metrics while leaving manifests live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-cache-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const health = vi.fn(async () => good);
    const listTools = vi.fn(async () => []);
    const invoke = vi.fn(async () => { throw new Error('No capability invocation permitted'); });
    const tools: ToolGateway = { health, listTools, invoke };
    const app = buildApp({ repository, tools });
    try {
      for (let index = 0; index < 3; index++) {
        const ready = await app.inject('/readyz');
        expect(ready.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'tools', ready: true })]));
      }
      expect((await app.inject('/api/status')).json().toolsHealth).toEqual(good);
      expect((await app.inject('/metrics')).body).toContain('aeeis_readiness_check{check="tools",required="false"} 1');
      expect(health).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      expect(listTools).not.toHaveBeenCalled();
      await app.inject('/api/tools'); await app.inject('/api/tools');
      expect(listTools).toHaveBeenCalledTimes(2);
    } finally { await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not flap tools during slow refresh, expires grace, and recovers from the late result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-grace-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const held = deferred<ProbeHealth>();
    let time = 10_000;
    const date = vi.spyOn(Date, 'now').mockImplementation(() => time);
    const health = vi.fn().mockResolvedValueOnce(good).mockImplementation(() => held.promise);
    const tools: ToolGateway = { health, listTools: async () => [], invoke: async () => { throw new Error('unused'); } };
    const app = buildApp({ repository, tools, readinessCheckTimeoutMs: 100 });
    const check = async () => (await app.inject('/readyz')).json().checks.find((check: { name: string }) => check.name === 'tools');
    try {
      expect(await check()).toMatchObject({ ready: true });
      time = 12_001;
      expect(await check()).toMatchObject({ ready: true, stale: true, detail: expect.stringContaining('last successful probe') });
      expect(await check()).toMatchObject({ ready: true });
      expect(health).toHaveBeenCalledTimes(2);
      time = 20_001;
      expect(await check()).toMatchObject({ ready: false, detail: 'Tool gateway health probe timed out' });
      expect(await check()).toMatchObject({ ready: false });
      expect(health).toHaveBeenCalledTimes(2);
      held.resolve(good);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(await check()).toMatchObject({ ready: true });
      expect(health).toHaveBeenCalledTimes(2);
    } finally { held.resolve(good); date.mockRestore(); await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
