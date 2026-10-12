/** The HTTP exception is limited to the two internal API/Worker endpoints.
 * Never use this validator for model providers or other external adapters. */
export function validateInternalEndpoint(
  raw: string | undefined,
  label: 'AEEIS_INTERNAL_URL' | 'AEEIS_TEMPORAL_WORKER_HEALTH_URL',
  env: NodeJS.ProcessEnv = process.env,
  allowInsecureHttp = false,
): URL | undefined {
  const configured = env.AEEIS_TRUSTED_INTERNAL_HOSTS;
  const hosts = configured?.trim() ? configured.split(',').map(host => host.trim()) : [];
  if (hosts.some(host => {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(host) || /^\d+$/.test(host)) return true;
    try { return new URL(`http://${host}`).hostname !== host; } catch { return true; }
  })) {
    // Numeric single labels can be interpreted as IPv4 addresses by URL.
    throw new Error('AEEIS_TRUSTED_INTERNAL_HOSTS must contain only comma-separated single-label Docker service names (no dots, wildcards or IP addresses)');
  }
  if (!raw?.trim()) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid URL`); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, query or fragment`);
  }
  const production = (env.AEEIS_ENV ?? env.NODE_ENV) === 'production';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const trusted = hosts.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || trusted || (!production && allowInsecureHttp)))) {
    throw new Error(`${label} must use HTTPS except loopback or AEEIS_TRUSTED_INTERNAL_HOSTS`);
  }
  return url;
}
