from engine.schemas import Condition, ScreenSpec, SelectionPoint, Stop
from engine.structures import applied_steps, structures_payload


def _spec(**overrides):
    base = dict(
        spec_version=4, structure="literal", timeframe="1W",
        selection_point=None, conditions=[], stop=None, risk_cap_pct=None, near_miss=None,
    )
    base.update(overrides)
    return ScreenSpec(**base)


def test_structures_payload_lists_literal_and_t1_literal():
    names = {s["structure"] for s in structures_payload()}
    assert names == {"literal", "t1_literal"}


def test_applied_steps_no_event_condition_means_no_recheck():
    spec = _spec()
    steps = {s["step"]: s["applied"] for s in applied_steps(spec)}
    assert steps["event_recheck_at_selection_point"] is False
    assert steps["ep_at_selection_point"] is False
    assert steps["sl_from_stop"] is False


def test_applied_steps_with_event_and_selection_point_and_stop():
    spec = _spec(
        selection_point=SelectionPoint(session_of_week=1, at="open"),
        conditions=[Condition(id="C3", role="event", kind="indicator", name="vstop",
                               params={"length": 10, "mult": 2.0, "source": "close"},
                               op="flip", dir="long")],
        stop=Stop(**{"from": "C3"}),
    )
    steps = {s["step"]: s["applied"] for s in applied_steps(spec)}
    assert steps["event_recheck_at_selection_point"] is True
    assert steps["ep_at_selection_point"] is True
    assert steps["sl_from_stop"] is True
    assert steps["risk_cap_rejection"] is False


def test_get_structures_endpoint(client):
    resp = client.get("/structures")
    assert resp.status_code == 200
    assert len(resp.json()) == 2
