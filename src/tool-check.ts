import { CombinedToolGateway } from './local-tools.js';
import { SandboxUnreachable } from './docker-sandbox.js';
import type { ToolDescriptor, ToolGateway } from './integrations.js';

type LocalTools = ToolGateway & { toolRefs(): { id: string; version: string }[] };

/**
 * The deploy check that local and remote tools combine for every Run. Listing local tools reads the sandbox image on
 * its host, and a host that pauses when idle (instabox) cannot answer; the server starts without it, so this falls
 * back to the configured local tools and still rejects a tool ID both sides offer.
 */
export async function checkCombinedTools(local: LocalTools, remote: ToolGateway, log: (line: string) => void): Promise<number> {
  try {
    const tools = await new CombinedToolGateway([local, remote]).listTools();
    log(`tools: ${tools.length} (local and remote)`);
    return tools.length;
  } catch (error) {
    if (!(error instanceof SandboxUnreachable)) throw error;
    const remoteTools: ToolDescriptor[] = await remote.listTools();
    const remoteIds = new Set(remoteTools.map(tool => tool.id));
    const refs = local.toolRefs();
    const clash = refs.find(ref => remoteIds.has(ref.id));
    if (clash) throw new Error(`Duplicate tool ID across local and remote gateways: ${clash.id}`);
    const count = refs.length + remoteTools.length;
    log(`tools: ${count} (local and remote; local tools from configuration, sandbox host NOT REACHABLE (warning only) - ${error.message})`);
    return count;
  }
}
