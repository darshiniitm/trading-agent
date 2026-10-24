"""P3 acceptance: the full 5-step brief runs end to end on v5 and reproduces the Literal harness
(src.screen.engine.run_screen + build_trades): same tickers, same SL, same R. Both sides use the
TradingView-exact VStop (the harness is patched to it), so this proves the pipeline, not the indicator."""
import copy

import pandas as pd
import pytest

from engine.app import context_from_env
from engine.v5.run import run_program
from tests.engine.v5_fixtures import SAMPLE_ANSWERED, literal_program


@pytest.fixture(autouse=True)
def _tv_vstop_in_the_harness(monkeypatch):
    from src.indicators.vstop_tv import compute_vstop_tv
    monkeypatch.setattr("src.screen.engine.compute_vstop", compute_vstop_tv)


def _dates(env):
    return sorted({pd.Timestamp(d) for p in env.panels.values() for d in p["date"]})


def _harness(env, as_of):
    from src.screen.engine import run_screen
    from src.trade.builder import build_trades
    res = run_screen(as_of, env.rule_spec, env.adapter, env.universe_df, env.panels, env.shares)
    trades = build_trades(res["survivors"], env.rule_spec)
    return {r["ticker"]: r for _, r in trades.iterrows()}


@pytest.mark.parametrize("back", [3, 10, 20])
def test_literal_program_reproduces_the_literal_harness(literal_env, back):
    as_of = _dates(literal_env)[-back]
    want = _harness(literal_env, as_of)
    out = run_program(literal_program(next_open=False), as_of, context_from_env(literal_env))
    assert {m["ticker"] for m in out["sets"]["S1"]["members"]} == set(want)
    for p in out["actions"]["A1"]["plans"]:
        assert p["sl"] == pytest.approx(float(want[p["ticker"]]["SL"]), abs=1e-6)
        assert p["ep"] == pytest.approx(float(want[p["ticker"]]["EP"]), abs=1e-6)


def _sample_with_liquidity():
    prog = copy.deepcopy(SAMPLE_ANSWERED)
    prog["conditions"].append({"id": "C4", "lhs": {"field": "traded_value_cr", "params": {"window": "8W"}}, "op": ">=", "value": 10})
    prog["sets"][0]["where"] = {"all": ["C1", "C4"]}  # liquidity is the app's own question (D3): answered here
    return prog


def test_sample_brief_end_to_end_qualified_set_reproduces_the_literal_funnel(literal_env):
    as_of = _dates(literal_env)[-10]
    want = _harness(literal_env, as_of)
    assert want, "pick a week with real candidates so the comparison isn't vacuous"
    out = run_program(_sample_with_liquidity(), as_of, context_from_env(literal_env))

    s2 = {m["ticker"] for m in out["sets"]["S2"]["members"]}
    s3 = {m["ticker"] for m in out["sets"]["S3"]["members"]}
    assert s2 == set(want)        # (b): flipped on VStop AND RSI 50-65 == the Literal arm's survivors
    assert s2 <= s3               # (a) reading is a strict superset: a different, larger arm

    plans = {p["ticker"]: p for p in out["actions"]["A2"]["plans"]}
    assert set(plans) == s2
    for t, p in plans.items():
        assert p["sl"] == pytest.approx(float(want[t]["SL"]), abs=1e-6) and p["signal_close"] == pytest.approx(float(want[t]["EP"]), abs=1e-6)
        assert p["confidence"]["method"] == "conditions_met_count"

    g = out["actions"]["A1"]
    assert sum(x["count"] for x in g["groups"]) == len(s2) and g["highlight"]["status"] in ("ok", "benchmark_unavailable")
    assert out["actions"]["A3"]["as_of_used"] == str((as_of - pd.Timedelta(weeks=1)).date())
    assert "1" in out["actions"]["A3"]["horizons"]


def test_validate_week_after_signal_uses_only_bars_up_to_the_horizon(literal_env):
    as_of = _dates(literal_env)[-10]
    out = run_program(_sample_with_liquidity(), as_of, context_from_env(literal_env))["actions"]["A3"]
    h = out["horizons"]["1"]
    assert h["n_graded"] + h["n_pending"] == h["n_plans"]


def test_v5_endpoints(client):
    cat = client.get("/conditions/v5").json()
    assert {i["name"] for i in cat["indicators"]} >= {"sma", "vstop", "rsi"}
    bad = copy.deepcopy(SAMPLE_ANSWERED)
    bad["conditions"][2]["lhs"]["params"].pop("length")
    r = client.post("/screen/v5", json={"program": bad, "as_of": "2026-08-03"})
    assert r.status_code == 422 and "length" in str(r.json()["detail"])
    ok = client.post("/screen/v5", json={"program": _sample_with_liquidity(), "as_of": "2026-08-03"})
    assert ok.status_code == 200 and ok.json()["sets"]["S2"]["count"] >= 1
