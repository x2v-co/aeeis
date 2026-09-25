#!/usr/bin/env node
/**
 * Live Planprice v1 smoke. This exercises the formal Bearer-authenticated
 * catalog adapter and emits only non-secret routing evidence.
 */
import process from 'node:process';

const planpriceUrl = process.env.AEEIS_PLANPRICE_URL;
const token = process.env.AEEIS_PLANPRICE_BEARER_TOKEN;
const mappingsJson = process.env.AEEIS_PLANPRICE_MAPPINGS;
if (!planpriceUrl || !token || !mappingsJson) throw new Error('AEEIS_PLANPRICE_URL, AEEIS_PLANPRICE_BEARER_TOKEN and AEEIS_PLANPRICE_MAPPINGS are required');
let mappings;
try { mappings = JSON.parse(mappingsJson); } catch { throw new Error('AEEIS_PLANPRICE_MAPPINGS must be valid JSON'); }
if (!Array.isArray(mappings) || mappings.length === 0) throw new Error('AEEIS_PLANPRICE_MAPPINGS must be a non-empty JSON array');

const { PlanpriceV1Catalog } = await import('../dist/planprice-v1-adapter.js');
const { CatalogModelResolver, HttpCatalogModelFactory } = await import('../dist/runtime/model-router.js');
const catalog = new PlanpriceV1Catalog(planpriceUrl, {
  token,
  mappings,
  ...(process.env.AEEIS_PLANPRICE_HEALTH_URL ? { healthUrl: process.env.AEEIS_PLANPRICE_HEALTH_URL } : {}),
});
const health = await catalog.health();
if (!health.ready) throw new Error(`Planprice v1 ready probe failed: ${health.detail}`);
const providerKeys = process.env.AEEIS_MODEL_PROVIDER_KEYS ? JSON.parse(process.env.AEEIS_MODEL_PROVIDER_KEYS) : {};
const providerHealth = process.env.AEEIS_MODEL_PROVIDER_HEALTH_URLS ? JSON.parse(process.env.AEEIS_MODEL_PROVIDER_HEALTH_URLS) : {};
const resolver = new CatalogModelResolver(catalog, new HttpCatalogModelFactory(providerKeys, providerHealth, false, mappings));
const resolution = await resolver.resolve({ capability: 'agent', privacy: process.env.AEEIS_PLANPRICE_SMOKE_PRIVACY ?? 'internal' });
const pin = resolution.adapter.pin;
if (pin.schemaVersion !== 'aeeis-model-pin/1' || pin.routingMode !== 'catalog' || !pin.offeringId || !pin.catalogVersion || !pin.catalogDigest || !pin.catalogHash || !pin.mappingVersion || !pin.pricingSnapshot) throw new Error('Formal catalog Model Pin is incomplete');
const modelHealth = await resolver.health();
if (!modelHealth.ready) throw new Error(`Selected provider health failed: ${modelHealth.detail}`);

console.log(JSON.stringify({
  schemaVersion: 'aeeis.planprice-v1-live-smoke.v1',
  planpriceUrl,
  catalogHealth: health,
  modelHealth,
  selected: { provider: pin.provider, model: pin.model, offeringId: pin.offeringId, catalogVersion: pin.catalogVersion, catalogDigest: pin.catalogDigest, catalogHash: pin.catalogHash, mappingVersion: pin.mappingVersion, endpointConfigured: Boolean(pin.endpointRef) },
}, null, 2));
