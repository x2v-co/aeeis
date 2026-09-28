"""File helpers and foreground execution inside a persistent Run container."""
import base64
import difflib
import glob
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time

ROOT = Path('/workspace')
MAX_FILE = 8 * 1024 * 1024
MAX_FILES = 1000
MAX_OUTPUT = 48000


class ToolError(Exception):
    def __init__(self, message, status='failed', details=None):
        super().__init__(message)
        self.status, self.details = status, details


def sha(data):
    return hashlib.sha256(data.encode('utf-8') if isinstance(data, str) else data).hexdigest()


def safe_path(name, parents=False):
    if not isinstance(name, str) or not name or len(name.encode('utf-8')) > 1000:
        raise ToolError('Invalid workspace path')
    if name.startswith('/') or '\\' in name or any(ord(c) < 32 for c in name):
        raise ToolError('Use a relative path inside this Run workspace')
    parts = name.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ToolError('Use a relative path inside this Run workspace')
    current = ROOT
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if parents and index < len(parts) - 1:
                current.mkdir(mode=0o700)
            continue
        if stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink > 1):
            raise ToolError('Symbolic links and hard links are not supported')
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ToolError('Parent path is not a directory')
        if index == len(parts) - 1 and not stat.S_ISREG(info.st_mode):
            raise ToolError('Path does not identify a regular file')
    return current


def read_text(name):
    path = safe_path(name)
    try:
        with path.open('rb') as stream:
            raw = stream.read(1_000_001)
    except FileNotFoundError:
        raise ToolError('File not found: ' + name)
    if len(raw) > 1_000_000:
        raise ToolError('Expected a text file of at most 1 MB')
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        raise ToolError('File is not UTF-8 text')
    if '\0' in text:
        raise ToolError('File is not UTF-8 text')
    return text


def inventory(pattern):
    if pattern.startswith('/') or '..' in pattern.split('/') or '\\' in pattern:
        raise ToolError('Glob must be relative to this Run workspace')
    results = []
    for name in glob.iglob(pattern, root_dir=str(ROOT), recursive=True, include_hidden=True):
        path = safe_path(name) if not (ROOT / name).is_dir() else None
        if path is not None:
            results.append(name)
        if len(results) > 10000:
            return sorted(set(results[:10000])), True
    return sorted(set(results)), False


def execute(argv, timeout):
    child = subprocess.Popen(
        argv, cwd=ROOT,
        env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root', 'PYTHONUNBUFFERED': '1'},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True,
    )
    streams = selectors.DefaultSelector()
    streams.register(child.stdout, selectors.EVENT_READ, 'stdout')
    streams.register(child.stderr, selectors.EVENT_READ, 'stderr')
    captured = {'stdout': bytearray(), 'stderr': bytearray()}
    deadline, size, stopped = time.monotonic() + timeout, 0, False
    try:
        while streams.get_map():
            if time.monotonic() >= deadline:
                stopped = True
                break
            for key, _ in streams.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                size += len(chunk)
                if size > MAX_OUTPUT:
                    stopped = True
                    break
                captured[key.data].extend(chunk)
            if stopped:
                break
        if not stopped:
            try:
                child.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                stopped = True
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        streams.close()
    output = {key: bytes(value).decode('utf-8', errors='replace') for key, value in captured.items()}
    output['exitCode'] = child.returncode
    if stopped:
        raise ToolError('Command stopped after timeout/output limit; file changes may already exist', 'unknown', output)
    if child.returncode != 0:
        raise ToolError('Command exited with an error', 'failed', output)
    return output


def perform(tool, args, timeout):
    if tool == 'python':
        return execute([sys.executable, '-u', '-c', args['code']], timeout)
    if tool == 'shell':
        return execute(['/bin/bash', '-lc', args['command']], timeout)
    if tool == 'read':
        content = read_text(args['path'])
        lines = content.split('\n')
        start, limit = args.get('startLine', 1), args.get('maxLines', 200)
        selected = '\n'.join(f'{index + start}: {text}' for index, text in enumerate(lines[start - 1:start - 1 + limit]))
        return {'path': args['path'], 'sha256': sha(content), 'totalLines': len(lines), 'startLine': start, 'content': selected[:24000], 'truncated': len(selected) > 24000 or start - 1 + limit < len(lines)}
    if tool in ('write', 'diff'):
        path = safe_path(args['path'], parents=tool == 'write')
        content = args['content']
        if len(content.encode('utf-8')) > 1_000_000:
            raise ToolError('File exceeds 1 MB')
        exists = path.exists()
        before = read_text(args['path']) if exists else ''
        if tool == 'diff':
            patch = ''.join(difflib.unified_diff(before.splitlines(keepends=True), content.splitlines(keepends=True), fromfile=args['path'], tofile=args['path']))
            return {'path': args['path'], 'beforeHash': sha(before) if exists else None, 'afterHash': sha(content), 'diff': patch[:24000], 'truncated': len(patch) > 24000}
        if exists and args.get('expectedHash') != sha(before):
            raise ToolError('Existing file requires its current expectedHash; read it before replacing it')
        if not exists and args.get('expectedHash'):
            raise ToolError('Expected file no longer exists')
        path.write_bytes(content.encode('utf-8'))
        return {'path': args['path'], 'bytes': len(content.encode('utf-8')), 'sha256': sha(content), 'created': not exists}
    if tool in ('glob', 'grep'):
        paths, truncated = inventory(args.get('pattern', '**/*') if tool == 'glob' else args.get('glob', '**/*'))
        limit = args.get('limit', 100 if tool == 'glob' else 50)
        if tool == 'glob':
            return {'paths': paths[:limit], 'truncated': truncated or len(paths) > limit}
        matches, skipped = [], 0
        needle = args['pattern'].lower() if args.get('ignoreCase') else args['pattern']
        for name in paths:
            try:
                content = read_text(name)
            except ToolError:
                skipped += 1
                continue
            for index, line in enumerate(content.split('\n')):
                if needle in (line.lower() if args.get('ignoreCase') else line):
                    if len(matches) >= limit:
                        return {'matches': matches, 'skippedFiles': skipped, 'truncated': True}
                    matches.append({'path': name, 'line': index + 1, 'text': line[:500]})
        return {'matches': matches, 'skippedFiles': skipped, 'truncated': truncated}
    raise ToolError('Unsupported sandbox tool')


def restore(files, limit):
    size = 0
    if len(files) > MAX_FILES:
        raise ToolError('Too many workspace files')
    for item in files:
        path = safe_path(item['path'], parents=True)
        data = base64.b64decode(item['base64'], validate=True)
        size += len(data)
        if len(data) > MAX_FILE or size > limit:
            raise ToolError('Workspace snapshot exceeds size limit')
        with path.open('xb') as stream:
            stream.write(data)


def snapshot(limit):
    export_root = ROOT / 'artifacts'
    if not export_root.exists() and not export_root.is_symlink():
        return []
    if export_root.is_symlink() or not export_root.is_dir():
        raise ToolError('Artifact directory must be a real directory', 'unknown')
    files, size, entries = [], 0, 0
    for directory, directories, filenames in os.walk(export_root, followlinks=False):
        entries += len(directories) + len(filenames)
        if entries > 2000:
            raise ToolError('Workspace contains too many entries', 'unknown')
        for name in directories:
            if (Path(directory) / name).is_symlink():
                raise ToolError('Workspace contains a symlink; snapshot rejected', 'unknown')
        for name in sorted(filenames):
            relative = (Path(directory) / name).relative_to(ROOT).as_posix()
            path = safe_path(relative)
            if len(files) >= MAX_FILES or path.stat().st_size > MAX_FILE:
                raise ToolError('Workspace snapshot exceeds size limit', 'unknown')
            with path.open('rb') as stream:
                data = stream.read(MAX_FILE + 1)
            size += len(data)
            if len(data) > MAX_FILE or size > limit:
                raise ToolError('Workspace snapshot exceeds size limit', 'unknown')
            files.append({'path': path.relative_to(export_root).as_posix(), 'base64': base64.b64encode(data).decode('ascii')})
    return sorted(files, key=lambda item: item['path'])


