import { z } from 'zod';
import type { ToolGateway } from './integrations.js';

/** UI defaults only. Run creation still requires its own explicit allowlist. */
export async function resolveToolDefaults(raw: string | undefined, localDefaults: string[], gateway?: ToolGateway): Promise<string[]> {
  // The local config is already schema-validated by LocalToolGateway.load.
  // Do not rediscover it here: listTools() prepares the optional Docker
  // sandbox, and startup must not require Docker for configured defaults.
  if (raw === undefined) return localDefaults;
  const defaults = z.array(z.string().trim().min(1).max(200)).max(50).parse(
    [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))],
  );
  if (!defaults.length) return [];
  if (!gateway) throw new Error('AEEIS_DEFAULT_ALLOWED_TOOLS requires a configured tool gateway');
  const manifest = await gateway.listTools();
  for (const ref of defaults) {
    const separator = ref.lastIndexOf('@');
    const id = separator > 0 ? ref.slice(0, separator) : ref;
    const version = separator > 0 ? ref.slice(separator + 1) : undefined;
    if (manifest.filter(tool => tool.id === id && (version === undefined || tool.version === version)).length !== 1) {
      throw new Error(`Default tool ${ref} must match exactly one configured tool version`);
    }
  }
  return defaults;
}
