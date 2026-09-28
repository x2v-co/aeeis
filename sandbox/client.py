"""Bounded Docker exec transport; no TCP management endpoint is exposed."""
import socket
import sys

with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(620)
    connection.connect('/run/aeeis.sock')
    connection.sendall(sys.stdin.buffer.read(48 * 1024 * 1024 + 1))
    connection.shutdown(socket.SHUT_WR)
    while True:
        data = connection.recv(65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
