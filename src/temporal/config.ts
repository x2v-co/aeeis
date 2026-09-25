import { parseTemporalVersioningConfig, type TemporalVersioningConfig } from './versioning.js';

export interface TemporalWorkerConfig {
  token: string;
  api: string;
  taskQueue: string;
  namespace: string;
  versioning: TemporalVersioningConfig;
  healthHost: string;
  healthPort: number;
  shutdownGraceTime: number;
  shutdownForceTime: number;
  address: string;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function boundedName(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = (env[name] ?? fallback).trim();
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f\s]/.test(value)) throw new Error(`${name} must be a non-empty value without whitespace or control characters`);
  return value;
}

function workerApiUrl(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('AEEIS_INTERNAL_URL must be a valid URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('AEEIS_INTERNAL_URL must not contain credentials, query or fragment');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (allowInsecureHttp || loopback))) {
    throw new Error('AEEIS_INTERNAL_URL must use HTTPS except loopback or explicit development override');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Parse Worker-only configuration before connecting to Temporal. The API
 * process has a separate deployment validator; keeping this boundary local
 * prevents a malformed Worker from polling or exposing a misleading readyz. */
export function parseTemporalWorkerConfig(env: NodeJS.ProcessEnv = process.env): TemporalWorkerConfig {
  const production = env.AEEIS_ENV === 'production' || (env.AEEIS_ENV === undefined && env.NODE_ENV === 'production');
  const token = env.AEEIS_WORKER_TOKEN?.trim();
  if (!token || token.length < 16 || token.length > 10_000) throw new Error('AEEIS_WORKER_TOKEN must contain 16-10000 characters');
  if (production && !env.AEEIS_INTERNAL_URL?.trim()) throw new Error('Production Temporal Worker requires AEEIS_INTERNAL_URL');
  if (production && env.AEEIS_WORKER_ALLOW_INSECURE_HTTP === '1') throw new Error('Production Temporal Worker cannot enable insecure HTTP');
  if (env.AEEIS_WORKER_ALLOW_INSECURE_HTTP !== undefined && !['0', '1'].includes(env.AEEIS_WORKER_ALLOW_INSECURE_HTTP)) throw new Error('AEEIS_WORKER_ALLOW_INSECURE_HTTP must be 0 or 1');
  const api = workerApiUrl(env.AEEIS_INTERNAL_URL?.trim() || 'http://127.0.0.1:4323', env.AEEIS_WORKER_ALLOW_INSECURE_HTTP === '1');
  const taskQueue = boundedName(env, 'AEEIS_TASK_QUEUE', 'aeeis-agent');
  const namespace = boundedName(env, 'TEMPORAL_NAMESPACE', 'default');
  const healthHost = (env.AEEIS_WORKER_HEALTH_HOST ?? '127.0.0.1').trim();
  if (!healthHost || healthHost.length > 253 || /[\u0000-\u001f\u007f]/.test(healthHost)) throw new Error('AEEIS_WORKER_HEALTH_HOST must be a valid host name');
  const healthPort = integer(env, 'AEEIS_WORKER_HEALTH_PORT', 4324, 0, 65_535);
  const shutdownGraceTime = integer(env, 'AEEIS_WORKER_SHUTDOWN_GRACE_MS', 30_000, 1, 86_400_000);
  const shutdownForceTime = integer(env, 'AEEIS_WORKER_SHUTDOWN_FORCE_MS', 60_000, 1, 86_400_000);
  if (shutdownForceTime < shutdownGraceTime) throw new Error('AEEIS_WORKER_SHUTDOWN_FORCE_MS must be at least AEEIS_WORKER_SHUTDOWN_GRACE_MS');
  const rawAddress = env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  if (!rawAddress || rawAddress.length > 500 || /[\u0000-\u001f\u007f\s]/.test(rawAddress)) throw new Error('TEMPORAL_ADDRESS must be a non-empty host:port value');
  const address = rawAddress;
  if (production && env.AEEIS_TEMPORAL_USE_VERSIONING !== '1') throw new Error('Production Temporal Worker requires AEEIS_TEMPORAL_USE_VERSIONING=1');
  const defaultBuildId = `aeeis-worker-${env.npm_package_version ?? '0.1.0'}`;
  const versioning = parseTemporalVersioningConfig(env, defaultBuildId);
  return { token, api, taskQueue, namespace, versioning, healthHost, healthPort, shutdownGraceTime, shutdownForceTime, address };
}
