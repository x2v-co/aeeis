import { z } from 'zod';
import type { ToolGateway } from './integrations.js';

/**
 * Whether a Toolkit listing failed because the Toolkit could not be reached (network failure, timeout, HTTP 5xx, 408
 * or 429), which may pass. A Toolkit that answered with an auth error, a missing path, a malformed manifest or a bad
 * signature is misconfigured, and that must still fail startup and deploy checks.
 */
export function toolkitUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) return true;
  const status = /returned HTTP (\d{3})\b/.exec(error.message)?.[1];
  return status !== undefined && (status.startsWith('5') || status === '408' || status === '429');
}

/** UI defaults only. Run creation still requires its own explicit allowlist. Local tools are matched from their
 * configuration (`local`), never by listing them: that would reach the sandbox host, and startup must not depend on
 * it (a paused Bot machine must not stop AEEIS from starting). The remote gateway is listed only when a default is
 * not a local tool. */
export async function resolveToolDefaults(raw: string | undefined, localDefaults: string[], remote?: ToolGateway, local: { id: string; version: string }[] = [], warn: (message: string) => void = message => console.warn(message)): Promise<string[]> {
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
  let remoteTools: { id: string; version: string }[] = [], remoteDown = false;
  if (remote && defaults.some(ref => !localIds.has(parse(ref).id))) {
    // A remote Toolkit outage must not stop AEEIS from starting. Its defaults are kept unchecked; a Run that uses one
    // fails at that call until the Toolkit is back. Local defaults are always checked.
    try { remoteTools = await remote.listTools(); }
    catch (error) {
      if (!toolkitUnreachable(error)) throw error;
      remoteDown = true; warn(`Remote Toolkit unreachable; default tools it serves were not checked: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const ref of defaults) {
    const { id, version } = parse(ref);
    if (remoteDown && !localIds.has(id)) continue;
    const matches = [...local, ...remoteTools].filter(tool => tool.id === id && (version === undefined || tool.version === version));
    if (matches.length !== 1) throw new Error(`Default tool ${ref} must match exactly one configured tool version`);
  }
  return defaults;
}
