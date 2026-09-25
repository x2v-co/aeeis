import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { OwnHowCliGovernance } from '../src/integrations.js';

const ownhowAvailable = spawnSync('ownhow', ['--help'], { stdio: 'ignore' }).status === 0;

describe('OwnHow CLI governance adapter', () => {
  it('reports a successful status protocol check', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ownhow-health-'));
    const executable = join(directory, 'ownhow-health.mjs');
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({components:1,receipts:0,methods:1,pendingImports:0}));\n');
    await chmod(executable, 0o755);
    try {
      const health = await new OwnHowCliGovernance(executable).health!();
      expect(health.ready).toBe(true);
      expect(health.detail).toContain('protocol check passed');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('fails closed when status output is invalid or the CLI is unavailable', async () => {
    const invalid = new OwnHowCliGovernance('/path/that/does/not/exist');
    await expect(invalid.health!()).resolves.toMatchObject({ ready: false });
    const directory = await mkdtemp(join(tmpdir(), 'aeeis-ownhow-invalid-'));
    const executable = join(directory, 'ownhow-invalid.mjs');
    await writeFile(executable, '#!/usr/bin/env node\nprocess.stdout.write("not-json");\n');
    await chmod(executable, 0o755);
    try { await expect(new OwnHowCliGovernance(executable).health!()).resolves.toMatchObject({ ready: false }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.skipIf(!ownhowAvailable)('maps an empty proposal queue and real receipts', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'aeeis-ownhow-'));
    try {
      const governance = new OwnHowCliGovernance('ownhow', stateDirectory, 'codex');
      await expect(governance.propose()).resolves.toEqual([]);
      const receipt = await governance.record({ task: 'aeeis ownhow adapter smoke', outcome: 'success', summary: 'adapter verified', evidence: ['local cli'], runtime: 'codex' });
      expect(receipt.receiptRef).toMatch(/^receipt-/);
      const resolved = await governance.resolve('aeeis ownhow adapter smoke', { runtime: 'codex' });
      expect(resolved.plan).toBeDefined();
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
