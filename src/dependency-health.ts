import { open } from 'node:fs/promises';

export interface DependencyHealth { ready: boolean; detail: string; checkedAt?: string }

/** Credentials stay on the connector's configured origin, including on redirects. */
export function validateHealthEndpoint(endpoint: string, healthEndpoint: string): void {
  const url = new URL(healthEndpoint);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Health endpoint must use HTTPS except loopback');
  if (url.username || url.password || url.search || url.hash) throw new Error('Health endpoint must not contain credentials, query or fragment');
  if (url.origin !== new URL(endpoint).origin) throw new Error('Health endpoint must share the connector origin');
}

/** Never searches, advances cursors, invokes models, or returns provider bodies. */
export class HttpDependencyProbe {
  constructor(endpoint: string, private readonly healthEndpoint?: string, private readonly token?: string, private readonly timeoutMs = 3_000) {
    if (healthEndpoint !== undefined) validateHealthEndpoint(endpoint, healthEndpoint);
  }
  async health(): Promise<DependencyHealth> {
    const checkedAt = new Date().toISOString();
    if (!this.healthEndpoint) return { ready: false, detail: 'health probe unavailable; configure a read-only health endpoint', checkedAt };
    try {
      const response = await fetch(this.healthEndpoint, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
      });
      await response.body?.cancel();
      return { ready: response.ok, detail: response.ok ? 'provider health endpoint reachable' : `provider health endpoint returned HTTP ${response.status}`, checkedAt };
    } catch {
      return { ready: false, detail: 'provider health endpoint unreachable or timed out', checkedAt };
    }
  }
}

export async function readableFileHealth(path: string): Promise<DependencyHealth> {
  const file = await open(path, 'r');
  try {
    if (!(await file.stat()).isFile()) return { ready: false, detail: 'source path is not a regular file' };
    return { ready: true, detail: 'source file readable; content validated on use' };
  } finally { await file.close(); }
}
