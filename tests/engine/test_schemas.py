import pytest
from pydantic import ValidationError

from engine.schemas import Condition, ScreenSpec, SelectionPoint, Stop, NearMiss


def test_condition_requires_role_kind_name_op():
    with pytest.raises(ValidationError):
        Condition(id="C1")  # missing role/kind/name/op


def test_condition_rejects_unknown_role():
    with pytest.raises(ValidationError):
        Condition(id="C1", role="nope", kind="field", name="mcap_cr", op="between", value=[1, 2])


def test_screen_spec_minimal_valid():
    spec = ScreenSpec(
        spec_version=4,
        structure="literal",
        timeframe="1W",
        selection_point=SelectionPoint(session_of_week=1, at="open"),
        conditions=[
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"},
                      op="flip", dir="long"),
            Condition(id="C4", role="filter", kind="indicator", name="rsi",
                      params={"length": 14}, op="between", value=[50, 65]),
        ],
        stop=Stop(**{"from": "C3"}),
        risk_cap_pct=None,
        near_miss=None,
    )
    assert spec.structure == "literal"
    assert spec.stop.from_ == "C3"


def test_screen_spec_rejects_unknown_structure():
    with pytest.raises(ValidationError):
        ScreenSpec(
            spec_version=4, structure="control", timeframe="1W",
            selection_point=None, conditions=[], stop=None, risk_cap_pct=None, near_miss=None,
        )
