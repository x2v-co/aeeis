import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debugBundle } from '../src/runtime/run-debug.js';
// The shipped CLI is JavaScript and deliberately runs without a build step.
import { exportRunFromDb } from '../scripts/fetch-run.mjs';

describe('fetch-run --from-db', () => {
  it('exports a redacted debug bundle from the stored run state without HTTP or a token', async () => {
    const id = 'run_00000000-0000-0000-0000-000000000001';
    const state = { id, secret: 'Bearer abc' };
    const bundle = (run: { id: string }) => ({ schemaVersion: 'aeeis-debug-bundle/2', id: run.id, redacted: true });
    const cwd = process.cwd(); const out = await mkdtemp(join(tmpdir(), 'aeeis-fromdb-out-'));
    process.chdir(out);
    try {
      const file = await exportRunFromDb(id, {}, { query: async (runId: string) => runId === id ? state : undefined, debugBundle: bundle });
      expect(file).toBe(`run-${id}.debug.json`);
      expect(JSON.parse(await readFile(join(out, file), 'utf8'))).toEqual(bundle(state));
      expect((await stat(join(out, file))).mode & 0o777).toBe(0o600);
    } finally { process.chdir(cwd); }
  });
  it('rejects malformed IDs, unknown runs and a missing DATABASE_URL', async () => {
    await expect(exportRunFromDb('../etc/passwd', {}, { query: async () => undefined, debugBundle })).rejects.toThrow('Usage');
    await expect(exportRunFromDb('run_00000000-0000-0000-0000-000000000009', {}, { query: async () => undefined, debugBundle })).rejects.toThrow('Unknown run');
    await expect(exportRunFromDb('run_00000000-0000-0000-0000-000000000009', {}, { debugBundle })).rejects.toThrow('DATABASE_URL');
  });
});
