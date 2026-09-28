import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const loader = fileURLToPath(new URL('../scripts/load-local-env.mjs', import.meta.url));
const roots: string[] = [];
function run(contents?: string, overrides: NodeJS.ProcessEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'aeeis-local-env-'));
  roots.push(cwd);
  if (contents !== undefined) writeFileSync(join(cwd, '.env'), contents);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('AEEIS_') && !name.startsWith('TEMPORAL_') && !['DATABASE_URL', 'DATABASE_URL_FILE', 'PORT', 'NODE_OPTIONS'].includes(name)));
  return JSON.parse(execFileSync(process.execPath, ['--import', loader, '-e',
    `console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('AEEIS_') || name === 'PORT' || name === 'NODE_OPTIONS'))))`,
  ], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' }));
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('development .env preload', () => {
  it('loads quoted model settings without exporting empty template entries or executing shell code', () => {
    expect(run(`AEEIS_MODEL=ark-code-latest\nAEEIS_MODEL_API_KEY='test-$VALUE-$(false)'\nAEEIS_MODEL_PROVIDER_ENDPOINTS='{"provider":"https://example.com/v1"}'\nAEEIS_AGENT_CARDS=\nAEEIS_KNOWLEDGE_FILE=\nPORT=4323\nNODE_OPTIONS=--invalid-option`)).toEqual({
      AEEIS_MODEL: 'ark-code-latest', AEEIS_MODEL_API_KEY: 'test-$VALUE-$(false)',
      AEEIS_MODEL_PROVIDER_ENDPOINTS: '{"provider":"https://example.com/v1"}', PORT: '4323',
    });
  });
  it('preserves explicit process settings, including empty values that require validation', () => {
    expect(run('AEEIS_MODEL=file-model\nAEEIS_MODEL_API_KEY=file-key', { AEEIS_MODEL: 'process-model', AEEIS_MODEL_API_KEY: '' })).toEqual({ AEEIS_MODEL: 'process-model', AEEIS_MODEL_API_KEY: '' });
  });
  it('allows development startup without a .env file', () => {
    expect(run(undefined, { AEEIS_MODEL: 'process-model' })).toEqual({ AEEIS_MODEL: 'process-model' });
  });
  it('keeps demo processes isolated from local deployment credentials and integrations', () => {
    expect(run('AEEIS_MODEL_API_KEY=deployment-key\nDATABASE_URL=postgres://deployment\nAEEIS_AGENT_CARDS=invalid', { AEEIS_DEMO_MODE: '1' })).toEqual({ AEEIS_DEMO_MODE: '1' });
  });
});
