import json

import pytest

from engine.arms import is_active, register_arm, retire_arm
from engine.schemas import Condition, ScreenSpec, SelectionPoint, Stop


def _spec():
    return ScreenSpec(spec_version=4, structure="literal", timeframe="1W", selection_point=None,
                       conditions=[], stop=None, risk_cap_pct=None, near_miss=None)


def _literal_spec_with_selection_point():
    # Same shape as tests/engine/test_screen_literal.py's _literal_spec() (corrected "8W"
    # window for C2), plus a selection_point -- select_candidates() only ever moves a
    # full_match candidate into "entered" when a selection_point lets resolve_ep find a
    # real price, so the no-selection-point _spec() above (used by the pure-registry tests)
    # can't exercise the /select write path at all.
    return ScreenSpec(
        spec_version=4, structure="literal", timeframe="1W",
        selection_point=SelectionPoint(session_of_week=1, at="open"),
        conditions=[
            Condition(id="C1", role="filter", kind="field", name="mcap_cr", op="between", value=[10000, 50000]),
            Condition(id="C2", role="filter", kind="field", name="traded_value_cr",
                      params={"window": "8W"}, op=">=", value=10),
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long"),
            Condition(id="C4", role="filter", kind="indicator", name="rsi",
                      params={"length": 14}, op="between", value=[50, 65]),
        ],
        stop=Stop(**{"from": "C3"}), risk_cap_pct=None, near_miss=None,
    )


# Verified directly against literal_env's offline cache (data_cache_literal/) to produce
# >=1 full_match candidate that resolves to "entered" under the spec above (session_of_week=1
# selection point needs a next-week bar to resolve EP from, so it can't be the cache's latest
# date) -- see the task-12-report.md fix entry for how this was found.
_AS_OF_WITH_ENTERED_PICKS = "2026-09-07"


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


# --- End-to-end: does POST /select's persistence gate actually control write_record()? ---
# The tests above only unit-test engine.arms directly and check the /arms/* routes return
# 200 -- none of them call /select itself, so none prove the gate in engine/app.py's select()
# route (`run_kind != "dry_run" and prompt_id is not None and is_active(prompt_id)`) is wired
# to the real write. These do, through the actual HTTP route via the `client` fixture.


@pytest.fixture(autouse=True)
def _isolated_forward_record_dir(tmp_path, monkeypatch):
    # Mirrors tests/engine/test_forward_record.py's own isolation of OUT_DIR -- without this,
    # a "live" /select call below would write a real file into results/prompt_arms/ in this
    # worktree.
    monkeypatch.setattr("engine.forward_record.OUT_DIR", tmp_path / "prompt_arms")


def _picks_path(prompt_id: int):
    from engine.forward_record import OUT_DIR
    return OUT_DIR / f"picks_{prompt_id}_{_AS_OF_WITH_ENTERED_PICKS}.json"


def test_select_writes_a_record_for_an_active_arm_with_run_kind_live(client):
    spec = _literal_spec_with_selection_point().model_dump(by_alias=True)
    reg = client.post("/arms/register", json={"prompt_id": 101, "spec": spec})
    assert reg.status_code == 200

    resp = client.post("/select", json={
        "spec": spec, "as_of": _AS_OF_WITH_ENTERED_PICKS, "prompt_id": 101, "run_kind": "live",
    })
    assert resp.status_code == 200
    assert resp.json()["entered"], "fixture as_of must produce >=1 entered candidate for this test to be meaningful"
    assert _picks_path(101).exists()


def test_select_does_not_write_for_a_never_registered_prompt_id(client):
    spec = _literal_spec_with_selection_point().model_dump(by_alias=True)

    resp = client.post("/select", json={
        "spec": spec, "as_of": _AS_OF_WITH_ENTERED_PICKS, "prompt_id": 202, "run_kind": "live",
    })
    assert resp.status_code == 200
    assert resp.json()["entered"]
    assert not _picks_path(202).exists()


def test_select_does_not_write_for_a_retired_arm(client):
    spec = _literal_spec_with_selection_point().model_dump(by_alias=True)
    client.post("/arms/register", json={"prompt_id": 303, "spec": spec})
    client.post("/arms/303/retire")

    resp = client.post("/select", json={
        "spec": spec, "as_of": _AS_OF_WITH_ENTERED_PICKS, "prompt_id": 303, "run_kind": "live",
    })
    assert resp.status_code == 200
    assert resp.json()["entered"]
    assert not _picks_path(303).exists()


def test_select_does_not_write_when_run_kind_omitted_defaults_to_dry_run(client):
    spec = _literal_spec_with_selection_point().model_dump(by_alias=True)
    client.post("/arms/register", json={"prompt_id": 404, "spec": spec})

    resp = client.post("/select", json={
        "spec": spec, "as_of": _AS_OF_WITH_ENTERED_PICKS, "prompt_id": 404,
    })
    assert resp.status_code == 200
    assert resp.json()["entered"]
    assert not _picks_path(404).exists()
