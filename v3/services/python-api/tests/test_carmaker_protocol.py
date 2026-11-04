import socket
import threading
import time
from pathlib import Path
from contextlib import contextmanager

import pytest

from app.services.carmaker import CarMakerClient


@contextmanager
def fake_tcp(chunks, factory=CarMakerClient):
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(1)
    errors = []

    def serve():
        try:
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(2)
                conn.recv(4096)
                for chunk in chunks:
                    conn.sendall(chunk)
                    if len(chunks) > 1:
                        time.sleep(.002)
        except OSError as exc:
            errors.append(exc)

    worker = threading.Thread(target=serve)
    worker.start()
    client = factory(*listener.getsockname())
    if isinstance(client, CarMakerClient):
        client.connect()
    try:
        yield client
    finally:
        if isinstance(client, CarMakerClient):
            client.disconnect()
        listener.close()
        worker.join(3)
        assert not worker.is_alive()


def test_fragmented_multiline_and_empty_results():
    with fake_tcp([b'O12\r', b'\nO34\r\n', b'\r', b'\n']) as client:
        assert client.read_values_batch(['Car.v', 'Time']) == {'Car.v': 12, 'Time': 34}
    with fake_tcp([b'\r', b'\n']) as client:
        assert client.execute_command('StopSim')


@pytest.mark.parametrize('payload', [b'O12\r\n', b'O12\r\n\r\nO99\r\n\r\n', b'X12\r\n\r\n'])
def test_incomplete_unsolicited_or_invalid_reply_invalidates_connection(payload):
    with fake_tcp([payload]) as client:
        with pytest.raises(RuntimeError):
            client.read_values_batch(['Car.v'])
        assert not client.connected
        with pytest.raises(RuntimeError, match='Not connected'):
            client.execute_command('StartSim')


@pytest.mark.parametrize('payload', [b'O12\r\n\r\n', b'Ebad quantity\r\n\r\n', b'Onan 4\r\n\r\n', b'Ooops 4\r\n\r\n'])
def test_batch_never_returns_partial_or_nonfinite_telemetry(payload):
    with fake_tcp([payload]) as client:
        with pytest.raises(RuntimeError):
            client.read_values_batch(['Car.v', 'Time'])


def test_direct_runner_uses_same_framing_and_rejects_invalid_values(monkeypatch):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[4] / 'workspace/carmaker_llm_scenario_skill/agent'))
    from carmaker_runtime import DirectCarMakerCommandClient, parse_dvaread_response
    with fake_tcp([b'O12\r', b'\nO34\r\n\r', b'\n'], DirectCarMakerCommandClient) as client:
        assert parse_dvaread_response(client.command('DVARead Car.v Time'), ['Car.v', 'Time']) == {'Car.v':12, 'Time':34}
    for response in ['O12', 'Onan 4', 'Oinf 4', 'Oinvalid 4', 'Ebad']:
        with pytest.raises(RuntimeError):
            parse_dvaread_response(response, ['Car.v', 'Time'])


def test_pending_late_response_is_rejected_before_sending_next_command(monkeypatch):
    from unittest.mock import Mock
    connection = Mock()
    client = CarMakerClient()
    client.socket, client.connected = connection, True
    monkeypatch.setattr('app.services.carmaker_protocol.select.select', lambda *args: ([connection], [], []))
    with pytest.raises(RuntimeError, match='pending'):
        client.execute_command('DVAWrite DM.Gas 1 1000 Abs')
    connection.sendall.assert_not_called()
    assert not client.connected
