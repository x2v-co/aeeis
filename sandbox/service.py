"""One Run's tool server. Background processes live until stopped or Run cleanup."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import socketserver
import subprocess
import threading
import time
import uuid

spec = importlib.util.spec_from_file_location('runner', '/opt/aeeis/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
processes = {}
lock = threading.Lock()
born = last_activity = time.monotonic()


def drain(stream, record, kind):
    while True:
        chunk = os.read(stream.fileno(), 4096)
        if not chunk:
            return
        # Ring buffer: long-running services cannot fill the container disk with logs.
        record[kind] = (record[kind] + chunk)[-24000:]


def process_tool(args):
    action = args['action']
    if action == 'start':
        # Reap old exited records to bound memory without losing active handles.
        for key in list(processes):
            if len(processes) < 64:
                break
            if processes[key]['child'].poll() is not None:
                del processes[key]
        if len(processes) >= 64:
            raise runner.ToolError('Stop or inspect existing processes before starting more')
        child = subprocess.Popen(['/bin/bash', '-lc', args['command']], cwd=runner.ROOT,
            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root', 'PYTHONUNBUFFERED': '1'},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        handle = 'proc_' + uuid.uuid4().hex
        record = {'child': child, 'stdout': b'', 'stderr': b'', 'command': args['command'][:200]}
        processes[handle] = record
        for kind in ('stdout', 'stderr'):
            threading.Thread(target=drain, args=(getattr(child, kind), record, kind), daemon=True).start()
        return {'processId': handle, 'pid': child.pid, 'state': 'started'}
    if action == 'list':
        return {'processes': [{'processId': key, 'pid': rec['child'].pid, 'command': rec['command'],
            'state': 'running' if rec['child'].poll() is None else 'exited', 'exitCode': rec['child'].poll()} for key, rec in processes.items()]}
    record = processes.get(args.get('processId'))
    if record is None:
        raise runner.ToolError('Unknown process handle; list processes in this Run first')
    child = record['child']
    if action == 'stop':
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=5)
        return {'processId': args['processId'], 'state': 'exited', 'exitCode': child.poll()}
    if action == 'logs':
        return {'processId': args['processId'], 'exitCode': child.poll(),
            'stdout': record['stdout'].decode('utf-8', errors='replace'),
            'stderr': record['stderr'].decode('utf-8', errors='replace'), 'tailBytesPerStream': 24000}
    raise runner.ToolError('Unsupported process action')


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        global last_activity
        with lock:
            last_activity = time.monotonic()
            response = {'schemaVersion': 'sandbox-output/2', 'status': 'failed', 'output': {}, 'files': None}
            try:
                self.connection.settimeout(10)
                message = json.loads(self.rfile.read(48 * 1024 * 1024 + 1))
                if message['tool'] == '__ping':
                    self.wfile.write(b'{"ready":true}')
                    return
                limit = min(message['snapshotBytes'], 32 * 1024 * 1024)
                try:
                    if message['tool'] == '__restore':
                        runner.restore(message['files'], limit)
                        response['output'] = {'restored': True}
                    elif message['tool'] == '__snapshot':
                        response['output'] = {'exported': True}
                    elif message['tool'] == 'process':
                        response['output'] = process_tool(message['input'])
                    else:
                        response['output'] = runner.perform(message['tool'], message['input'], min(message['timeoutMs'] / 1000, 600))
                    response['status'] = 'completed'
                except runner.ToolError as error:
                    response.update(status=error.status, output={'error': str(error), **({'details': error.details} if error.details else {})})
                except Exception as error:
                    response.update(status='failed', output={'error': str(error)[:1000]})
                # A failed export does not pretend the command itself never executed.
                response['files'] = runner.snapshot(limit)
            except Exception as error:
                response.update(status='unknown', output={'error': str(error)[:1000]}, files=None)
            self.wfile.write(json.dumps(response, ensure_ascii=True).encode())
            last_activity = time.monotonic()


socket_path = '/run/aeeis.sock'
Path(socket_path).unlink(missing_ok=True)
server = socketserver.UnixStreamServer(socket_path, Handler)
server.timeout = 1
idle = int(os.environ.get('AEEIS_SANDBOX_IDLE_SECONDS', '3600'))
lifetime = int(os.environ.get('AEEIS_SANDBOX_LIFETIME_SECONDS', '86400'))
while time.monotonic() - last_activity < idle and time.monotonic() - born < lifetime:
    server.handle_request()
# Exit PID 1's child; Docker then terminates every process in this container.
server.server_close()
