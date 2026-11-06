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


PROXY_VARIABLES = ('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy')


def command_env():
    """Commands see only a fixed environment, plus the Run's proxy when its network is proxied."""
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root', 'PYTHONUNBUFFERED': '1', 'PLAYWRIGHT_BROWSERS_PATH': '/opt/ms-playwright'}
    env.update({name: os.environ[name] for name in PROXY_VARIABLES if os.environ.get(name)})
    return env


def browse(args, timeout):
    """Open one page in headless Chromium, run a few steps, and keep a screenshot as an artifact."""
    from playwright.sync_api import sync_playwright, Error as PlaywrightError
    deadline_ms = int(max(5, min(timeout, 120)) * 1000)
    console, failures = [], []
    proxy = os.environ.get('HTTPS_PROXY')
    # Playwright sends loopback through the proxy unless told not to; dev servers live on 127.0.0.1.
    os.environ['PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK'] = '1'
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'],
            **({'proxy': {'server': proxy, 'bypass': 'localhost,127.0.0.1'}} if proxy else {}))
        try:
            page = browser.new_page(viewport={'width': args.get('width', 1280), 'height': args.get('height', 800)})
            page.set_default_timeout(min(deadline_ms, 30000))
            page.on('console', lambda message: console.append({'type': message.type, 'text': message.text[:500]}) if message.type in ('error', 'warning') and len(console) < 50 else None)
            page.on('pageerror', lambda error: console.append({'type': 'pageerror', 'text': str(error)[:500]}) if len(console) < 50 else None)
            page.on('requestfailed', lambda request: failures.append({'url': request.url[:300], 'error': (request.failure or '')[:200]}) if len(failures) < 50 else None)
            page.on('response', lambda response: failures.append({'url': response.url[:300], 'status': response.status}) if response.status >= 400 and len(failures) < 50 else None)
            try:
                response = page.goto(args['url'], wait_until='load', timeout=deadline_ms)
                for step in args.get('steps', []):
                    if step['action'] == 'click':
                        page.click(step['selector'])
                    elif step['action'] == 'type':
                        page.fill(step['selector'], step['text'])
                    elif step['action'] == 'press':
                        page.keyboard.press(step['key'])
                    elif step['action'] == 'wait':
                        page.wait_for_selector(step['selector']) if step.get('selector') else page.wait_for_timeout(min(step.get('ms', 500), 10000))
            except PlaywrightError as error:
                raise ToolError('Browser step failed: ' + str(error).split('\n')[0][:300], 'failed', {'console': console, 'networkErrors': failures})
            result = {'url': page.url, 'title': page.title()[:300], 'status': response.status if response else None,
                'text': page.inner_text('body')[:4000] if page.query_selector('body') else '', 'console': console, 'networkErrors': failures}
            if args.get('screenshot', True):
                directory = safe_path('artifacts/screenshots/.keep', parents=True).parent
                name = f"{time.strftime('%Y%m%dT%H%M%S', time.gmtime())}-{os.urandom(3).hex()}.png"
                data = page.screenshot(full_page=args.get('fullPage', False), type='png')
                (directory / name).write_bytes(data)
                result['screenshot'] = {'path': f'artifacts/screenshots/{name}', 'sha256': sha(data), 'bytes': len(data)}
            return result
        finally:
            browser.close()


def execute(argv, timeout):
    child = subprocess.Popen(
        argv, cwd=ROOT,
        env=command_env(),
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
    if tool == 'browser':
        return browse(args, timeout)
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


def retire_artifacts():
    """A persistent workspace keeps files between Runs, but artifacts belong to one Run and were already exported."""
    current = ROOT / 'artifacts'
    if current.is_symlink() or (current.exists() and any(current.iterdir())):
        archive = ROOT / '.previous-artifacts'
        archive.mkdir(mode=0o700, exist_ok=True)
        current.rename(archive / time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    current.mkdir(mode=0o755, exist_ok=True)


def restore(files, limit, persistent=False):
    size = 0
    if persistent:
        retire_artifacts()
    if len(files) > MAX_FILES:
        raise ToolError('Too many workspace files')
    for item in files:
        path = safe_path(item['path'], parents=True)
        data = base64.b64decode(item['base64'], validate=True)
        size += len(data)
        if len(data) > MAX_FILE or size > limit:
            raise ToolError('Workspace snapshot exceeds size limit')
        with path.open('wb' if persistent else 'xb') as stream:
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


