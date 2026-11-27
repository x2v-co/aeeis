import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostConfigs, localToolsConfigSchema, LocalToolGateway } from '../src/local-tools.js';
import { dockerContextArgs, dockerInvocation } from '../src/docker-sandbox.js';

const args = process.argv.slice(2);
/** `--host <name>` picks one of the configured sandbox hosts; without it, the default host. */
const hostFlag = args.indexOf('--host');
const hostName = hostFlag >= 0 ? args.splice(hostFlag, 2)[1] : undefined;
const action = args[0] ?? 'doctor';
const filename = process.env.AEEIS_LOCAL_TOOLS_CONFIG ?? 'local-tools.example.json';
const parsed = localToolsConfigSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
const hosts = hostConfigs(parsed);
const selected = hostName ?? parsed.assign?.default ?? [...hosts.keys()][0]!;
if (!hosts.has(selected)) throw new Error(`No sandbox host named ${selected}; configured: ${[...hosts.keys()].join(', ')}`);
const config = { ...parsed, sandbox: hosts.get(selected)! };
const dockerArgs = dockerContextArgs(config.sandbox);
const docker = (args: string[], timeoutMs?: number) => { const call = dockerInvocation(config.sandbox, args); return run(call.command, call.args, timeoutMs); };
/** Empty values are omitted so an unset build matches official PyPI and the Playwright CDN. */
const mirrorBuildArgs = () => ['PIP_INDEX_URL', 'PIP_TRUSTED_HOST', 'PLAYWRIGHT_DOWNLOAD_HOST'].flatMap(name => {
  const value = process.env[name]?.trim();
  return value ? ['--build-arg', `${name}=${value}`] : [];
});
/** Over SSH the build context is streamed as a tar archive, so the remote host needs no copy of this repository. */
const buildOverSsh = (buildArgs: string[]) => new Promise<void>((resolve, reject) => {
  const call = dockerInvocation(config.sandbox, ['build', '--pull', ...buildArgs, '-t', config.sandbox.image, '-']);
  const tar = spawn('tar', ['-C', 'sandbox', '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const build = spawn(call.command, call.args, { stdio: ['pipe', 'inherit', 'inherit'] });
  tar.stdout.pipe(build.stdin);
  const timer = setTimeout(() => { build.kill('SIGTERM'); reject(new Error('build timed out')); }, 1_800_000);
  build.once('error', error => { clearTimeout(timer); reject(error); });
  build.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`docker build exited ${code}`)); });
});
const run = (command: string, args: string[], timeoutMs = 30000) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)); }, timeoutMs);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
});
try {
  if (action === 'up') {
    if (!config.sandbox.ssh && process.platform === 'darwin' && dockerArgs.join(' ') === '--context colima-aeeis') {
      await run('colima', ['start', 'aeeis', '--runtime', 'docker', '--activate=false', '--mount', 'none', '--ssh-agent=false', '--ssh-config=false', '--cpu', '2', '--memory', '4', '--disk', '20', '--vm-type', 'vz'], 300000);
    }
    await docker(['info', '--format', 'Docker {{.ServerVersion}} · {{.OSType}}']);
    console.log('Engine ready. Next: npm run sandbox:build');
  } else if (action === 'build') {
    await docker(['info', '--format', '{{.OSType}}'], 20000);
    const mirrors = mirrorBuildArgs();
    if (mirrors.length) console.log(`Sandbox build mirrors: ${mirrors.filter(arg => arg !== '--build-arg').join(' ')}`);
    if (config.sandbox.ssh) await buildOverSsh(mirrors);
    else await run('docker', [...dockerArgs, 'build', '--pull', ...mirrors, '-t', config.sandbox.image, 'sandbox'], 600000);
  } else if (action === 'doctor') {
    await docker(['info', '--format', 'Docker {{.ServerVersion}} · {{.OSType}} · cgroup {{.CgroupVersion}}'], 20000);
    const gateway = await LocalToolGateway.load(filename);
    try {
      const health = await gateway.hosts().find(([name]) => name === selected)![1].health({ probe: true }); console.log(health.detail);
      if (!health.ready) process.exitCode = 1;
    } finally { await gateway.close(); }
  } else if (action === 'release' && args[1]) {
    const gateway = await LocalToolGateway.load(filename);
    try { await gateway.release(args[1]); console.log('Run sandbox released; artifacts preserved.'); }
    finally { await gateway.close(); }
  } else throw new Error('Usage: sandbox.ts [--host <name>] up | build | doctor | release <runId>');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(config.sandbox.ssh
    ? `Remote sandbox: check that \`ssh ${config.sandbox.ssh} docker info\` works without a password prompt.`
    : process.platform === 'darwin'
    ? 'macOS: install Colima and Docker CLI (brew install colima docker), then npm run sandbox:up. The aeeis profile does not change your global Docker context.'
    : 'Linux: install Docker Engine, start its daemon, and grant this user access to its Unix socket (rootless Docker is supported). No Colima or Docker Desktop is needed.');
  process.exitCode = 1;
}
