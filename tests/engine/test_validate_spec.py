from engine.schemas import Condition, ScreenSpec, SelectionPoint, Stop
from engine.validate_spec import validate_spec


def _spec(conditions, stop=None, selection_point=None, structure="literal", t1_window=None):
    return ScreenSpec(
        spec_version=4, structure=structure, timeframe="1W",
        selection_point=selection_point, conditions=conditions,
        stop=stop, risk_cap_pct=None, near_miss=None, t1_window=t1_window,
    )


def test_unsupported_condition_name_is_flagged():
    spec = _spec([Condition(id="C9", role="filter", kind="indicator", name="macd",
                             params={}, op="cross", value=None)])
    errors = validate_spec(spec)
    assert any(e.condition_id == "C9" and "unsupported" in e.message for e in errors)


def test_missing_required_param_is_flagged():
    spec = _spec([Condition(id="C3", role="event", kind="indicator", name="vstop",
                             params={"length": 10}, op="flip", dir="long")])  # missing mult, source
    errors = validate_spec(spec)
    msgs = [e.message for e in errors if e.condition_id == "C3"]
    assert any("mult" in m for m in msgs)
    assert any("source" in m for m in msgs)


def test_out_of_range_param_is_flagged():
    spec = _spec([Condition(id="C4", role="filter", kind="indicator", name="rsi",
                             params={"length": 500}, op="between", value=[50, 65])])
    errors = validate_spec(spec)
    assert any(e.condition_id == "C4" for e in errors)


def test_valid_spec_has_no_errors():
    spec = _spec(
        [
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long"),
            Condition(id="C4", role="filter", kind="indicator", name="rsi",
                      params={"length": 14}, op="between", value=[50, 65]),
        ],
        stop=Stop(**{"from": "C3"}),
        selection_point=SelectionPoint(session_of_week=1, at="open"),
    )
    assert validate_spec(spec) == []


def test_stop_must_reference_a_vstop_condition():
    spec = _spec(
        [Condition(id="C4", role="filter", kind="indicator", name="rsi",
                   params={"length": 14}, op="between", value=[50, 65])],
        stop=Stop(**{"from": "C4"}),
    )
    errors = validate_spec(spec)
    assert any("stop" in e.message and "vstop" in e.message for e in errors)


def test_t1_literal_requires_t1_window_when_event_condition_present():
    spec = _spec(
        [Condition(id="C3", role="event", kind="indicator", name="vstop",
                   params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long")],
        structure="t1_literal", t1_window=None,
    )
    errors = validate_spec(spec)
    assert any(e.condition_id is None and "t1_window" in e.message for e in errors)
