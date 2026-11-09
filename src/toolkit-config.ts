import { z } from 'zod';
import { ConfiguredHttpToolGateway, ToolkitMcpGateway, ToolkitRegistryGateway, type ToolGateway } from './integrations.js';

/** The remote Toolkit the server uses, from its environment. Shared with scripts/check-tools.mjs so a deploy
 * pre-check combines exactly what the server combines. */
export function remoteToolGateway(env: NodeJS.ProcessEnv): ToolGateway | undefined {
  return env.AEEIS_TOOLKIT_MCP_URL
    ? new ToolkitMcpGateway(env.AEEIS_TOOLKIT_MCP_URL, env.AEEIS_TOOLKIT_TOKEN ?? '', env.AEEIS_TOOLKIT_DEFAULT_VERSION ?? 'rolling')
    : env.AEEIS_TOOLKIT_REGISTRY_URL
    ? new ToolkitRegistryGateway(
      env.AEEIS_TOOLKIT_REGISTRY_URL,
      env.AEEIS_TOOLKIT_TOKEN,
      {
        verifySignatures: env.AEEIS_TOOLKIT_VERIFY_SIGNATURES === '1' || (env.AEEIS_ENV === 'production' && env.AEEIS_TOOLKIT_VERIFY_SIGNATURES !== '0'),
        ...(env.AEEIS_TOOLKIT_ROOT_PUBLIC_JWK ? { rootPublicJwk: z.record(z.string(), z.unknown()).parse(JSON.parse(env.AEEIS_TOOLKIT_ROOT_PUBLIC_JWK)) } : {}),
        ...(env.AEEIS_TOOLKIT_RECONCILE_URL ? { reconcileUrl: env.AEEIS_TOOLKIT_RECONCILE_URL } : {}),
        ...(env.AEEIS_TOOLKIT_PINNED_TOOLS ? {
          additionalTools: z.array(z.object({
            id: z.string().trim().min(1).max(200), version: z.string().trim().min(1).max(100), endpoint: z.string().url(),
            capabilities: z.array(z.string().trim().min(1).max(100)).max(20).optional(), description: z.string().max(4000).optional(),
            inputSchema: z.unknown().optional(), outputSchema: z.unknown().optional(),
          }).strict()).max(20).parse(JSON.parse(env.AEEIS_TOOLKIT_PINNED_TOOLS)).map(tool => ({
            id: tool.id, version: tool.version, endpoint: tool.endpoint,
            ...(tool.capabilities === undefined ? {} : { capabilities: tool.capabilities }),
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
          })),
        } : {}),
      },
    )
    : env.AEEIS_TOOLKIT_MANIFEST_URL && env.AEEIS_TOOLKIT_INVOKE_URL
    ? new ConfiguredHttpToolGateway(env.AEEIS_TOOLKIT_MANIFEST_URL, env.AEEIS_TOOLKIT_INVOKE_URL, env.AEEIS_TOOLKIT_TOKEN, env.AEEIS_TOOLKIT_RECONCILE_URL)
    : undefined;
}
