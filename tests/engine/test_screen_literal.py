import pandas as pd

from engine.schemas import Condition, ScreenSpec, Stop
from engine.screen import run_screen_spec


def _literal_spec():
    return ScreenSpec(
        spec_version=4, structure="literal", timeframe="1W", selection_point=None,
        conditions=[
            Condition(id="C1", role="filter", kind="field", name="mcap_cr", op="between", value=[10000, 50000]),
            Condition(id="C2", role="filter", kind="field", name="traded_value_cr",
                      params={"window": "1W"}, op=">=", value=10),
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long"),
            Condition(id="C4", role="filter", kind="indicator", name="rsi",
                      params={"length": 14}, op="between", value=[50, 65]),
        ],
        stop=Stop(**{"from": "C3"}), risk_cap_pct=None, near_miss=None,
    )


def test_screen_literal_matches_run_screen_survivors(literal_env):
    from src.screen.engine import run_screen
    as_of = sorted({pd.Timestamp(d) for p in literal_env.panels.values() for d in p["date"]})[-1]

    engine_result = run_screen_spec(_literal_spec(), as_of, literal_env)
    control_result = run_screen(as_of, literal_env.rule_spec, literal_env.adapter,
                                 literal_env.universe_df, literal_env.panels, literal_env.shares)

    engine_tickers = {c["ticker"] for c in engine_result["candidates"] if c["membership"] == "full_match"}
    control_tickers = set(control_result["survivors"]["ticker"]) if not control_result["survivors"].empty else set()
    assert engine_tickers == control_tickers


def test_screen_without_stop_leaves_sl_and_r_null(literal_env):
    # §2.1: "If it doesn't state a stop, stop is null and risk/R show as '—'."
    spec = _literal_spec().model_copy(update={"stop": None})
    as_of = sorted({pd.Timestamp(d) for p in literal_env.panels.values() for d in p["date"]})[-1]
    result = run_screen_spec(spec, as_of, literal_env)
    assert len(result["candidates"]) > 0
    for cand in result["candidates"]:
        assert cand["sl"] is None
        assert cand["r"] is None


def test_screen_literal_empty_universe_does_not_crash():
    from engine.env import Environment
    empty_env = Environment(
        rule_spec={"data": {"history_weeks": 260}}, adapter=None,
        universe_df=pd.DataFrame(columns=["ticker", "name", "sector"]),
        panels={}, shares={}, daily_panels={},
    )
    result = run_screen_spec(_literal_spec(), pd.Timestamp("2026-01-05"), empty_env)
    assert result["candidates"] == []


def test_screen_rejects_spec_with_missing_required_param():
    import pytest
    bad = ScreenSpec(
        spec_version=4, structure="literal", timeframe="1W", selection_point=None,
        conditions=[Condition(id="C3", role="event", kind="indicator", name="vstop",
                               params={"length": 10}, op="flip", dir="long")],  # missing mult, source
        stop=Stop(**{"from": "C3"}), risk_cap_pct=None, near_miss=None,
    )
    from engine.screen import ScreenSpecError
    with pytest.raises(ScreenSpecError):
        run_screen_spec(bad, pd.Timestamp("2026-01-05"), None)


def test_screen_endpoint(client):
    body = {
        "spec": _literal_spec().model_dump(by_alias=True),
        "as_of": "2026-01-05",
    }
    resp = client.post("/screen", json=body)
    assert resp.status_code == 200
    assert "candidates" in resp.json()


def test_screen_endpoint_422_on_invalid_spec(client):
    spec = _literal_spec().model_dump(by_alias=True)
    del spec["conditions"][2]["params"]["mult"]
    resp = client.post("/screen", json={"spec": spec, "as_of": "2026-01-05"})
    assert resp.status_code == 422
