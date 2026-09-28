import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { localToolsConfigSchema, LocalToolGateway } from '../src/local-tools.js';
import { dockerContextArgs } from '../src/docker-sandbox.js';

const action = process.argv[2] ?? 'doctor';
const filename = process.env.AEEIS_LOCAL_TOOLS_CONFIG ?? 'local-tools.example.json';
const config = localToolsConfigSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
const dockerArgs = dockerContextArgs(config.sandbox);
const run = (command: string, args: string[], timeoutMs = 30000) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)); }, timeoutMs);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)); });
});
try {
  if (action === 'up') {
    if (process.platform === 'darwin' && dockerArgs.join(' ') === '--context colima-aeeis') {
      await run('colima', ['start', 'aeeis', '--runtime', 'docker', '--activate=false', '--mount', 'none', '--ssh-agent=false', '--ssh-config=false', '--cpu', '2', '--memory', '4', '--disk', '20', '--vm-type', 'vz'], 300000);
    }
    await run('docker', [...dockerArgs, 'info', '--format', 'Docker {{.ServerVersion}} · {{.OSType}}']);
    console.log('Engine ready. Next: npm run sandbox:build');
  } else if (action === 'build') {
    await run('docker', [...dockerArgs, 'info', '--format', '{{.OSType}}'], 10000);
    await run('docker', [...dockerArgs, 'build', '--pull', '-t', config.sandbox.image, 'sandbox'], 600000);
  } else if (action === 'doctor') {
    await run('docker', [...dockerArgs, 'info', '--format', 'Docker {{.ServerVersion}} · {{.OSType}} · cgroup {{.CgroupVersion}}'], 10000);
    const gateway = await LocalToolGateway.load(filename);
    try {
      const health = await gateway.health(); console.log(health.detail);
      if (!health.ready) process.exitCode = 1;
    } finally { await gateway.close(); }
  } else if (action === 'release' && process.argv[3]) {
    const gateway = await LocalToolGateway.load(filename);
    try { await gateway.release(process.argv[3]); console.log('Run sandbox released; artifacts preserved.'); }
    finally { await gateway.close(); }
  } else throw new Error('Usage: sandbox.ts up | build | doctor | release <runId>');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(process.platform === 'darwin'
    ? 'macOS: install Colima and Docker CLI (brew install colima docker), then npm run sandbox:up. The aeeis profile does not change your global Docker context.'
    : 'Linux: install Docker Engine, start its daemon, and grant this user access to its Unix socket (rootless Docker is supported). No Colima or Docker Desktop is needed.');
  process.exitCode = 1;
}
