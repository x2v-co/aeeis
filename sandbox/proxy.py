"""Outbound proxy for one Run: only allowlisted hosts, only public addresses.

The Run container sits on an internal Docker network with no route out; this proxy is
its only way to the internet. HTTPS goes through CONNECT to port 443; plain HTTP
(apt mirrors) is forwarded for port 80. Every decision is logged as one JSON line.
"""
import asyncio
import ipaddress
import json
import os
import socket
import sys
import time

ALLOWED = [host.strip().lower() for host in os.environ.get('AEEIS_EGRESS_HOSTS', '').split(',') if host.strip()]
PORT = int(os.environ.get('AEEIS_PROXY_PORT', '3128'))
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
    log('ready', ','.join(ALLOWED) or '(none)', PORT)
    async with server:
        await asyncio.gather(server.serve_forever(), *[preview.serve_forever() for preview in previews])


if __name__ == '__main__':
    asyncio.run(main())
