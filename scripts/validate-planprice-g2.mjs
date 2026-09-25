#!/usr/bin/env node

/**
 * Dependency-free G2 contract smoke check.
 * Full JSON Schema/OpenAPI validation is part of the G2 attachment contract;
 * this check verifies the checked-in draft fixtures, digest vector and the
 * cross-field invariants that JSON Schema alone cannot express.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import canonicalize from 'canonicalize';
import { parse as parseYaml } from 'yaml';
import { candidateSetHash, catalogDigest, catalogSemantics, conditionsSemantics, fxSemantics, healthSemantics, moneyBudgetDecision, offeringHash, pinSemantics, pricingSemantics, usdUnitPrice } from './planprice-g2-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'integrations', 'planprice-g2');
const readJson = async relative => JSON.parse(await readFile(join(root, relative), 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256File = async relative => createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
async function walkFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walkFiles(join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

const schemaFiles = [
  'schemas/catalog-1.schema.json', 'schemas/offering-1.schema.json', 'schemas/pricing-1.schema.json',
  'schemas/fx-1.schema.json', 'schemas/health-1.schema.json', 'schemas/error-1.schema.json',
  'schemas/aeeis-model-pin-1.schema.json', 'schemas/mapping-1.schema.json',
];
for (const file of schemaFiles) {
  const schema = await readJson(file);
  assert(schema.$schema === 'https://json-schema.org/draft/2020-12/schema', `${file}: wrong JSON Schema dialect`);
  assert(typeof schema.$id === 'string' && schema.$id.includes('/planprice/1/'), `${file}: missing versioned $id`);
}

const catalog = await readJson('fixtures/catalog-1/catalog.json');
assert(catalog.schemaVersion === 'planprice-catalog/1', 'catalog: schemaVersion');
assert(catalog.baseCurrency === 'USD' && catalog.offerings.length === 1, 'catalog: full snapshot fixture');
assert(catalog.digest === catalogDigest(catalog), 'catalog: digest mismatch');
const offering = catalog.offerings[0];
assert(offering.versionStatus === 'pinned' && typeof offering.modelVersion === 'string', 'offering: pinned version invariant');
assert(offering.pricing.currency === 'CNY', 'offering: source currency');
assert(offering.pricing.normalization.fx.direction === 'quote_per_base', 'pricing: FX direction');
assert(offering.pricing.normalization.componentPrices.input === '0.13888889', 'pricing: normalized input vector');
assert(offering.pricing.normalization.componentPrices.output === '0.27777778', 'pricing: normalized output vector');

const mapping = await readJson('fixtures/catalog-1/mapping.json');
assert(mapping.mappings[0].requestModel !== offering.modelId, 'mapping: requestModel must not silently equal modelId');
const pin = await readJson('fixtures/catalog-1/model-pin.json');
assert(pin.routingMode === 'catalog' && pin.requestModel === mapping.mappings[0].requestModel, 'pin: mapping identity');
assert(pin.catalogDigest === catalog.digest && pin.catalogHash === candidateSetHash([offering]), 'pin: independent catalog evidence hashes');
const secondCandidate = structuredClone(offering);
secondCandidate.offeringId = 'off_example_002';
secondCandidate.pricingVariantId = 'price_example_002';
const candidateSet = [offering, secondCandidate];
assert(candidateSetHash(candidateSet) === candidateSetHash([...candidateSet].reverse()), 'candidate set hash must be order independent');
const changedCandidate = structuredClone(secondCandidate);
changedCandidate.providerId = 'prv_changed';
assert(candidateSetHash(candidateSet) !== candidateSetHash([offering, changedCandidate]), 'candidate set hash must include unselected candidate changes');

const fx = await readJson('vectors/fx-1.json');
const cny = fx.cases.find(item => item.id === 'cny-standard');
assert(usdUnitPrice(cny.sourceInputPerMillion, cny.rate) === cny.expectedInputUsd && usdUnitPrice(cny.sourceOutputPerMillion, cny.rate) === cny.expectedOutputUsd, 'fx vector: CNY conversion');
const identity = fx.cases.find(item => item.id === 'usd-identity');
assert(usdUnitPrice(identity.sourceInputPerMillion, identity.rate) === identity.expectedInputUsd && usdUnitPrice(identity.sourceOutputPerMillion, identity.rate) === identity.expectedOutputUsd, 'fx vector: USD identity');
const missing = fx.cases.find(item => item.id === 'missing-output');
assert(usdUnitPrice(missing.sourceInputPerMillion, missing.rate) === missing.expectedInputUsd && usdUnitPrice(missing.sourceOutputPerMillion, missing.rate) === missing.expectedOutputUsd, 'fx vector: partial price conversion');
assert(missing.budgetDecision === 'reject_money_budget' && missing.expectedOutputUsd === null, 'fx vector: partial price rejection');
const partialPriceCatalog = structuredClone(catalog);
partialPriceCatalog.offerings[0].pricing.components[1].priceStatus = 'unknown';
partialPriceCatalog.offerings[0].pricing.components[1].pricePerMillion = null;
partialPriceCatalog.offerings[0].pricing.normalization.status = 'unavailable';
partialPriceCatalog.offerings[0].pricing.normalization.componentPrices.output = null;
assert(moneyBudgetDecision(partialPriceCatalog, partialPriceCatalog.offerings[0], '2026-09-23T00:01:00Z') === 'reject_money_budget', 'fx vector: partial price budget rejection');
for (const id of ['half-even-zero', 'half-even-odd-up']) {
  const tie = fx.cases.find(item => item.id === id);
  assert(usdUnitPrice(tie.sourceInputPerMillion, tie.rate) === tie.expectedInputUsd && usdUnitPrice(tie.sourceOutputPerMillion, tie.rate) === tie.expectedOutputUsd, `fx vector: ${id}`);
}

const digestVector = await readJson('vectors/digest-1.json');
assert(digestVector.canonicalJson === canonicalize(digestVector.payload), 'digest vector: canonical JSON mismatch');
assert(digestVector.digest === `sha256:${createHash('sha256').update(digestVector.canonicalJson, 'utf8').digest('hex')}`, 'digest vector: SHA-256 mismatch');

const health = await readJson('fixtures/catalog-1/health-ready.json');
assert(health.schemaVersion === 'planprice-health/1' && health.status === 'ready', 'health fixture');
const healthExpired = await readJson('fixtures/catalog-1/health-expired.json');
assert(healthExpired.status === 'not_ready' && healthExpired.reason === 'catalog_expired', 'health expired fixture');
const error = await readJson('fixtures/catalog-1/error-catalog-unavailable.json');
assert(error.schemaVersion === 'planprice-error/1' && error.code === 'catalog_unavailable' && error.retryable === true, 'error fixture');
const unauthorized = await readJson('fixtures/catalog-1/error-unauthorized.json');
assert(unauthorized.code === 'unauthorized' && unauthorized.retryable === false, 'unauthorized fixture');
const rolling = await readJson('fixtures/catalog-1/catalog-rolling.json');
assert(rolling.offerings[0].versionStatus === 'rolling' && rolling.offerings[0].modelVersion === null && rolling.digest === catalogDigest(rolling), 'rolling/null fixture');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const file of schemaFiles) ajv.addSchema(await readJson(file));
for (const [schemaId, fixture] of [
  ['https://contracts.aeeis.dev/planprice/1/schemas/catalog-1.schema.json', catalog],
  ['https://contracts.aeeis.dev/planprice/1/schemas/catalog-1.schema.json', rolling],
  ['https://contracts.aeeis.dev/planprice/1/schemas/mapping-1.schema.json', mapping],
  ['https://contracts.aeeis.dev/planprice/1/schemas/aeeis-model-pin-1.schema.json', pin],
  ['https://contracts.aeeis.dev/planprice/1/schemas/health-1.schema.json', health],
  ['https://contracts.aeeis.dev/planprice/1/schemas/health-1.schema.json', healthExpired],
  ['https://contracts.aeeis.dev/planprice/1/schemas/error-1.schema.json', error],
  ['https://contracts.aeeis.dev/planprice/1/schemas/error-1.schema.json', unauthorized],
]) {
  const validator = ajv.getSchema(schemaId);
  const valid = validator?.(fixture);
  assert(valid, `${schemaId}: ${validator?.errors?.map(item => `${item.instancePath} ${item.message}`).join('; ') ?? 'invalid'}`);
}
const conditionValidator = ajv.getSchema('https://contracts.aeeis.dev/planprice/1/schemas/pricing-1.schema.json#/$defs/conditions');
assert(conditionValidator, 'pricing conditions schema missing');
const conditionFixtures = await readJson('fixtures/catalog-1/conditions-valid.json');
for (const condition of conditionFixtures.conditions) {
  assert(conditionValidator(condition), `valid condition rejected: ${JSON.stringify(condition)}`);
  conditionsSemantics(condition, 'USD');
}
const invalidConditions = await readJson('fixtures/catalog-1/conditions-invalid.json');
for (const condition of invalidConditions.conditions) assert(!conditionValidator(condition), `invalid condition accepted: ${JSON.stringify(condition)}`);
const notModifiedHeaders = await readFile(join(root, 'fixtures/catalog-1/http-304-headers.txt'), 'utf8');
const headerLines = notModifiedHeaders.trimEnd().split('\n');
assert(headerLines[0] === 'HTTP/1.1 304 Not Modified', '304 fixture: status line');
const required304Headers = {
  'X-Request-Id': /^[-A-Za-z0-9_]{1,64}$/,
  'Cache-Control': /^private, no-cache, must-revalidate$/,
  ETag: /^W\/"sha256:[a-f0-9]{64}"$/,
  Vary: /^Authorization, Accept$/,
};
for (const [name, pattern] of Object.entries(required304Headers)) {
  const line = headerLines.find(value => value.startsWith(`${name}: `));
  assert(line && pattern.test(line.slice(name.length + 2)), `304 fixture: invalid ${name}`);
}
catalogSemantics(catalog);
const fxRoot = await readJson('fixtures/catalog-1/exchange-rates.json');
const fxValidator = ajv.getSchema('https://contracts.aeeis.dev/planprice/1/schemas/fx-1.schema.json');
assert(fxValidator?.(fxRoot), `fx root schema: ${fxValidator?.errors?.map(item => `${item.instancePath} ${item.message}`).join('; ') ?? 'invalid'}`);
fxSemantics(fxRoot);
healthSemantics(health);
pinSemantics(pin, catalog, mapping, 'https://provider.example/v1');
assert(moneyBudgetDecision(catalog, catalog.offerings[0], '2026-09-23T00:01:00Z') === 'allow_money_budget', 'money budget: standard fixture should allow');
assert(moneyBudgetDecision(catalog, catalog.offerings[0], '2026-09-23T00:06:00Z') === 'reject_money_budget', 'money budget: expired catalog should reject');

// The OpenAPI document is executable contract metadata: every declared local ref
// must resolve, every read-only path must declare all write-method 405 responses,
// and all application errors must keep a one-to-one HTTP status/code mapping.
const openApiPath = 'openapi/planprice-catalog-1.0.0.yaml';
const openApi = parseYaml(await readFile(join(root, openApiPath), 'utf8'), { maxAliasCount: 10000 });
const resolveRefs = (value, refs = []) => {
  if (!value || typeof value !== 'object') return refs;
  if (typeof value.$ref === 'string') refs.push(value.$ref);
  for (const child of Object.values(value)) resolveRefs(child, refs);
  return refs;
};
for (const ref of resolveRefs(openApi)) {
  if (!ref.startsWith('../')) continue;
  const target = ref.split('#')[0];
  const targetPath = join(root, 'openapi', target);
  await stat(targetPath);
}
const operationIds = new Set();
for (const [path, item] of Object.entries(openApi.paths ?? {})) {
  const templateNames = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]);
  const declaredPathParameters = [...(item.parameters ?? []), ...Object.values(item).filter(value => value && typeof value === 'object' && value.parameters).flatMap(value => value.parameters ?? [])]
    .filter(parameter => parameter?.in === 'path');
  for (const name of templateNames) {
    assert(declaredPathParameters.some(parameter => parameter.name === name && parameter.required === true), `OpenAPI ${path}: missing required path parameter ${name}`);
  }
  for (const operation of Object.values(item ?? {})) {
    if (!operation || typeof operation !== 'object' || !operation.operationId) continue;
    assert(!operationIds.has(operation.operationId), `OpenAPI duplicate operationId ${operation.operationId}`);
    operationIds.add(operation.operationId);
  }
}
const readOnlyPaths = ['/v1/catalog/models', '/v1/catalog/snapshots/{catalogVersion}', '/v1/exchange-rates', '/v1/health/live', '/v1/health/ready'];
for (const path of readOnlyPaths) {
  const item = openApi.paths?.[path];
  assert(item, `OpenAPI missing path ${path}`);
  for (const method of ['post', 'put', 'patch', 'delete']) {
    const operation = item[method];
    assert(operation?.responses?.['405'], `OpenAPI ${path} ${method}: missing 405`);
    const code = JSON.stringify(operation.responses['405']).includes('method_not_allowed');
    assert(code, `OpenAPI ${path} ${method}: 405 is not method_not_allowed`);
  }
}
const statusCodeSets = new Map();
for (const [path, item] of Object.entries(openApi.paths ?? {})) {
  for (const [method, operation] of Object.entries(item ?? {})) {
    if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      const match = JSON.stringify(response).match(/"const":\s*"([a-z_]+)"/);
      if (!match) continue;
      const code = match[1];
      if (!statusCodeSets.has(status)) statusCodeSets.set(status, new Set());
      statusCodeSets.get(status).add(code);
    }
  }
}
const expectedStatusCodes = {
  '400': ['invalid_query'], '401': ['unauthorized'], '403': ['forbidden'],
  '404': ['snapshot_not_found'], '405': ['method_not_allowed'], '406': ['not_acceptable'],
  '429': ['rate_limited'], '500': ['internal_error'], '502': ['upstream_unavailable'],
  '503': ['catalog_unavailable', 'not_ready'],
};
for (const [status, expected] of Object.entries(expectedStatusCodes)) {
  const actual = [...(statusCodeSets.get(status) ?? [])].sort();
  assert(actual.length && expected.every(code => actual.includes(code)), `OpenAPI status ${status}: incomplete error code mapping`);
}

// Manifest is a complete, reproducible attachment set. It excludes itself to
// avoid recursive hashing, and every listed hash must match the working tree.
const manifest = await readJson('release-manifest.json');
const listed = new Map(manifest.files.map(file => [file.path, file.sha256]));
const actualFiles = (await walkFiles(root)).filter(file => file !== 'release-manifest.json').sort();
assert(actualFiles.length === listed.size && actualFiles.every(file => listed.has(file)), 'manifest: file set mismatch');
for (const [file, expectedHash] of listed) assert(await sha256File(file) === expectedHash, `manifest: hash mismatch ${file}`);

console.log(JSON.stringify({ schemaFiles: schemaFiles.length, catalogDigest: catalog.digest, digestVector: digestVector.digest, fxCases: fx.cases.length, status: 'passed' }, null, 2));
