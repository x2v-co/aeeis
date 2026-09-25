import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../monitoring', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'aeeis-prometheus-'));
const dockerTimeoutMs = Number(process.env.AEEIS_DOCKER_COMMAND_TIMEOUT_MS ?? 15_000);
if (!Number.isSafeInteger(dockerTimeoutMs) || dockerTimeoutMs <= 0) throw new Error('AEEIS_DOCKER_COMMAND_TIMEOUT_MS must be a positive integer');
function docker(args, options = {}) {
  const result = spawnSync('docker', args, { stdio: 'inherit', timeout: dockerTimeoutMs, killSignal: 'SIGTERM', ...options });
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`Docker validation timed out after ${dockerTimeoutMs}ms: docker ${args.join(' ')}`);
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Docker validation timed out after ${dockerTimeoutMs}ms: docker ${args.join(' ')}`);
  if (result.status !== 0) throw new Error(`Docker validation failed (exit ${result.status})`);
  return result.stdout;
}
try {
  // Real readable files for promtool's filesystem checks, never deployment credentials.
  const fixture = join(temporary, 'monitoring');
  cpSync(directory, fixture, { recursive: true });
  mkdirSync(join(fixture, 'secrets'));
  mkdirSync(join(fixture, 'tls'));
  const token = join(fixture, 'secrets', 'aeeis-metrics.token');
  const ca = join(fixture, 'tls', 'aeeis-ca.crt');
  writeFileSync(token, 'promtool-test-token\n');
  writeFileSync(ca, rootCertificates[0]);
  for (const args of [
    ['check', 'config', '/etc/prometheus/prometheus.yml'],
    ['check', 'config', '/etc/prometheus/prometheus.production.yml'],
    ['test', 'rules', '/etc/prometheus/alerts.test.yml'],
  ]) {
    docker(['run', '--rm', '--entrypoint', '/bin/promtool',
      '--mount', `type=bind,src=${fixture},dst=/etc/prometheus,readonly`,
      '--workdir', '/etc/prometheus', 'prom/prometheus:v3.5.0', ...args]);
  }
  const env = { ...process.env,
    AEEIS_PROMETHEUS_CONFIG_FILE: join(fixture, 'prometheus.production.yml'),
    AEEIS_METRICS_TOKEN_FILE: token, AEEIS_METRICS_CA_FILE: ca,
  };
  const config = JSON.parse(docker(['compose', '-f', join(directory, 'compose.production.yml'), 'config', '--format', 'json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  const service = config.services.prometheus;
  assert.equal(service.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.secrets['metrics-token'].file, token);
  assert.equal(config.secrets['metrics-ca'].file, ca);
  assert(service.secrets.some(secret => secret.source === 'metrics-token' && secret.target === '/etc/prometheus/secrets/aeeis-metrics.token'));
  assert(service.secrets.some(secret => secret.source === 'metrics-ca' && secret.target === '/etc/prometheus/tls/aeeis-ca.crt'));
  assert(service.volumes.some(volume => volume.source === env.AEEIS_PROMETHEUS_CONFIG_FILE && volume.read_only));
  const missing = { ...env }; delete missing.AEEIS_METRICS_TOKEN_FILE;
  const rejected = spawnSync('docker', ['compose', '-f', join(directory, 'compose.production.yml'), 'config', '--quiet'], { env: missing, encoding: 'utf8', timeout: dockerTimeoutMs, killSignal: 'SIGTERM' });
  if (rejected.error?.code === 'ETIMEDOUT') throw new Error(`Docker validation timed out after ${dockerTimeoutMs}ms while checking missing-secret rejection`);
  if (rejected.error) throw rejected.error;
  if (rejected.signal) throw new Error(`Docker validation timed out after ${dockerTimeoutMs}ms while checking missing-secret rejection`);
  assert.notEqual(rejected.status, 0, 'Production monitoring must require an explicit token file');
  console.log('Production monitoring secret mounts and missing-secret rejection passed.');
} finally { rmSync(temporary, { recursive: true, force: true }); }
