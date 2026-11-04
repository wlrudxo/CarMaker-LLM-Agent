from unittest.mock import Mock

import pytest

from app.services.settings import SettingsService
from app.services.triggers import TriggerService


@pytest.mark.parametrize("store,payload", [
    ("settings", "{broken"),
    ("settings", '{"app": []}'),
    ("triggers", "{broken"),
    ("triggers", '{"triggers": 1}'),
])
def test_unreadable_store_is_preserved_for_recovery(tmp_path, store, payload):
    path = tmp_path / f"{store}.json"
    path.write_text(payload, encoding="utf-8")
    original = path.read_bytes()
    with pytest.raises(RuntimeError, match="preserved"):
        if store == "settings":
            SettingsService(path)
        else:
            TriggerService(path, Mock(), Mock())
    assert path.read_bytes() == original
