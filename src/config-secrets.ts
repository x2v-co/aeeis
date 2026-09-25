import { readFileSync, statSync } from 'node:fs';

const allowedTarget = (name: string): boolean => name === 'DATABASE_URL' || name.startsWith('AEEIS_') || name.startsWith('TEMPORAL_');

/**
 * Load deployment secrets from files before startup validation runs.
 *
 * Only AEEIS/TEMPORAL settings and DATABASE_URL support the *_FILE form. A
 * direct value and a file value are rejected together so a stale environment
 * variable cannot silently win over a rotated secret mount.
 */
export function loadFileEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  for (const [fileName, rawPath] of Object.entries(env)) {
    if (!fileName.endsWith('_FILE')) continue;
    const target = fileName.slice(0, -'_FILE'.length);
    if (!allowedTarget(target)) continue;
    const path = rawPath?.trim();
    if (!path) throw new Error(`${fileName} must contain a non-empty file path`);
    if (env[target] !== undefined) throw new Error(`${target} and ${fileName} cannot both be configured`);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new Error(`${fileName} points to an unreadable file`);
    }
    if (!stat.isFile()) throw new Error(`${fileName} must point to a regular file`);
    let value: string;
    try {
      value = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error(`${fileName} points to an unreadable file`);
    }
    if (!value.trim() || /[\u0000]/.test(value)) throw new Error(`${fileName} must contain a non-empty value without NUL bytes`);
    env[target] = value;
  }
}
