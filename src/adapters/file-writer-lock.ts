import { open,readFile,unlink,type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
/** A local single-writer lock can only be reclaimed when its recorded process
 * is known dead. Unknown/legacy lock formats remain closed rather than guessed. */
export async function acquireFileWriter(path: string): Promise<{ handle: FileHandle; token: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path,'wx',0o600), token = `${process.pid}:${randomUUID()}`;
      try { await handle.writeFile(token); await handle.sync(); return { handle,token }; }
      catch (error) { await handle.close(); await unlink(path).catch(() => undefined); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const value = await readFile(path,'utf8'), pid = Number(value.split(':')[0]);
      if (!Number.isInteger(pid) || pid <= 0 || attempt) throw new Error('File store already has a live writer');
      try { process.kill(pid,0); throw new Error('File store already has a live writer'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      // All competing API processes still use exclusive creation on retry.
      if (await readFile(path,'utf8') === value) await unlink(path);
    }
  }
  throw new Error('File writer lock unavailable');
}
export async function releaseFileWriter(path: string, lock: { handle: FileHandle; token: string }): Promise<void> {
  await lock.handle.close();
  if (await readFile(path,'utf8').catch(() => '') === lock.token) await unlink(path);
}
