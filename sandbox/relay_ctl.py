"""Control channel for the model relay: one JSON request on stdin, one JSON answer on stdout. The real API key
arrives this way, so it is never in a command line, a container's environment or Docker's records."""
import socket
import sys

with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(10)
    connection.connect('/run/aeeis/relay.sock')
    connection.sendall(sys.stdin.buffer.read(64 * 1024))
    connection.shutdown(socket.SHUT_WR)
    while True:
        data = connection.recv(65536)
        if not data:
            break
        sys.stdout.buffer.write(data)
