import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalToolGateway } from '../src/local-tools.js';
import { DockerSandbox } from '../src/docker-sandbox.js';

const RUN = `run_${'5'.repeat(36)}`;
describe('a kept machine', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it('is woken while its keep lasts, so its own idle timer cannot end the preview early, and released after', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aeeis-kept-'));
    const configFile = join(root, 'tools.json');
    await writeFile(configFile, JSON.stringify({ schemaVersion: 'local-tools/1', workspaceRoot: 'workspaces', stateDirectory: 'receipts', tools: ['shell'], defaultAllowedTools: ['shell'], sandbox: { idleSeconds: 3600 } }));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
    let keepUntil = Date.now() + 4 * 3_600_000;
    vi.spyOn(DockerSandbox.prototype, 'pendingRuns').mockImplementation(async () => [{ runId: RUN, expired: false, keepUntil }]);
    const touch = vi.spyOn(DockerSandbox.prototype, 'touch').mockResolvedValue(true);
    const release = vi.spyOn(DockerSandbox.prototype, 'release').mockResolvedValue(undefined);
    const gateway = await LocalToolGateway.load(configFile);
    try {
      await gateway.reap(async () => 'succeeded');
      await gateway.reap(async () => 'succeeded');
      expect(touch).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await gateway.reap(async () => 'succeeded');
      expect(touch).toHaveBeenCalledTimes(2);
      expect(release).not.toHaveBeenCalled();
      keepUntil = Date.now() - 1;
      await gateway.reap(async () => 'succeeded');
      expect(release).toHaveBeenCalledTimes(1);
      expect(touch).toHaveBeenCalledTimes(2);
    } finally { await gateway.close(); await rm(root, { recursive: true, force: true }); }
  });
});
