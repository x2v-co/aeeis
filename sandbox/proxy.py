"""Outbound proxy for one Run: only allowlisted hosts, only public addresses.

The Run container sits on an internal Docker network with no route out; this proxy is
its only way to the internet. HTTPS goes through CONNECT to port 443; plain HTTP
(apt mirrors) is forwarded for port 80. Every decision is logged as one JSON line.
"""
import asyncio
import ipaddress
import json
import os
import hashlib
import hmac
import socket
import ssl
import sys
import time
from urllib.parse import urlsplit

ALLOWED = [host.strip().lower() for host in os.environ.get('AEEIS_EGRESS_HOSTS', '').split(',') if host.strip()]
PORT = int(os.environ.get('AEEIS_PROXY_PORT', '3128'))
RELAY_PORT = int(os.environ.get('AEEIS_RELAY_PORT', '3129'))
RELAY_SOCKET = os.environ.get('AEEIS_RELAY_SOCKET', '/run/aeeis/relay.sock')
MAX_HEADER = 64 * 1024
IDLE_SECONDS = 300


def allowed_host(host):
    host = host.lower().rstrip('.')
    for rule in ALLOWED:
        if rule.startswith('*.'):
            if host.endswith(rule[1:]) and host != rule[2:]:
                return True
        elif host == rule:
            return True
    return False


def log(decision, host, port, reason=''):
    sys.stdout.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'decision': decision, 'host': host[:255], 'port': port, **({'reason': reason} if reason else {})}) + '\n')
    sys.stdout.flush()


async def resolve_public(host, port):
    """Resolve once and connect to that address, so DNS cannot point an allowed name at a private one."""
    try:
        ipaddress.ip_address(host)
        raise PermissionError('IP literals are not allowed')
    except ValueError:
        pass
    infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = [info[4][0] for info in infos]
    if not addresses or not all(ipaddress.ip_address(address.split('%')[0]).is_global for address in addresses):
        raise PermissionError('Host resolves to a non-public address')
    return addresses[0]


async def pipe(reader, writer):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE_SECONDS)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def refuse(writer, code, message):
    body = message.encode()
    writer.write(f'HTTP/1.1 {code} {message}\r\nContent-Type: text/plain\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def handle(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 30)
    except Exception:
        writer.close()
        return
    if len(head) > MAX_HEADER:
        return await refuse(writer, 431, 'Request header too large')
    lines = head.decode('latin-1').split('\r\n')
    try:
        method, target, version = lines[0].split(' ', 2)
    except ValueError:
        return await refuse(writer, 400, 'Bad request')
    if method == 'CONNECT':
        host, _, port_text = target.rpartition(':')
        host = host.strip('[]')
        port = int(port_text) if port_text.isdigit() else 0
        if port != 443:
            log('deny', host, port, 'port')
            return await refuse(writer, 403, 'Only HTTPS on port 443 is allowed')
        rest = b''
    else:
        if not target.startswith('http://'):
            return await refuse(writer, 400, 'Use an absolute http:// URL or CONNECT')
        authority, _, path = target[7:].partition('/')
        host, _, port_text = authority.rpartition(':') if ':' in authority else (authority, '', '80')
        port = int(port_text) if port_text.isdigit() else 0
        if port != 80:
            log('deny', host, port, 'port')
            return await refuse(writer, 403, 'Only HTTP on port 80 is allowed')
        headers = [line for line in lines[1:] if line and not line.lower().startswith(('proxy-', 'connection:', 'keep-alive:'))]
        rest = '\r\n'.join([f'{method} /{path} {version}', *headers, 'Connection: close', '', '']).encode('latin-1')
    if not allowed_host(host):
        log('deny', host, port, 'not allowlisted')
        return await refuse(writer, 403, f'{host} is not in this Run\'s allowed hosts')
    try:
        address = await resolve_public(host, port)
        upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(address, port), 15)
    except PermissionError as error:
        log('deny', host, port, str(error))
        return await refuse(writer, 403, str(error))
    except Exception:
        log('error', host, port, 'connect failed')
        return await refuse(writer, 502, 'Upstream connection failed')
    log('allow', host, port)
    if method == 'CONNECT':
        writer.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
        await writer.drain()
    else:
        upstream_writer.write(rest)
        await upstream_writer.drain()
    await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))


# Model relay. The executor in the Run container holds only a session token that is worthless anywhere else; this
# process holds the real key, in memory, for as long as the session lasts. Nothing the Run runs can reach it.
sessions = {}
RELAY_PATHS = ('/v1/messages', '/v1/messages/count_tokens')
# A model stream sends regular pings, so this much silence means the connection is gone and the client should retry.
RELAY_IDLE_SECONDS = 120
MAX_REQUEST = 32 * 1024 * 1024
ALLOW_HTTP = os.environ.get('AEEIS_RELAY_ALLOW_HTTP') == '1'


def token_key(token):
    return hashlib.sha256(token.encode()).hexdigest()


def weighted(session):
    # Cache reads cost about a tenth of fresh input, and an agent loop re-reads its whole context on every turn.
    return session['input'] + session['output'] + session['cacheWrite'] + session['cacheRead'] // 10


def session_view(session):
    return {key: session[key] for key in ('calls', 'input', 'output', 'cacheWrite', 'cacheRead', 'refused')} | {'tokens': weighted(session), 'budget': session['budget']}


def count_usage(session, usage):
    if not isinstance(usage, dict):
        return
    # message_start reports input and cache use; message_delta reports the running output total.
    for name, key in (('input_tokens', 'input'), ('cache_creation_input_tokens', 'cacheWrite'), ('cache_read_input_tokens', 'cacheRead')):
        if isinstance(usage.get(name), int) and usage[name] > 0:
            session['current'][key] = usage[name]
    if isinstance(usage.get('output_tokens'), int):
        session['current']['output'] = usage['output_tokens']


def scan_usage(session, line):
    if not line.startswith(b'data:'):
        return
    try:
        event = json.loads(line[5:])
    except ValueError:
        return
    if isinstance(event, dict):
        count_usage(session, event.get('usage'))
        count_usage(session, (event.get('message') or {}).get('usage') if isinstance(event.get('message'), dict) else None)


async def relay_refuse(writer, code, kind, message):
    body = json.dumps({'type': 'error', 'error': {'type': kind, 'message': message}}).encode()
    writer.write(f'HTTP/1.1 {code} Refused\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode() + body)
    try:
        await writer.drain()
    finally:
        writer.close()


async def relay(reader, writer):
    try:
        head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 30)
    except Exception:
        writer.close()
        return
    lines = head.decode('latin-1').split('\r\n')
    try:
        method, target, _ = lines[0].split(' ', 2)
    except ValueError:
        return await relay_refuse(writer, 400, 'invalid_request_error', 'Bad request')
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(':')
        if name:
            headers[name.strip().lower()] = value.strip()
    token = headers.get('x-api-key') or headers.get('authorization', '').removeprefix('Bearer ').strip()
    session = sessions.get(token_key(token))
    path = target.split('?')[0]
    if session is None or not hmac.compare_digest(session['token'], token_key(token)):
        log('deny', 'relay', RELAY_PORT, 'unknown session')
        return await relay_refuse(writer, 401, 'authentication_error', 'This session is not active')
    if method != 'POST' or path not in RELAY_PATHS:
        log('deny', 'relay', RELAY_PORT, f'path {path[:80]}')
        return await relay_refuse(writer, 403, 'permission_error', 'Only model calls are allowed')
    if time.time() > session['expiresAt']:
        return await relay_refuse(writer, 403, 'permission_error', 'This session has expired')
    counting = path == '/v1/messages'
    if counting and weighted(session) >= session['budget']:
        session['refused'] += 1
        log('deny', 'relay', RELAY_PORT, 'budget')
        # 403, not 429: the client would retry a 429, and this will not get better.
        return await relay_refuse(writer, 403, 'permission_error', 'The token budget for this session is used up')
    length = headers.get('content-length', '')
    if not length.isdigit() or int(length) > MAX_REQUEST:
        return await relay_refuse(writer, 400, 'invalid_request_error', 'Content-Length is required')
    try:
        body = await asyncio.wait_for(reader.readexactly(int(length)), 60)
    except Exception:
        writer.close()
        return
    upstream = urlsplit(session['upstream'])
    host, port = upstream.hostname, upstream.port or (443 if upstream.scheme == 'https' else 80)
    try:
        secure = ssl.create_default_context() if upstream.scheme == 'https' else None
        upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=secure, limit=1024 * 1024), 15)
    except Exception:
        log('error', host, port, 'relay connect failed')
        return await relay_refuse(writer, 502, 'api_error', 'Model provider is unreachable')
    passed = [f'{name}: {value}' for name, value in headers.items() if name.startswith('anthropic-') or name in ('content-type', 'user-agent')]
    request = '\r\n'.join([f'POST {target} HTTP/1.1', f'Host: {upstream.netloc}', f"x-api-key: {session['key']}", 'Accept-Encoding: identity', 'Connection: close', f'Content-Length: {len(body)}', *passed, '', ''])
    session['current'] = {'input': 0, 'output': 0, 'cacheWrite': 0, 'cacheRead': 0}
    if counting:
        session['calls'] += 1
    try:
        upstream_writer.write(request.encode('latin-1') + body)
        await upstream_writer.drain()
        response_head = await asyncio.wait_for(upstream_reader.readuntil(b'\r\n\r\n'), 600)
        writer.write(response_head)
        chunked = b'text/event-stream' not in response_head.lower()
        pending, whole = b'', bytearray()
        while True:
            data = await asyncio.wait_for(upstream_reader.read(65536), RELAY_IDLE_SECONDS)
            if not data:
                break
            writer.write(data)
            await writer.drain()
            if chunked:
                if len(whole) < 8 * 1024 * 1024:
                    whole.extend(data)
                continue
            pending += data
            *complete, pending = pending.split(b'\n')
            for line in complete:
                scan_usage(session, line.rstrip(b'\r'))
        if chunked and counting:
            start, end = whole.find(b'{'), whole.rfind(b'}')
            try:
                count_usage(session, json.loads(bytes(whole[start:end + 1])).get('usage'))
            except ValueError:
                pass
    except (asyncio.TimeoutError, ConnectionError, OSError):
        pass
    finally:
        # Count what was seen even when the stream broke: the model has already charged for it.
        if counting:
            for key, value in session['current'].items():
                session[key] += value
        session.pop('current', None)
        for stream in (upstream_writer, writer):
            try:
                stream.close()
            except Exception:
                pass


def relay_command(message):
    action = message.get('action')
    if action == 'open':
        upstream = urlsplit(message['upstream'])
        if upstream.scheme != 'https' and not ALLOW_HTTP:
            return {'error': 'The model provider must use https'}
        key = token_key(message['token'])
        sessions[key] = {'token': key, 'key': message['key'], 'upstream': message['upstream'], 'budget': int(message['budget']), 'expiresAt': time.time() + int(message['seconds']),
            'calls': 0, 'input': 0, 'output': 0, 'cacheWrite': 0, 'cacheRead': 0, 'refused': 0}
        log('relay-open', urlsplit(message['upstream']).hostname or '', RELAY_PORT)
        return {'opened': True}
    session = sessions.get(token_key(message.get('token', '')))
    if action == 'status':
        return session_view(session) if session else {'error': 'unknown session'}
    if action == 'close':
        sessions.pop(token_key(message.get('token', '')), None)
        log('relay-close', 'relay', RELAY_PORT)
        return session_view(session) if session else {'closed': True}
    return {'error': 'unknown action'}


async def relay_control(reader, writer):
    try:
        raw = await asyncio.wait_for(reader.read(64 * 1024), 5)
        answer = relay_command(json.loads(raw))
    except Exception:
        answer = {'error': 'bad request'}
    writer.write(json.dumps(answer).encode())
    await writer.drain()
    writer.close()


def forward_to(target, port):
    """Inbound only: a preview visitor reaches one configured port of the Run's container, and nothing else."""
    async def forward(reader, writer):
        try:
            upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(target, port), 10)
        except Exception:
            log('error', target, port, 'preview target not listening')
            writer.close()
            return
        await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))
    return forward


async def main():
    server = await asyncio.start_server(handle, '0.0.0.0', PORT, limit=MAX_HEADER)
    target = os.environ.get('AEEIS_PREVIEW_TARGET', '')
    ports = [int(port) for port in os.environ.get('AEEIS_PREVIEW_PORTS', '').split(',') if port]
    previews = [await asyncio.start_server(forward_to(target, port), '0.0.0.0', port) for port in ports]
    relays = []
    if os.environ.get('AEEIS_RELAY') == '1':
        relays = [await asyncio.start_server(relay, '0.0.0.0', RELAY_PORT, limit=MAX_HEADER), await asyncio.start_unix_server(relay_control, RELAY_SOCKET)]
    log('ready', ','.join(ALLOWED) or '(none)', PORT)
    async with server:
        await asyncio.gather(server.serve_forever(), *[item.serve_forever() for item in [*previews, *relays]])


if __name__ == '__main__':
    asyncio.run(main())
