"""Deterministic transport doubles: no listening ports or real connections."""

import importlib
import socket
from pathlib import Path

import pytest

from app.services.carmaker import CarMakerClient


class FakeSocket:
    def __init__(self, chunks, *, send_error=None, on_recv=None):
        self.chunks = iter(chunks)
        self.send_error = send_error
        self.on_recv = on_recv
        self.sent = []
        self.closed = False

    def connect(self, address):
        pass

    def settimeout(self, timeout):
        assert timeout > 0

    def sendall(self, payload):
        self.sent.append(payload)
        if self.send_error:
            raise self.send_error

    def recv(self, size):
        if self.on_recv:
            self.on_recv()
        chunk = next(self.chunks, b'')
        if isinstance(chunk, Exception):
            raise chunk
        return chunk

    def close(self):
        self.closed = True


@pytest.fixture(params=['backend', 'direct'])
def transport(request, monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[4] / 'workspace/carmaker_llm_scenario_skill/agent'))
    runtime = importlib.import_module('carmaker_runtime')
    protocol = importlib.import_module(
        'app.services.carmaker_protocol' if request.param == 'backend' else 'carmaker_protocol'
    )
    monkeypatch.setattr(protocol.select, 'select', lambda *args: ([], [], []))
    connections = []
    monkeypatch.setattr(socket, 'socket', lambda *args: connections.pop(0))

    def create(*sockets):
        connections.extend(sockets)
        if request.param == 'backend':
            client = CarMakerClient()
            client.connect()
            return client, client.execute_command
        client = runtime.DirectCarMakerCommandClient('fake', 1, timeout_seconds=2.0)
        return client, client.command

    return request.param, protocol, create


def test_every_byte_split_preserves_utf8_status_and_terminator(transport):
    _, _, create = transport
    payload = 'O응답\r\nOsecond\r\n\r\n'.encode()
    for split in range(1, len(payload)):
        connection = FakeSocket([payload[:split], payload[split:]])
        client, command = create(connection)
        try:
            assert command('GetValue') == 'O응답\nsecond'
            assert connection.sent == [b'GetValue\n']
        finally:
            if isinstance(client, CarMakerClient):
                client.disconnect()


@pytest.mark.parametrize('elapsed', [2.0, 2.1])
@pytest.mark.parametrize('chunks', [[b'Odone\r\n\r\n'], [b'Odone\r\n', b'\r\n'], [b'\r\n']])
def test_reply_completed_at_or_after_deadline_is_not_success(transport, monkeypatch, elapsed, chunks):
    _, protocol, create = transport
    now = [0.0]
    count = [0]
    monkeypatch.setattr(protocol.time, 'monotonic', lambda: now[0])

    def finish_recv():
        count[0] += 1
        if count[0] == len(chunks):
            now[0] = elapsed

    connection = FakeSocket(chunks, on_recv=finish_recv)
    client, command = create(connection)
    with pytest.raises(RuntimeError):
        command('StopSim')
    assert connection.closed
    if isinstance(client, CarMakerClient):
        assert not client.connected
        with pytest.raises(RuntimeError, match='Not connected'):
            command('StartSim')
    assert connection.sent == [b'StopSim\n']


@pytest.mark.parametrize('chunks,send_error', [
    ([b'Opartial\r\n', socket.timeout()], None),
    ([b'Opartial\r\n', ConnectionResetError('reset')], None),
    ([b'Opartial\r\n'], None),
    ([b'Odone\r\n\r\nextra'], None),
    ([b'Odone\r\nEerror\r\n\r\n'], None),
    ([b'O\xff\r\n\r\n'], None),
    ([], BrokenPipeError('partial send')),
])
def test_transport_failure_never_retries_command_on_failed_socket(transport, chunks, send_error):
    kind, _, create = transport
    failed = FakeSocket(chunks, send_error=send_error)
    fresh = FakeSocket([b'Oretry\r\n\r\n'])
    client, command = create(failed, fresh)
    with pytest.raises(RuntimeError):
        command('StopSim')
    assert failed.closed
    assert failed.sent == [b'StopSim\n']
    assert fresh.sent == []  # No implicit retry of an ambiguously executed command.
    if kind == 'backend':
        with pytest.raises(RuntimeError, match='Not connected'):
            command('StopSim')
        client.connect()
    assert command('StopSim') == 'Oretry'
    assert fresh.sent == [b'StopSim\n']
    if kind == 'backend':
        client.disconnect()


def test_complete_command_error_allows_explicit_retry_without_stale_reply(transport):
    kind, _, create = transport
    rejected = FakeSocket([b'Erejected\r', b'\n\r\n'])
    if kind == 'backend':
        rejected.chunks = iter([b'Erejected\r', b'\n\r\n', b'Oretry\r\n\r\n'])
        client, command = create(rejected)
    else:
        client, command = create(rejected, FakeSocket([b'Oretry\r\n\r\n']))
    with pytest.raises(RuntimeError, match='CarMaker error: Erejected'):
        command('StopSim')
    assert rejected.sent == [b'StopSim\n']
    assert command('StopSim') == 'Oretry'
    if kind == 'backend':
        assert client.connected
        client.disconnect()
