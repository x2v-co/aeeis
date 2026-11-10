#!/usr/bin/env node
// Deploy pre-check for the tool setup, run in a one-off API container with the stack's settings:
//   docker compose ... run --rm --no-deps -T api node scripts/check-tools.mjs
// It repeats what the server does at startup for tools (secret files, startup checks, remote Toolkit plus local
// tools, default tools) and lists the combined tools, so a release that would not start, or whose tools could not
// be combined, is caught before any running container is replaced. The sandbox host is checked but only reported.
// It starts no server, worker, store or Run.
import { loadFileEnvironment } from '../dist/config-secrets.js';
import { validateRuntimeConfig } from '../dist/config-validation.js';
import { CombinedToolGateway, LocalToolGateway } from '../dist/local-tools.js';
import { remoteToolGateway } from '../dist/toolkit-config.js';
import { resolveToolDefaults, toolkitUnreachable } from '../dist/tool-defaults.js';

loadFileEnvironment();
validateRuntimeConfig();
console.log('startup checks: ok');
const remote = remoteToolGateway(process.env);
const local = process.env.AEEIS_LOCAL_TOOLS_CONFIG ? await LocalToolGateway.load(process.env.AEEIS_LOCAL_TOOLS_CONFIG) : undefined;
const toolkit = local && remote ? new CombinedToolGateway([local, remote]) : local ?? remote;
try {
  // The same check the server makes at startup: local defaults from their configuration, the rest from the remote Toolkit.
  const defaults = await resolveToolDefaults(process.env.AEEIS_DEFAULT_ALLOWED_TOOLS, local?.config.defaultAllowedTools ?? [], remote, local?.toolRefs(), message => console.log(`warning: ${message}`));
  console.log(`default tools: ${defaults.join(',') || '(none)'}`);
  // Combining local and remote tools must succeed for every Run. The server starts without reaching the remote Toolkit,
  // so its outage is reported, not enforced; a reachable Toolkit is still checked against the local tools.
  if (local && remote) {
    // Only an outage is tolerated; a Toolkit that answers but is misconfigured (auth, manifest, signature) still fails.
    const reachable = await remote.listTools().then(() => true, error => {
      if (!toolkitUnreachable(error)) throw error;
      console.log(`remote Toolkit: NOT REACHABLE (warning only) - ${error.message}`); return false;
    });
    if (reachable) console.log(`tools: ${(await toolkit.listTools()).length} (local and remote)`);
  }
  if (local) {
    console.log(`executor: ${local.executorTransport() ? 'configured' : 'none'}`);
    // Reported, not enforced: the server starts without its sandbox host, which may simply be paused.
    const health = await local.health({ probe: true });
    console.log(`sandbox host: ${health.ready ? 'reachable' : 'NOT REACHABLE (warning only)'} - ${health.detail}`);
  }
} finally { await local?.close(); }
