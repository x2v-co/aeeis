import { z } from 'zod';
import type { ToolGateway } from './integrations.js';

/** UI defaults only. Run creation still requires its own explicit allowlist. Local tools are matched from their
 * configuration (`local`), never by listing them: that would reach the sandbox host, and startup must not depend on
 * it (a paused Bot machine must not stop AEEIS from starting). The remote gateway is listed only when a default is
 * not a local tool. */
export async function resolveToolDefaults(raw: string | undefined, localDefaults: string[], remote?: ToolGateway, local: { id: string; version: string }[] = []): Promise<string[]> {
  if (raw === undefined) return localDefaults;
  const defaults = z.array(z.string().trim().min(1).max(200)).max(50).parse(
    [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))],
  );
  if (!defaults.length) return [];
  if (!remote && !local.length) throw new Error('AEEIS_DEFAULT_ALLOWED_TOOLS requires a configured tool gateway');
  const parse = (ref: string) => {
    const separator = ref.lastIndexOf('@');
    return { id: separator > 0 ? ref.slice(0, separator) : ref, version: separator > 0 ? ref.slice(separator + 1) : undefined };
  };
  const localIds = new Set(local.map(tool => tool.id));
  const remoteTools = remote && defaults.some(ref => !localIds.has(parse(ref).id)) ? await remote.listTools() : [];
  for (const ref of defaults) {
    const { id, version } = parse(ref);
    const matches = [...local, ...remoteTools].filter(tool => tool.id === id && (version === undefined || tool.version === version));
    if (matches.length !== 1) throw new Error(`Default tool ${ref} must match exactly one configured tool version`);
  }
  return defaults;
}
