import pytest

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


# --- Fix 3: a non-vstop event condition must be rejected at validation time ------------

def test_event_condition_on_non_vstop_indicator_is_rejected():
    # Before Fix 3 this passed validate_spec with zero errors, then crashed downstream
    # (engine/screen.py and engine/selection.py both assume an event condition's computed
    # value is a dict with an "uptrend" key, which is only true for vstop) -- confirmed
    # by actually running this spec through run_screen_spec before applying the fix.
    spec = _spec(
        [Condition(id="C9", role="event", kind="indicator", name="rsi",
                   params={"length": 14}, op="between", value=[50, 65])],
    )
    errors = validate_spec(spec)
    assert any(e.condition_id == "C9" and "event" in e.message and "vstop" in e.message for e in errors)


# --- Fix 4a: requires_value is declared in the catalog but was never enforced ----------

def test_requires_value_op_with_value_none_is_rejected():
    spec = _spec(
        [Condition(id="C1", role="filter", kind="field", name="traded_value_cr",
                   params={"window": "8W"}, op=">=", value=None)],
    )
    errors = validate_spec(spec)
    assert any(e.condition_id == "C1" for e in errors)


def test_requires_value_between_op_with_wrong_shape_is_rejected():
    spec = _spec(
        [Condition(id="C1", role="filter", kind="field", name="mcap_cr",
                   params={}, op="between", value=100)],  # not a [min, max] pair
    )
    errors = validate_spec(spec)
    assert any(e.condition_id == "C1" for e in errors)


# --- Fix 4b: `dir` is never validated for flip ops -------------------------------------

def test_flip_op_with_dir_none_is_rejected():
    # Before Fix 4b this passed validation and silently produced ZERO full_match
    # candidates with no error (evaluate.py's `passed = ... if cond.dir == "long" else
    # False`) -- confirmed directly against run_screen_spec before applying the fix.
    spec = _spec(
        [Condition(id="C3", role="event", kind="indicator", name="vstop",
                   params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir=None)],
    )
    errors = validate_spec(spec)
    assert any(e.condition_id == "C3" and "flip" in e.message and "dir" in e.message for e in errors)


# --- Fix 4c: week_window_str must match a strict pattern -------------------------------

@pytest.mark.parametrize("bad_window", ["abc", "8M", "", "0W"])
def test_malformed_week_window_is_rejected(bad_window):
    # Before Fix 4c, "abc"/"8M"/"" crashed int() parsing downstream (ValueError, an
    # unhandled 500), and "0W" silently produced 0 candidates with no error -- both
    # confirmed directly against run_screen_spec before applying the fix.
    spec = _spec(
        [Condition(id="C1", role="filter", kind="field", name="traded_value_cr",
                   params={"window": bad_window}, op=">=", value=5.0)],
    )
    errors = validate_spec(spec)
    assert any(e.condition_id == "C1" for e in errors)


def test_valid_week_window_is_not_rejected():
    spec = _spec(
        [Condition(id="C1", role="filter", kind="field", name="traded_value_cr",
                   params={"window": "8W"}, op=">=", value=5.0)],
    )
    assert validate_spec(spec) == []


# --- Fix 4d: a type-mismatched param must raise a SpecError, not a bare TypeError ------

def test_wrong_type_param_is_rejected_not_a_crash():
    # Before Fix 4d, `p["min"] <= val <= p["max"]` raised TypeError directly out of
    # validate_spec (a string is not orderable against an int) -- confirmed directly
    # before applying the fix. The type check must run first and turn this into a
    # SpecError instead of letting the comparison raise.
    spec = _spec(
        [Condition(id="C3", role="event", kind="indicator", name="vstop",
                   params={"length": "ten", "mult": 2.0, "source": "close"}, op="flip", dir="long")],
    )
    errors = validate_spec(spec)
    assert any(e.condition_id == "C3" and "type" in e.message for e in errors)
