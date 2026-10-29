import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundHealthMonitor, HealthProbes, HealthProbeTimeout, type ProbeHealth } from '../src/runtime/health-probes.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/runtime/http.js';
import { FileRunRepository } from '../src/runtime/repository.js';
import { AgentEngine } from '../src/runtime/engine.js';
import { AeeisService } from '../src/application/aeeis-service.js';
import { InMemoryStore } from '../src/adapters/in-memory-store.js';
import { InMemoryTaskDispatchRepository, TaskScheduler } from '../src/task-scheduler.js';
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

describe('background tools health monitor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000); });
  afterEach(() => { vi.useRealTimers(); });

  it('uses a 3s deadline and a 60s refresh interval, and snapshots never probe', async () => {
    const held = deferred<ProbeHealth>();
    const operation = vi.fn(() => held.promise);
    const monitor = new BackgroundHealthMonitor(operation);
    expect(monitor.snapshot()).toMatchObject({ ready: false, detail: 'Tool gateway health probe unavailable' });
    expect(operation).not.toHaveBeenCalled();
    monitor.start(); monitor.start();
    try {
      await vi.advanceTimersByTimeAsync(2_999);
      expect(operation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(monitor.snapshot()).toMatchObject({ ready: false, detail: 'Tool gateway health probe timed out', lastCheckedAt: new Date(13_000).toISOString() });
      held.resolve(good);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(56_999);
      expect(operation).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(operation).toHaveBeenCalledTimes(2);
    } finally { monitor.stop(); }
  });

  it.each(['timeoutMs', 'refreshIntervalMs', 'lastGoodRetentionMs'] as const)('rejects invalid %s', name => {
    for (const value of [0, -1, NaN, Infinity]) expect(() => new BackgroundHealthMonitor(() => good, { [name]: value })).toThrow(name);
  });

  it('shares one cycle and never overlaps an operation, even after timeout', async () => {
    const held = deferred<ProbeHealth>();
    const operation = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(good);
    const monitor = new BackgroundHealthMonitor(operation, { timeoutMs: 100, refreshIntervalMs: 200 });
    monitor.start();
    try {
      const first = monitor.refreshNow();
      expect(monitor.refreshNow()).toBe(first);
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      await monitor.refreshNow();
      expect(operation).toHaveBeenCalledTimes(1);
      held.reject(new Error('late private failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.snapshot().detail).toBe('Tool gateway health probe timed out');
      await monitor.refreshNow();
      expect(operation).toHaveBeenCalledTimes(2);
      expect(monitor.snapshot()).toMatchObject(good);
    } finally { monitor.stop(); }
  });

  it.each(['failure', 'exception', 'timeout'] as const)('retains success for 15 minutes after %s without extending retention', async mode => {
    const operation = vi.fn().mockResolvedValueOnce(good).mockImplementation(() => {
      if (mode === 'exception') throw new Error('private provider failure');
      if (mode === 'timeout') return new Promise<ProbeHealth>(() => {});
      return { ready: false, detail: 'tool registry unavailable' };
    });
    const monitor = new BackgroundHealthMonitor(operation);
    await monitor.refreshNow();
    vi.setSystemTime(11_000);
    const refresh = monitor.refreshNow();
    await vi.advanceTimersByTimeAsync(3_000);
    await refresh;
    const reason = mode === 'exception' ? 'Tool gateway health probe failed' : mode === 'timeout' ? 'Tool gateway health probe timed out' : 'tool registry unavailable';
    expect(monitor.snapshot()).toMatchObject({ ready: true, stale: true, lastGoodAt: new Date(10_000).toISOString(), detail: `${good.detail}; using last successful probe (${reason})` });
    vi.setSystemTime(909_999);
    expect(monitor.snapshot()).toMatchObject({ ready: true, stale: true });
    vi.setSystemTime(910_000);
    expect(monitor.snapshot()).toMatchObject({ ready: false, detail: reason, lastCheckedAt: expect.any(String) });
    expect(monitor.snapshot().stale).toBeUndefined();
    monitor.stop();
  });

  it('retains a late success after timeout and uses it for subsequent failures', async () => {
    const held = deferred<ProbeHealth>();
    const operation = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue({ ready: false, detail: 'registry unavailable' });
    const monitor = new BackgroundHealthMonitor(operation, { timeoutMs: 100, lastGoodRetentionMs: 1_000 });
    const refresh = monitor.refreshNow();
    await vi.advanceTimersByTimeAsync(100); await refresh;
    expect(monitor.snapshot().ready).toBe(false);
    held.resolve(good);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.snapshot()).toMatchObject({ ready: true, stale: true, detail: `${good.detail}; using last successful probe (Tool gateway health probe timed out)`, lastGoodAt: new Date(10_100).toISOString() });
    await monitor.refreshNow();
    expect(monitor.snapshot()).toMatchObject({ ready: true, stale: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitor.snapshot()).toMatchObject({ ready: false, detail: 'registry unavailable' });
    monitor.stop();
  });

  it('stop clears refresh and deadline timers without waiting for a hung operation', async () => {
    const operation = vi.fn(() => new Promise<ProbeHealth>(() => {}));
    const monitor = new BackgroundHealthMonitor(operation);
    monitor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    monitor.stop(); monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('HTTP readiness health caching', () => {
  it.each(['pending', 'failure', 'exception', 'unavailable'] as const)('warms the first %s probe at boot, stays 503 and fails honestly after startup grace', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-startup-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const held = deferred<ProbeHealth>();
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const health = vi.fn(async () => {
      if (mode === 'pending') return held.promise;
      if (mode === 'exception') throw new Error('private failure');
      return { ready: false, detail: 'tool manifest unavailable' };
    });
    const tools: ToolGateway = { ...(mode === 'unavailable' ? {} : { health }), listTools: async () => [], invoke: async () => { throw new Error('unused'); } };
    const domain = new AeeisService(new InMemoryStore());
    const engine = new AgentEngine(repository, {
      pin: { model: 'fixture', endpoint: 'http://127.0.0.1:1', promptVersion: 'test' }, complete: async () => ({ value: {} }),
      health: async () => ({ ...good, checkedAt: new Date().toISOString() }),
    });
    const dispatcher = { notify: async () => {}, close: async () => {} };
    const taskScheduler = new TaskScheduler(domain, engine, dispatcher, new InMemoryTaskDispatchRepository());
    const app = buildApp({ repository, tools, engine, domain, dispatcher, taskScheduler, readinessToolsTimeoutMs: 100, readinessToolsGraceMs: 1000 });
    try {
      await app.ready(); // Boot alone initiates the probe, with no readiness request.
      await vi.advanceTimersByTimeAsync(100);
      expect(health).toHaveBeenCalledTimes(mode === 'unavailable' ? 0 : 1);
      const warm = await app.inject('/readyz');
      expect(warm.statusCode).toBe(503);
      expect(warm.json().checks.filter((check: { required: boolean }) => check.required).every((check: { ready: boolean }) => check.ready)).toBe(true);
      expect(warm.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'tools', ready: false, state: 'warming', detail: 'warming' })]));
      vi.setSystemTime(11_001);
      const failed = await app.inject('/readyz');
      expect(failed.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'tools', ready: false, state: 'failed', lastCheckedAt: expect.any(String), detail: mode === 'pending' ? 'Tool gateway health probe timed out' : mode === 'exception' ? 'Tool gateway health probe failed' : mode === 'unavailable' ? 'Tool gateway health probe unavailable' : 'tool manifest unavailable' })]));
      expect(health).toHaveBeenCalledTimes(mode === 'unavailable' ? 0 : 1);
      if (mode === 'pending') {
        held.resolve(good);
        await vi.advanceTimersByTimeAsync(0);
        const recovered = await app.inject('/readyz');
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'tools', ready: true })]));
      }
    } finally { held.resolve(good); vi.useRealTimers(); await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('validates the tools startup grace environment setting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-env-'));
    const repository = new FileRunRepository(directory); await repository.init();
    try {
      vi.stubEnv('AEEIS_READY_TOOLS_GRACE_MS', '-1');
      expect(() => buildApp({ repository })).toThrow('AEEIS_READY_TOOLS_GRACE_MS');
    } finally { vi.unstubAllEnvs(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['AEEIS_READY_TOOLS_TIMEOUT_MS', 'AEEIS_READY_TOOLS_REFRESH_MS', 'AEEIS_READY_TOOLS_LAST_GOOD_MS'] as const)('validates %s at the HTTP boundary', async name => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-tools-env-'));
    const repository = new FileRunRepository(directory); await repository.init();
    try {
      for (const value of ['0', '-1', 'NaN', 'Infinity', 'abc']) {
        vi.stubEnv(name, value);
        expect(() => buildApp({ repository })).toThrow(name);
      }
    } finally { vi.unstubAllEnvs(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['AEEIS_READY_TOOLS_TIMEOUT_MS', 'AEEIS_READY_TOOLS_REFRESH_MS', 'AEEIS_READY_TOOLS_LAST_GOOD_MS'] as const)('accepts blank %s at the HTTP boundary', async name => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-tools-blank-env-'));
    const repository = new FileRunRepository(directory); await repository.init();
    try {
      for (const value of ['', '   ']) {
        vi.stubEnv(name, value);
        const app = buildApp({ repository });
        try { await app.ready(); } finally { await app.close(); }
      }
    } finally { vi.unstubAllEnvs(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it.each(['readinessToolsTimeoutMs', 'readinessToolsRefreshMs', 'readinessToolsLastGoodMs'] as const)('validates the %s option', async name => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-tools-option-'));
    const repository = new FileRunRepository(directory); await repository.init();
    try {
      for (const value of [0, -1, NaN, Infinity]) expect(() => buildApp({ repository, [name]: value })).toThrow('positive finite number');
    } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('allows a 1.5s tools probe with a 3s tools timeout while other probes still time out at 500ms', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-tools-deadline-'));
    const repository = new FileRunRepository(directory); await repository.init();
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const health = vi.fn(() => new Promise<ProbeHealth>(resolve => { setTimeout(() => resolve(good), 1_500); }));
    const tools: ToolGateway = { health, listTools: async () => [], invoke: async () => { throw new Error('unused'); } };
    const knowledgeHealth = vi.fn(() => new Promise<ProbeHealth>(() => {}));
    const knowledgeProvider = { search: async () => [], health: knowledgeHealth };
    vi.stubEnv('AEEIS_READY_TOOLS_TIMEOUT_MS', '3000');
    const app = buildApp({ repository, tools, knowledgeProvider });
    try {
      await app.ready();
      await vi.advanceTimersByTimeAsync(0);
      const response = app.inject('/readyz');
      // Let Fastify enter the handler before advancing its probe deadline.
      await new Promise<void>(resolve => process.nextTick(resolve));
      await vi.advanceTimersByTimeAsync(499);
      expect(knowledgeHealth).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const warming = (await response).json();
      expect(warming.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'knowledgeProvider', ready: false, detail: 'Knowledge provider health probe timed out' }),
        expect.objectContaining({ name: 'tools', required: false, state: 'warming' }),
      ]));
      expect(Date.now()).toBe(10_500);
      await vi.advanceTimersByTimeAsync(1_000);
      const ready = (await app.inject('/readyz')).json();
      expect(ready.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'tools', required: false, ready: true, detail: good.detail, lastCheckedAt: new Date(11_500).toISOString() }),
      ]));
      expect(health).toHaveBeenCalledTimes(1);
    } finally { await app.close(); vi.useRealTimers(); vi.unstubAllEnvs(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('reads background tools health across readyz, status and metrics without probing, while leaving manifests live', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-cache-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const health = vi.fn(async () => good);
    const listTools = vi.fn(async () => []);
    const invoke = vi.fn(async () => { throw new Error('No capability invocation permitted'); });
    const tools: ToolGateway = { health, listTools, invoke };
    vi.useFakeTimers();
    const app = buildApp({ repository, tools });
    try {
      await app.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(health).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 3; index++) {
        const ready = await app.inject('/readyz');
        expect(ready.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'tools', ready: true })]));
      }
      // Passing the old cache TTL must not make a readiness read refresh tools.
      await vi.advanceTimersByTimeAsync(3_000);
      await app.inject('/readyz');
      expect((await app.inject('/api/status')).json().toolsHealth).toMatchObject(good);
      expect((await app.inject('/metrics')).body).toContain('aeeis_readiness_check{check="tools",required="false"} 1');
      expect(health).toHaveBeenCalledTimes(1);
      expect(invoke).not.toHaveBeenCalled();
      expect(listTools).not.toHaveBeenCalled();
      await app.inject('/api/tools'); await app.inject('/api/tools');
      expect(listTools).toHaveBeenCalledTimes(2);
      await app.close();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(health).toHaveBeenCalledTimes(1);
    } finally { await app.close(); vi.useRealTimers(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('does not flap tools during slow refresh, expires grace, and recovers from the late result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ready-grace-'));
    const repository = new FileRunRepository(directory); await repository.init();
    const held = deferred<ProbeHealth>();
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const health = vi.fn().mockResolvedValueOnce(good).mockImplementation(() => held.promise);
    const tools: ToolGateway = { health, listTools: async () => [], invoke: async () => { throw new Error('unused'); } };
    const app = buildApp({ repository, tools, readinessToolsTimeoutMs: 100, readinessToolsRefreshMs: 2_000, readinessToolsLastGoodMs: 10_000 });
    const check = async () => (await app.inject('/readyz')).json().checks.find((check: { name: string }) => check.name === 'tools');
    try {
      await app.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(await check()).toMatchObject({ ready: true });
      await vi.advanceTimersByTimeAsync(2_100);
      expect(await check()).toMatchObject({ ready: true, stale: true, detail: expect.stringContaining('last successful probe') });
      expect(await check()).toMatchObject({ ready: true });
      expect(health).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(7_900);
      expect(await check()).toMatchObject({ ready: false, detail: 'Tool gateway health probe timed out' });
      expect(await check()).toMatchObject({ ready: false });
      expect(health).toHaveBeenCalledTimes(2);
      held.resolve(good);
      await vi.advanceTimersByTimeAsync(0);
      expect(await check()).toMatchObject({ ready: true });
      expect(health).toHaveBeenCalledTimes(2);
    } finally { held.resolve(good); vi.useRealTimers(); await app.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
