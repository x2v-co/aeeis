import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface CliRequest { url: string; headers: Record<string, string>; redirect: string }
export interface CliResponse { status: number; headers?: Record<string, string>; body: string }
const childScript = fileURLToPath(new URL('./fetch-run-child.mjs', import.meta.url));

export function fetchRunCli(input: string, cwd: string, env: NodeJS.ProcessEnv, handle: (request: CliRequest) => Promise<CliResponse>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = fork(childScript, [input], { cwd, env: { ...process.env, AEEIS_BASE_URL: '', AEEIS_TOKEN: '', ...env }, execArgv: [], silent: true });
    let filename = '', stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('message', async message => {
      const request = message as CliRequest & { id: number; filename?: string; error?: string };
      if (request.filename !== undefined) { filename = request.filename; return; }
      if (request.error !== undefined) { stderr = request.error; return; }
      try { child.send({ id: request.id, ...await handle(request) }); }
      catch (error) { child.send({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
    });
    child.on('close', code => code === 0 ? resolve(filename) : reject(new Error(stderr.trim() || `CLI exited with ${code}`)));
  });
}
