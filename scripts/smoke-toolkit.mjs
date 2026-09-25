#!/usr/bin/env node

/**
 * Verify the live toolkit_new Registry contract from the built AEEIS adapter.
 *
 * This is intentionally an opt-in smoke rather than a unit fixture. It does
 * not discover or trust a root key from the Registry response: the operator
 * must inject the expected public root JWK out of band.
 */

import process from 'node:process';

const registryUrl = process.env.AEEIS_TOOLKIT_REGISTRY_URL;
const token = process.env.AEEIS_TOOLKIT_TOKEN;
const rootJwkRaw = process.env.AEEIS_TOOLKIT_ROOT_PUBLIC_JWK;
const toolId = process.env.AEEIS_TOOLKIT_LIVE_TOOL || 'json-pretty';
const toolInput = process.env.AEEIS_TOOLKIT_LIVE_INPUT || '{"b":2,"a":1}';

if (!registryUrl) throw new Error('AEEIS_TOOLKIT_REGISTRY_URL is required');
if (!token) throw new Error('AEEIS_TOOLKIT_TOKEN is required');
if (!rootJwkRaw) throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK is required; do not trust a root returned by the Registry');

let rootPublicJwk;
try {
  rootPublicJwk = JSON.parse(rootJwkRaw);
} catch {
  throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK must be valid JSON');
}
if (!rootPublicJwk || typeof rootPublicJwk !== 'object' || Array.isArray(rootPublicJwk)
  || rootPublicJwk.kty !== 'OKP' || rootPublicJwk.crv !== 'Ed25519'
  || typeof rootPublicJwk.x !== 'string' || rootPublicJwk.d !== undefined) {
  throw new Error('AEEIS_TOOLKIT_ROOT_PUBLIC_JWK must be a public Ed25519 JWK');
}

const { ToolkitRegistryGateway } = await import('../dist/integrations.js');
const gateway = new ToolkitRegistryGateway(registryUrl, token, {
  verifySignatures: true,
  rootPublicJwk,
});

const tools = await gateway.listTools();
const tool = tools.find((candidate) => candidate.id === toolId);
if (!tool) throw new Error(`toolkit_new Registry does not publish ${toolId}`);

const result = await gateway.invoke({
  toolId: tool.id,
  toolVersion: tool.version,
  taskId: `toolkit-live-smoke:${tool.id}`,
  purpose: 'AEEIS live toolkit_new Registry contract smoke',
  input: { input: toolInput },
  capabilityGrant: `toolkit-live-smoke:${tool.id}@${tool.version}`,
  idempotencyKey: `toolkit-live-smoke:${tool.id}@${tool.version}:${toolInput}`,
  timeoutMs: 15_000,
});

if (result.status !== 'completed') {
  throw new Error(`toolkit_new invocation did not complete: ${JSON.stringify(result)}`);
}
if (result.receipt.provider !== 'toolkit_new') {
  throw new Error(`unexpected AEEIS receipt provider: ${result.receipt.provider}`);
}
if (!result.receipt.outputRefs.some((reference) => reference.startsWith('toolkit-receipt:'))) {
  throw new Error('toolkit_new invocation did not return a provider receipt reference');
}

console.log(JSON.stringify({
  schemaVersion: 'aeeis.toolkit-live-smoke.v1',
  registryUrl,
  tool: { id: tool.id, version: tool.version },
  publishedToolCount: tools.length,
  status: result.status,
  receipt: {
    provider: result.receipt.provider,
    operation: result.receipt.operation,
    outputRefs: result.receipt.outputRefs,
  },
  output: result.output,
}, null, 2));
