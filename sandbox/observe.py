"""Read-only view of a Run container for the owner's panel. Runs beside the tool service, which handles one
request at a time, so a long command never hides its own output. Prints one bounded JSON document."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path('/workspace')
LIVE = Path('/run/aeeis-live')
TAIL = 12000
DIFF = 24000
SKIP = {'.git', 'node_modules', '.previous-artifacts', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'artifacts'}


def tail(path, limit=TAIL):
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            stream.seek(max(0, stream.tell() - limit))
            return stream.read().decode('utf-8', errors='replace')
    except OSError:
        return ''


def foreground():
    try:
        record = json.loads((LIVE / 'foreground.json').read_text())
    except (OSError, ValueError):
        return None
    return {'command': str(record.get('command', ''))[:500], 'startedAt': record.get('startedAt'), 'finishedAt': record.get('finishedAt'), 'output': tail(LIVE / 'foreground.log')}


def processes():
    result = []
    for meta in sorted(LIVE.glob('proc_*.json'), key=lambda item: item.stat().st_mtime, reverse=True)[:8]:
        try:
            record = json.loads(meta.read_text())
        except (OSError, ValueError):
            continue
        running = Path(f"/proc/{record.get('pid')}").exists()
        result.append({'processId': meta.stem, 'command': str(record.get('command', ''))[:200], 'running': running, 'output': tail(meta.with_suffix('.log'), 4000)})
    return result


def git(*args):
    return subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', *args], cwd=ROOT, capture_output=True, timeout=5,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/root', 'GIT_OPTIONAL_LOCKS': '0'})


def repository():
    try:
        if git('rev-parse', '--is-inside-work-tree').returncode != 0:
            return None
        status = git('status', '--porcelain=v1', '--untracked-files=normal').stdout.decode('utf-8', errors='replace')
        diff = git('diff', 'HEAD').stdout
        return {'status': status[:8000], 'diff': diff[:DIFF].decode('utf-8', errors='replace'), 'truncated': len(diff) > DIFF}
    except (OSError, subprocess.SubprocessError):
        return None


def recent_files():
    found, visited = [], 0
    for directory, directories, names in os.walk(ROOT, followlinks=False):
        directories[:] = [name for name in directories if name not in SKIP]
        for name in names:
            visited += 1
            if visited > 5000:
                break
            path = Path(directory) / name
            try:
                found.append((path.lstat().st_mtime, path.relative_to(ROOT).as_posix()))
            except OSError:
                continue
    return [{'path': path, 'modifiedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(modified))} for modified, path in sorted(found, reverse=True)[:30]]


def executor(session, offset):
    """New output from one executor session, from a byte offset, and whether it has ended."""
    directory = LIVE / 'executor'
    path = directory / f'{session}.jsonl'
    if not all(c in '0123456789abcdef-' for c in session) or not path.exists():
        return {'found': False}
    with path.open('rb') as stream:
        stream.seek(offset)
        chunk = stream.read(256 * 1024)
    complete = chunk[:chunk.rfind(b'\n') + 1]
    exit_file = directory / f'{session}.exit'
    code = exit_file.read_text().strip() if exit_file.exists() else None
    return {'found': True, 'offset': offset + len(complete), 'output': complete.decode('utf-8', errors='replace'), 'more': len(chunk) == 256 * 1024,
        'exitCode': int(code) if code else None, 'errors': tail(directory / f'{session}.err', 2000) if code else ''}


if len(sys.argv) == 4 and sys.argv[1] == 'executor':
    print(json.dumps(executor(sys.argv[2], int(sys.argv[3])), ensure_ascii=True))
else:
    print(json.dumps({'foreground': foreground(), 'processes': processes(), 'repository': repository(), 'files': recent_files()}, ensure_ascii=True))
