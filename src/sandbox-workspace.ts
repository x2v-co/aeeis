import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_FILE = 8 * 1024 * 1024;
export const snapshotSchema = z.array(z.object({ path: z.string().min(1).max(1000), base64: z.string().max(Math.ceil(MAX_FILE / 3) * 4) }).strict()).max(1000);
export type WorkspaceFile = z.infer<typeof snapshotSchema>[number];
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export function validateSnapshot(value: unknown, maxBytes: number): WorkspaceFile[] {
  const files = snapshotSchema.parse(value);
  const paths = new Set<string>(), portablePaths = new Map<string, string>(); let size = 0;
  for (const file of files) {
    if (file.path.includes('\\') || /[\u0000-\u001f\u007f]/.test(file.path) || Buffer.byteLength(file.path) > 1000
      || file.path.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('Unsafe sandbox file path');
    if (paths.has(file.path)) throw new Error('Duplicate sandbox file path');
    paths.add(file.path);
    const parts = file.path.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const path = parts.slice(0, count).join('/'), key = path.normalize('NFC').toLowerCase();
      if (portablePaths.has(key) && portablePaths.get(key) !== path) throw new Error('Ambiguous sandbox file paths');
      portablePaths.set(key, path);
      if (portablePaths.size > 2000) throw new Error('Workspace contains too many entries');
    }
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.length > MAX_FILE || bytes.toString('base64') !== file.base64) throw new Error('Invalid sandbox file encoding or size');
    size += bytes.length;
    if (size > maxBytes) throw new Error('Workspace snapshot exceeds size limit');
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let count = 1; count < parts.length; count++) if (paths.has(parts.slice(0, count).join('/'))) throw new Error('Conflicting sandbox file paths');
  }
  return files;
}

export async function readSnapshot(workspace: string, maxBytes: number): Promise<WorkspaceFile[]> {
  const previous = `${workspace}.previous`;
  // Recover the only interruption window in the directory swap. Never merge two versions.
  try { await lstat(workspace); }
  catch (error) {
    if (!missing(error)) throw error;
    try { await rename(previous, workspace); } catch (restoreError) { if (!missing(restoreError)) throw restoreError; return []; }
  }
  const files: WorkspaceFile[] = [];
  let entries = 0, size = 0;
  async function walk(path: string, prefix: string): Promise<void> {
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Workspace must contain regular files and directories only');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > 2000) throw new Error('Workspace contains too many entries');
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = join(path, entry.name);
      if (entry.isDirectory()) { await walk(target, name); continue; }
      if (!entry.isFile()) throw new Error('Workspace links and special files are not supported');
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE) throw new Error('Workspace links or oversized files are not supported');
        size += info.size;
        if (size > maxBytes || files.length >= 1000) throw new Error('Workspace snapshot exceeds size limit');
        const bytes = await handle.readFile();
        files.push({ path: name, base64: bytes.toString('base64') });
      } finally { await handle.close(); }
    }
  }
  await walk(workspace, '');
  return validateSnapshot(files, maxBytes);
}

/** Materialize only validated files in a fresh directory, then swap the complete snapshot. */
export async function commitSnapshot(workspace: string, value: unknown, maxBytes: number): Promise<void> {
  const files = validateSnapshot(value, maxBytes);
  const staging = `${workspace}.${randomUUID()}.staging`, previous = `${workspace}.previous`;
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const file of files) {
      const path = join(staging, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(Buffer.from(file.base64, 'base64')); await handle.sync(); } finally { await handle.close(); }
    }
    await rm(previous, { recursive: true, force: true });
    try { await rename(workspace, previous); } catch (error) { if (!missing(error)) throw error; }
    try { await rename(staging, workspace); }
    catch (error) { await rename(previous, workspace).catch(() => undefined); throw error; }
    await rm(previous, { recursive: true, force: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
}
