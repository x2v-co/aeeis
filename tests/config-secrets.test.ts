import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFileEnvironment } from '../src/config-secrets.js';

describe('file-backed deployment configuration', () => {
  it('loads AEEIS and database values while removing one trailing newline', () => {
    const root = mkdtempSync(join(tmpdir(), 'aeeis-secrets-'));
    const tokenFile = join(root, 'token');
    const databaseFile = join(root, 'database');
    writeFileSync(tokenFile, 'secret-token\n');
    writeFileSync(databaseFile, 'postgresql://aeeis@db/aeeis\r\n');
    const env: NodeJS.ProcessEnv = { AEEIS_ACCESS_TOKEN_FILE: tokenFile, DATABASE_URL_FILE: databaseFile };
    loadFileEnvironment(env);
    expect(env.AEEIS_ACCESS_TOKEN).toBe('secret-token');
    expect(env.DATABASE_URL).toBe('postgresql://aeeis@db/aeeis');
    expect(env.AEEIS_ACCESS_TOKEN_FILE).toBe(tokenFile);
  });

  it('fails closed on conflicts, missing files, directories, empty values, and NUL bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'aeeis-secrets-'));
    const emptyFile = join(root, 'empty');
    const nulFile = join(root, 'nul');
    writeFileSync(emptyFile, '\n');
    writeFileSync(nulFile, 'bad\0value');
    expect(() => loadFileEnvironment({ AEEIS_ACCESS_TOKEN: 'direct', AEEIS_ACCESS_TOKEN_FILE: emptyFile })).toThrow(/cannot both/);
    expect(() => loadFileEnvironment({ AEEIS_ACCESS_TOKEN_FILE: join(root, 'missing') })).toThrow(/unreadable/);
    expect(() => loadFileEnvironment({ AEEIS_ACCESS_TOKEN_FILE: root })).toThrow(/regular file/);
    expect(() => loadFileEnvironment({ AEEIS_ACCESS_TOKEN_FILE: emptyFile })).toThrow(/non-empty/);
    expect(() => loadFileEnvironment({ AEEIS_ACCESS_TOKEN_FILE: nulFile })).toThrow(/NUL/);
  });

  it('ignores unrelated *_FILE variables so generic process settings stay untouched', () => {
    const env: NodeJS.ProcessEnv = { PATH_FILE: '/does/not/exist', OTHER_FILE: '/does/not/exist' };
    expect(() => loadFileEnvironment(env)).not.toThrow();
    expect(env.PATH).toBeUndefined();
  });
});
