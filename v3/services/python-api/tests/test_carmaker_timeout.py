import socket
from unittest.mock import Mock

import pytest

from app.services.carmaker import CarMakerClient


def test_timeout_closes_socket_before_another_command_can_consume_late_reply(monkeypatch):
    monkeypatch.setattr('app.services.carmaker_protocol.select.select', lambda *args: ([], [], []))
    connection = Mock()
    connection.recv.side_effect = socket.timeout()
    client = CarMakerClient()
    client.socket = connection
    client.connected = True

    with pytest.raises(RuntimeError, match="timeout"):
        client.send_command("DVARead Car.v")

    assert not client.connected
    assert client.socket is None
    connection.close.assert_called_once()
    with pytest.raises(RuntimeError, match="Not connected"):
        client.send_command("DVAWrite DM.Brake 1 2000 Abs")
    connection.sendall.assert_called_once()
