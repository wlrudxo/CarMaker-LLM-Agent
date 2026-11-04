"""CarMaker 15.0.1 Programmer's Guide 26.1.2: CRLF lines + empty CRLF terminator."""

import select
import socket
import time


def exchange(sock: socket.socket, command: str, timeout: float) -> str:
    # No pipelining: bytes awaiting a new request cannot belong to its reply.
    if not command.strip() or command.lstrip().startswith('!') or '\n' in command or '\r' in command:
        raise RuntimeError('Expected one CarMaker command with a result message')
    if select.select([sock], [], [], 0)[0]:
        raise RuntimeError('Unexpected pending CarMaker response; reconnect required')
    deadline = time.monotonic() + timeout
    sock.settimeout(timeout)
    sock.sendall(f'{command}\n'.encode('utf-8'))
    buffer = b''
    lines = []
    status = None
    received = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout()
        sock.settimeout(remaining)
        chunk = sock.recv(32768)
        if time.monotonic() >= deadline:
            raise socket.timeout()
        if not chunk:
            raise RuntimeError('Connection closed before complete CarMaker result')
        received += len(chunk)
        if received > 1024 * 1024:
            raise RuntimeError('CarMaker result exceeds 1 MiB')
        buffer += chunk
        while b'\r\n' in buffer:
            line, buffer = buffer.split(b'\r\n', 1)
            if not line:
                if buffer:
                    raise RuntimeError('Unexpected trailing CarMaker response; reconnect required')
                # An empty result (CRLF alone) is a documented successful command.
                return (status or 'O') + '\n'.join(lines)
            if line[:1] not in (b'O', b'E'):
                raise RuntimeError('Invalid CarMaker result status')
            code = line[:1].decode('ascii')
            if status is not None and status != code:
                raise RuntimeError('Inconsistent CarMaker result status')
            status = code
            try:
                lines.append(line[1:].decode('utf-8'))
            except UnicodeDecodeError as exc:
                raise RuntimeError('Invalid CarMaker result encoding') from exc
