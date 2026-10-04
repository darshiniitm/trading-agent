import json

import pytest

from engine.arms import is_active, register_arm, retire_arm
from engine.schemas import ScreenSpec


def _spec():
    return ScreenSpec(spec_version=4, structure="literal", timeframe="1W", selection_point=None,
                       conditions=[], stop=None, risk_cap_pct=None, near_miss=None)


@pytest.fixture(autouse=True)
def _isolated_registry(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.arms.REGISTRY_PATH", tmp_path / "registry.json")


def test_newly_registered_arm_is_active():
    register_arm(prompt_id=12, spec=_spec())
    assert is_active(12) is True


def test_unregistered_arm_is_not_active():
    assert is_active(999) is False


def test_retired_arm_is_no_longer_active_but_registry_keeps_it():
    register_arm(prompt_id=12, spec=_spec())
    retire_arm(12)
    assert is_active(12) is False
    from engine.arms import REGISTRY_PATH
    body = json.loads(REGISTRY_PATH.read_text())
    assert "12" in body
    assert body["12"]["status"] == "retired"


def test_register_endpoint_and_retire_endpoint(client):
    spec = _spec().model_dump(by_alias=True)
    resp = client.post("/arms/register", json={"prompt_id": 7, "spec": spec})
    assert resp.status_code == 200
    resp2 = client.post("/arms/7/retire")
    assert resp2.status_code == 200
