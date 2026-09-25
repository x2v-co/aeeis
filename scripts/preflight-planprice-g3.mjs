#!/usr/bin/env node
import process from 'node:process';
import { createHash } from 'node:crypto';

const required = ['AEEIS_PLANPRICE_URL', 'AEEIS_PLANPRICE_BEARER_TOKEN', 'AEEIS_PLANPRICE_MAPPINGS'];
const failures = [];
for (const name of required) if (!process.env[name]?.trim()) failures.push(`${name} is required`);
let base;
try { base = new URL(process.env.AEEIS_PLANPRICE_URL); if (base.protocol !== 'https:') failures.push('AEEIS_PLANPRICE_URL must use HTTPS'); } catch { failures.push('AEEIS_PLANPRICE_URL must be a valid URL'); }
let mappings;
try { mappings = JSON.parse(process.env.AEEIS_PLANPRICE_MAPPINGS ?? 'null'); if (!Array.isArray(mappings) || mappings.length === 0) throw new Error(); } catch { failures.push('AEEIS_PLANPRICE_MAPPINGS must be a non-empty JSON array'); }
if (Array.isArray(mappings)) for (const [i, m] of mappings.entries()) {
  for (const k of ['offeringId', 'providerId', 'channelId', 'endpointRef', 'requestModel']) if (typeof m?.[k] !== 'string' || !m[k]) failures.push(`mapping[${i}].${k} is required`);
  if (m?.mappingVersion !== undefined && (typeof m.mappingVersion !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._~-]{0,119}$/.test(m.mappingVersion))) failures.push(`mapping[${i}].mappingVersion must be URL-safe when provided`);
  try { const u = new URL(m.endpointRef); if (u.protocol !== 'https:') failures.push(`mapping[${i}].endpointRef must use HTTPS`); } catch { failures.push(`mapping[${i}].endpointRef must be a URL`); }
}
async function get(path, headers = {}) {
  if (!base) return undefined;
  try { const r = await fetch(new URL(path, base), { redirect: 'error', headers, signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json().catch(() => null), headers: Object.fromEntries(r.headers) }; }
  catch (e) { failures.push(`${path} request failed: ${e instanceof Error ? e.message : 'unknown'}`); return undefined; }
}
const headers = process.env.AEEIS_PLANPRICE_BEARER_TOKEN ? { authorization: `Bearer ${process.env.AEEIS_PLANPRICE_BEARER_TOKEN}`, accept: 'application/json' } : {};
const health = await get('/v1/health/ready', headers);
if (health && (health.status !== 200 || health.body?.status !== 'ready')) failures.push(`ready health failed with HTTP ${health.status}`);
const catalog = await get('/v1/catalog/models', headers);
if (catalog && catalog.status !== 200) failures.push(`catalog failed with HTTP ${catalog.status}`);
if (catalog?.body?.digest && Array.isArray(catalog.body.offerings)) {
  const { digest, ...payload } = catalog.body;
  const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  const expected = `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
  if (digest !== expected) failures.push('catalog digest mismatch');
}
const result = { schemaVersion: 'aeeis.planprice.g3-preflight.v1', checkedAt: new Date().toISOString(), checks: { configuration: failures.length === 0, ready: health?.status === 200 && health?.body?.status === 'ready', catalog: catalog?.status === 200 }, status: failures.length ? 'failed' : 'passed', ...(failures.length ? { failures } : {}) };
console.log(JSON.stringify(result, null, 2));
process.exitCode = failures.length ? 1 : 0;
