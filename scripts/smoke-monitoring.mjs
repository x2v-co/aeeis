const base = process.env.AEEIS_PROMETHEUS_URL ?? 'http://127.0.0.1:9090';
const timeoutMs = Number(process.env.AEEIS_SMOKE_TIMEOUT_MS ?? 90_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid smoke timeout');
const deadline = Date.now() + timeoutMs;
async function api(path) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Prometheus returned ${response.status}`);
  const body = await response.json();
  if (body.status !== 'success') throw new Error('Prometheus API failed');
  return body.data;
}
let lastError;
while (Date.now() < deadline) {
  try {
    const targets = await api('/api/v1/targets');
    const aeeis = targets.activeTargets.filter(target => target.labels.job === 'aeeis');
    if (!aeeis.length || aeeis.some(target => target.health !== 'up')) throw new Error('AEEIS scrape is not healthy');
    const rules = await api('/api/v1/rules');
    const group = rules.groups.find(group => group.name === 'aeeis-runtime');
    if (!group || group.rules.length !== 9 || group.rules.some(rule => rule.health !== 'ok')) throw new Error('AEEIS alert rules are missing or unhealthy');
    const query = await api(`/api/v1/query?query=${encodeURIComponent('aeeis_http_requests_in_flight{job="aeeis"}')}`);
    if (!query.result.length || query.result.some(result => !Number.isFinite(Number(result.value[1])))) throw new Error('HTTP metrics have not been scraped from the current AEEIS build');
    const readiness = await api(`/api/v1/query?query=${encodeURIComponent('aeeis_readiness{job="aeeis"}')}`);
    if (!readiness.result.length || readiness.result.some(result => !['0', '1'].includes(result.value[1]))) throw new Error('Readiness metrics have not been scraped from the current AEEIS build');
    const collectors = await api(`/api/v1/query?query=${encodeURIComponent('aeeis_metrics_collection_success{job="aeeis"}')}`);
    if (!collectors.result.length || collectors.result.some(result => result.value[1] !== '1')) throw new Error('AEEIS durable metrics collectors are not healthy');
    console.log(JSON.stringify({ status: 'passed', healthyTargets: aeeis.length, healthyRules: group.rules.length, httpMetrics: true, readinessMetrics: true, metricsCollectors: collectors.result.length }));
    process.exit(0);
  } catch (error) { lastError = error; }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
throw new Error(`Monitoring smoke timed out: ${lastError?.message}`);
