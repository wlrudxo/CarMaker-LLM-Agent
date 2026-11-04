from unittest.mock import Mock

import pytest

from app.services.triggers import TriggerService


@pytest.fixture
def service(tmp_path):
    return TriggerService(tmp_path / "triggers.json", Mock(), Mock())


@pytest.mark.parametrize("expression,data", [
    ("Traffic.T00.LongVel < 5", {"Car.v": 10.0}),
    ("Car.v == 0", {}),
    ("Car.v > 1 || Traffic.T00.LongVel < 5", {"Car.v": 10.0}),
    ("Car.v != 0", {"Car.v": float("nan")}),
    ("Car.v > 1", {"Car.v": float("inf")}),
    ("Car.v < 1", {"Car.v": float("-inf")}),
])
def test_unavailable_or_nonfinite_telemetry_never_fires(service, expression, data):
    assert service._evaluate_expression(expression, data) is False


@pytest.mark.parametrize("expression,data,expected", [
    ("Car.v == 0", {"Car.v": 0.0}, True),
    ("Car.v > 1 && abs(Vhcl.tRoad) < 2", {"Car.v": 10.0, "Vhcl.tRoad": -1.0}, True),
    ("Car.v < 1", {"Car.v": 10.0}, False),
])
def test_valid_telemetry_keeps_existing_expression_behavior(service, expression, data, expected):
    assert service._evaluate_expression(expression, data) is expected
