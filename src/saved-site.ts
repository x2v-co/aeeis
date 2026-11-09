import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';

/**
 * Runs in the Run's machine just before it is reclaimed, whatever the Run's outcome. It packs the source (unless the
 * passed check already did) and copies the site the work produced into artifacts/site, so both reach this host with the
 * final artifact export and stay reviewable after the machine is gone. Best effort and bounded: the export fails as a
 * whole above the snapshot limit, and a failed export keeps the machine, so anything too large is simply left out.
 */
export const PACK_DELIVERABLES = `python3 -I - <<'AEEIS_PACK'
import json, os, shutil, tarfile
from pathlib import Path
root = Path(os.environ.get('AEEIS_PACK_ROOT') or '/workspace'); art = root / 'artifacts'
TOTAL, PART, FILES = 15 * 1024 * 1024, 6 * 1024 * 1024, 400
SKIP = {'node_modules', '.git', '.previous-artifacts'}
OWN = {'screenshots', 'site', 'source.tar.gz'}
def ours(rel):
    parts = Path(rel).parts
    return any(p in SKIP for p in parts) or (len(parts) > 1 and parts[0] == 'artifacts' and parts[1] in OWN)
def used():
    size = count = 0
    for d, _, fs in os.walk(art):
        for f in fs:
            p = os.path.join(d, f)
            if not os.path.islink(p): size += os.path.getsize(p); count += 1
    return size, count
art.mkdir(exist_ok=True)
site = art / 'site'
if site.is_symlink(): site.unlink()
elif site.exists(): shutil.rmtree(site)
report = {}
source = art / 'source.tar.gz'
if not source.exists():
    tmp = Path('/tmp/aeeis-source.tar.gz')
    with tarfile.open(tmp, 'w:gz') as tar:
        tar.add(str(root), arcname='.', filter=lambda info: None if ours(os.path.normpath(info.name)) else info)
    with tarfile.open(tmp) as tar: files = sum(1 for m in tar if m.isfile())
    if files and tmp.stat().st_size <= min(PART, TOTAL - used()[0]): shutil.move(str(tmp), source); report['source'] = files
    else: tmp.unlink()
found = []
for d, ds, fs in os.walk(root):
    rel = Path(d).relative_to(root)
    ds[:] = [x for x in ds if len(rel.parts) < 4 and not os.path.islink(os.path.join(d, x)) and not ours(rel / x)]
    if 'index.html' in fs and not os.path.islink(os.path.join(d, 'index.html')): found.append(rel)
if found:
    chosen = min(found, key=lambda rel: (rel.name not in ('dist', 'build', 'out'), len(rel.parts), str(rel)))
    base, budget, room = root / chosen, min(PART, TOTAL - used()[0]), FILES
    copies = []
    for d, ds, fs in os.walk(base):
        rel = Path(d).relative_to(root)
        ds[:] = [x for x in ds if not os.path.islink(os.path.join(d, x)) and not ours(rel / x) and not (rel == Path('.') and x == 'artifacts')]
        for f in fs:
            p = Path(d) / f
            if p.is_symlink() or not p.is_file() or ours(rel / f): continue
            budget -= p.stat().st_size; room -= 1
            copies.append(p)
    if budget >= 0 and room >= 0:
        for p in copies:
            target = site / p.relative_to(base)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
        report['site'] = {'from': str(chosen), 'files': len(copies)}
    else: report['siteSkipped'] = 'too large'
print(json.dumps(report))
AEEIS_PACK`;

const RUN_ID = /^run_[a-f0-9-]{36}$/;
/** Links to a saved site are short-lived, because they work without the owner's token: the token never leaves a header. */
export const SITE_LINK_SECONDS = 3600;

export function siteTicket(secret: Buffer, runId: string, expiresAt: number): string {
  return `${expiresAt}.${createHmac('sha256', secret).update(`saved-site\n${runId}\n${expiresAt}`).digest('base64url')}`;
}
export function siteTicketValid(secret: Buffer, runId: string, ticket: string, now = Date.now()): boolean {
  const match = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!match || !RUN_ID.test(runId) || Number(match[1]) * 1000 < now) return false;
  const expected = Buffer.from(siteTicket(secret, runId, Number(match[1]))), given = Buffer.from(ticket);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.map': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
/**
 * The page runs as an opaque origin (sandbox without allow-same-origin), so its scripts can reach neither this
 * origin's storage nor its API, and it can send nothing back. Module scripts load cross-origin from an opaque origin,
 * hence the open CORS header on these public, ticket-gated files.
 */
export const SAVED_SITE_HEADERS = {
  'content-security-policy': "sandbox allow-scripts allow-forms allow-modals allow-popups; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'access-control-allow-origin': '*', 'x-robots-tag': 'noindex',
};

/** Reads one file of a Run's saved site. Only regular files inside the copy are served; a folder serves its index.html. */
export async function savedSiteFile(workspaceRoot: string, runId: string, path: string): Promise<{ body: Buffer; type: string } | undefined> {
  if (!RUN_ID.test(runId)) return undefined;
  const parts = path.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || part.includes('\\') || /[\u0000-\u001f]/.test(part))) return undefined;
  const root = join(workspaceRoot, runId, 'artifacts', 'site');
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) return undefined;
  let target = join(realRoot, ...parts);
  let info = await lstat(target).catch(() => undefined);
  if (info?.isDirectory()) { target = join(target, 'index.html'); info = await lstat(target).catch(() => undefined); }
  if (!info?.isFile() || info.size > 8 * 1024 * 1024) return undefined;
  const real = await realpath(target).catch(() => undefined);
  if (!real || !real.startsWith(realRoot + sep)) return undefined;
  return { body: await readFile(real), type: TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream' };
}
