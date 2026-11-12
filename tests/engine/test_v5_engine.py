import numpy as np
import pandas as pd
import pytest

from engine.v5.data import resample_monthly, resample_weekly
from engine.v5.evaluator import ProgramError
from engine.v5.program import ScreenProgram
from engine.v5.registry import INDICATORS, check_params, conditions_payload
from engine.v5.run import run_program
from tests.engine.v5_fixtures import daily, ctx_for

AS_OF = pd.Timestamp("2024-06-28")  # a Friday


def prog(conds, where=("C1",), actions=(), universe=None, sets=None):
    return {"program_version": 5, "universe": universe or {"source": "nse_all"},
            "sets": sets or [{"id": "S1", "from": "universe", "where": {"all": list(where)}}],
            "conditions": conds, "actions": list(actions)}


def ind(name, tf="1D", **params):
    return {"ind": name, "params": params, "tf": tf}


# ----------------------------------------------------------------- registry
def test_registry_payload_lists_every_indicator_without_defaults():
    p = conditions_payload()
    names = {i["name"] for i in p["indicators"]}
    assert {"sma", "ema", "rsi", "vstop", "atr", "macd", "supertrend", "bollinger", "volume_avg", "return_n", "dist_52w_high"} <= names
    assert "default" not in str(p)
    assert next(i for i in p["indicators"] if i["name"] == "vstop")["positional_params"] == ["length", "mult"]
    assert INDICATORS["vstop"].can_supply_stop and not INDICATORS["sma"].can_supply_stop


def test_missing_params_are_reported_never_defaulted():
    assert check_params(INDICATORS["rsi"], {}) == ["missing required param 'length'"]
    assert check_params(INDICATORS["sma"], {"length": 6, "source": "close"}) == []
    assert "must be one of" in check_params(INDICATORS["sma"], {"length": 6, "source": "bogus"})[0]


@pytest.mark.parametrize("name,params", [
    ("sma", {"length": 5, "source": "close"}), ("ema", {"length": 5, "source": "close"}),
    ("rsi", {"length": 14}), ("atr", {"length": 10}),
    ("macd", {"fast": 12, "slow": 26, "signal": 9, "source": "close"}),
    ("supertrend", {"length": 10, "mult": 3}), ("bollinger", {"length": 20, "mult": 2, "source": "close"}),
    ("volume_avg", {"length": 5}), ("return_n", {"bars": 5, "source": "close"}),
    ("dist_52w_high", {"lookback": 20}), ("vstop", {"length": 10, "mult": 2, "source": "close"}),
])
def test_every_indicator_computes_a_value_series(name, params):
    closes = 100 + np.cumsum(np.sin(np.arange(120) / 5) * 2 + 0.1)
    out = INDICATORS[name].compute(daily(closes), params)
    assert len(out) == 120 and "value" in out and out["value"].notna().sum() > 50


# ----------------------------------------------------------------- data
def test_weekly_resample_is_monday_labelled_and_monthly_is_month_start():
    d = daily(np.arange(1, 46))
    w = resample_weekly(d)
    assert all(pd.Timestamp(x).weekday() == 0 for x in w["date"])
    assert w["volume"].iloc[0] == 5_000_000
    assert all(pd.Timestamp(x).day == 1 for x in resample_monthly(d)["date"])


def test_in_progress_week_is_not_a_completed_weekly_bar():
    ctx = ctx_for({"A": daily(np.arange(1, 30), start="2024-06-03")})  # data ends Wed 2024-07-10? check below
    last = ctx.daily_panels["A"]["date"].iloc[-1]
    wed = last - pd.Timedelta(days=last.weekday() - 2)
    bars = ctx.bars("A", "1W", min(wed, last))
    assert bars is None or bars["date"].iloc[-1] < (last - pd.Timedelta(days=last.weekday()))


# ----------------------------------------------------------------- ops
def cross_ctx():
    up = np.r_[np.full(40, 100.0), np.linspace(100, 160, 40)]          # SMA6 crosses above SMA30
    down = np.r_[np.linspace(100, 160, 40), np.linspace(160, 90, 40)]  # crosses below later
    flat = np.full(80, 100.0)
    return ctx_for({"UP.NS": daily(up), "DOWN.NS": daily(down), "FLAT.NS": daily(flat)})


def test_sma_cross_both_directions_with_event_date_and_direction():
    c = {"id": "C1", "lhs": ind("sma", length=6, source="close"), "op": "cross_any",
         "rhs": ind("sma", length=30, source="close"), "within_bars": None}
    out = run_program(prog([c], actions=[{"id": "A1", "type": "rank", "set": "S1", "by": [{"key": "C1.event_date", "order": "desc"}]}]),
                      "2023-04-28", cross_ctx())
    members = {m["ticker"]: m["conditions"]["C1"] for m in out["sets"]["S1"]["members"]}
    assert set(members) == {"UP.NS", "DOWN.NS"}
    assert members["UP.NS"]["direction"] == "up"
    rows = out["actions"]["A1"]["rows"]
    dates = [r["C1.event_date"] for r in rows]
    assert dates == sorted(dates, reverse=True)


def test_cross_requires_same_timeframe_and_an_rhs():
    c = {"id": "C1", "lhs": ind("sma", tf="1D", length=6, source="close"), "op": "cross_above",
         "rhs": ind("sma", tf="1W", length=30, source="close")}
    with pytest.raises(ProgramError, match="same timeframe"):
        run_program(prog([c]), AS_OF, cross_ctx())


def test_between_outside_rising_and_scalar_ops():
    closes = np.linspace(100, 140, 80)
    ctx = ctx_for({"A.NS": daily(closes)})
    asof = ctx.daily_panels["A.NS"]["date"].iloc[-1]
    def n(cond):
        return run_program(prog([cond]), asof, ctx)["sets"]["S1"]["count"]
    last = closes[-1]
    assert n({"id": "C1", "lhs": {"field": "price"}, "op": "between", "value": [last - 1, last + 1]}) == 1
    assert n({"id": "C1", "lhs": {"field": "price"}, "op": "outside", "value": [last - 1, last + 1]}) == 0
    assert n({"id": "C1", "lhs": {"field": "price"}, "op": "<", "value": last}) == 0
    assert n({"id": "C1", "lhs": {"field": "price"}, "op": ">=", "value": last}) == 1
    assert n({"id": "C1", "lhs": ind("ema", length=5, source="close"), "op": "rising", "bars": 3}) == 1
    assert n({"id": "C1", "lhs": ind("ema", length=5, source="close"), "op": "falling", "bars": 3}) == 0


def test_warmup_has_no_data_not_a_pass():
    ctx = ctx_for({"A.NS": daily(np.linspace(100, 110, 8))})
    c = {"id": "C1", "lhs": ind("sma", length=30, source="close"), "op": ">", "value": 0}
    assert run_program(prog([c]), ctx.daily_panels["A.NS"]["date"].iloc[-1], ctx)["sets"]["S1"]["count"] == 0


def test_one_sided_cap_is_strictly_less_than():
    ctx = ctx_for({"S.NS": daily(np.full(30, 100.0)), "EDGE.NS": daily(np.full(30, 100.0)), "B.NS": daily(np.full(30, 100.0))})
    ctx.shares.update({"S.NS": 0.9e9, "EDGE.NS": 1e9, "B.NS": 1e12})   # 9,000 / 10,000 / 10,000,000 cr
    asof = ctx.daily_panels["S.NS"]["date"].iloc[-1]
    out = run_program(prog([{"id": "C1", "lhs": {"field": "mcap_cr"}, "op": "<", "value": 10000}]), asof, ctx)
    assert [m["ticker"] for m in out["sets"]["S1"]["members"]] == ["S.NS"]


def test_unanswered_needs_input_blocks_a_screen():
    p = prog([{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 1}])
    p["needs_input"] = [{"path": "conditions.C1.value", "reason": "missing"}]
    with pytest.raises(ProgramError, match="unanswered"):
        run_program(p, AS_OF, cross_ctx())


def test_unknown_keys_and_references_are_rejected():
    with pytest.raises(ValueError):
        ScreenProgram.model_validate({**prog([{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 1}]), "bogus": 1})
    with pytest.raises(ValueError, match="unknown condition"):
        ScreenProgram.model_validate(prog([{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 1}], where=("C9",)))


# ----------------------------------------------------------------- universe
def test_index_universe_uses_the_dated_snapshot_at_or_before_as_of(tmp_path):
    (tmp_path / "nifty_100_2023-01-01.csv").write_text("Company Name,Industry,Symbol\nA,x,UP\n")
    (tmp_path / "nifty_100_2024-01-01.csv").write_text("Company Name,Industry,Symbol\nA,x,UP\nB,x,DOWN\n")
    ctx = cross_ctx(); ctx.index_snapshot_dir = str(tmp_path)
    c = {"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 0}
    u = {"source": "index", "index": "NIFTY 100"}
    early = run_program(prog([c], universe=u), "2023-06-30", ctx)
    late = run_program(prog([c], universe=u), "2024-03-29", ctx)
    assert early["universe"]["count"] == 1 and early["universe"]["snapshot"] == "2023-01-01"
    assert late["universe"]["count"] == 2
    with pytest.raises(ProgramError, match="no snapshot"):
        run_program(prog([c], universe=u), "2022-01-01", ctx)


# ----------------------------------------------------------------- actions
def sample_ctx():
    rng = np.random.default_rng(1)
    panels = {}
    for i, sec in enumerate(["Auto", "Auto", "Bank", "Bank", "IT"]):
        trend = np.r_[np.linspace(100, 80, 150), np.linspace(80, 130, 150)] * (1 + 0.02 * i)
        panels[f"T{i}.NS"] = daily(trend + rng.normal(0, 0.3, 300), start="2022-01-03")
    return ctx_for(panels, {"T0.NS": "Auto", "T1.NS": "Auto", "T2.NS": "Bank", "T3.NS": "Bank", "T4.NS": "IT"})


def vstop_prog(actions):
    return prog([{"id": "C1", "lhs": ind("vstop", tf="1D", length=10, mult=2, source="close"), "op": "flip", "dir": "long", "within_bars": 200},
                 {"id": "C2", "lhs": {"field": "price"}, "op": ">", "value": 0}], where=("C1", "C2"), actions=actions)


def test_trade_plan_ep_sl_and_confidence_methods():
    ctx = sample_ctx()
    asof = ctx.daily_panels["T0.NS"]["date"].iloc[-1]
    for method, extra in [("conditions_met_count", {}), ("historical_hit_rate", {"n_weeks": 4})]:
        a = {"id": "A1", "type": "trade_plan", "set": "S1", "entry": {"at": "signal_close"}, "stop": {"from": "C1"},
             "confidence": {"method": method, **extra}}
        out = run_program(vstop_prog([a]), asof, ctx)
        plans = out["actions"]["A1"]["plans"]
        assert plans and all(p["status"] == "ok" and p["sl"] is not None and "score" in p["confidence"] for p in plans)
        close = ctx.daily_panels[plans[0]["ticker"]]["close"].iloc[-1]
        assert plans[0]["ep"] == pytest.approx(close)


def test_trade_plan_never_defaults_a_missing_entry_stop_or_method():
    ctx = sample_ctx(); asof = ctx.daily_panels["T0.NS"]["date"].iloc[-1]
    base = {"id": "A1", "type": "trade_plan", "set": "S1", "stop": {"from": "C1"}}
    with pytest.raises(ProgramError, match="entry"):
        run_program(vstop_prog([{**base, "entry": {"at": None}, "confidence": {"method": "conditions_met_count"}}]), asof, ctx)
    with pytest.raises(ProgramError, match="confidence.method"):
        run_program(vstop_prog([{**base, "entry": {"at": "signal_close"}, "confidence": {"method": None}}]), asof, ctx)
    with pytest.raises(ProgramError, match="cannot supply a stop"):
        run_program(vstop_prog([{**base, "stop": {"from": "C2"}, "entry": {"at": "signal_close"}, "confidence": {"method": "conditions_met_count"}}]), asof, ctx)


def test_group_by_counts_and_each_outperformance_metric():
    ctx = sample_ctx(); asof = ctx.daily_panels["T0.NS"]["date"].iloc[-1]
    uni_cond = [{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 0}]
    def hl(metric, rule, **kw):
        a = {"id": "A1", "type": "group_by", "set": "S1", "key": "sector", "highlight": {"metric": metric, "rule": rule, "lookback_weeks": 2, **kw}}
        return run_program(prog(uni_cond, actions=[a]), asof, ctx)["actions"]["A1"]
    g = hl("share_of_qualifiers_vs_universe", {"gt": 1.0})
    assert {x["sector"]: x["count"] for x in g["groups"]} == {"Auto": 2, "Bank": 2, "IT": 1}
    assert g["highlight"]["status"] == "ok"
    m = hl("median_return_of_qualifiers", {"top_k": 1}, lookback_weeks=4)
    assert sum(r["outperforming"] for r in m["highlight"]["sectors"]) == 1
    assert hl("sector_return_vs_benchmark", {"rs_gt": 0, "top_k": 1})["highlight"]["status"] == "benchmark_unavailable"
    assert hl(None, None)["highlight"] == {"status": "no_metric_given"}


def test_sector_outperformance_uses_a_point_in_time_benchmark():
    ctx = sample_ctx()
    asof = ctx.daily_panels["T0.NS"]["date"].iloc[-30]
    w = pd.DataFrame({"date": pd.date_range("2022-01-03", periods=60, freq="W-MON"), "close": np.linspace(100, 150, 60)})
    ctx.weekly_panels = None
    ctx.benchmark = w
    a = {"id": "A1", "type": "group_by", "set": "S1", "key": "sector",
         "highlight": {"metric": "sector_return_vs_benchmark", "lookback_weeks": 2, "rule": {"rs_gt": 0, "top_k": 1}}}
    base = run_program(prog([{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 0}], actions=[a]), asof, ctx)
    ctx2 = sample_ctx(); ctx2.benchmark = w.copy()
    ctx2.benchmark.loc[ctx2.benchmark["date"] > pd.Timestamp(asof), "close"] *= 50  # future-only mutation
    mutated = run_program(prog([{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 0}], actions=[a]), asof, ctx2)
    assert base["actions"]["A1"]["highlight"] == mutated["actions"]["A1"]["highlight"]


def test_validate_reruns_one_week_back_and_measures_this_weeks_return():
    ctx = sample_ctx(); asof = ctx.daily_panels["T0.NS"]["date"].iloc[-1]
    a = {"id": "A1", "type": "trade_plan", "set": "S1", "entry": {"at": "signal_close"}, "stop": {"from": "C1"}, "confidence": {"method": "conditions_met_count"}}
    v = {"id": "A2", "type": "validate", "of": "program", "shift": {"weeks": -1}, "horizons_w": [1]}
    out = run_program(vstop_prog([a, v]), asof, ctx)["actions"]["A2"]
    assert out["as_of_used"] == str((asof - pd.Timedelta(weeks=1)).date())
    h = out["horizons"]["1"]
    assert h["n_plans"] >= 1 and h["n_graded"] == h["n_plans"] and h["mean_return_pct"] is not None


def test_validate_future_mutation_canary():
    """Mutating bars AFTER the shifted as_of's selection must not change which stocks were selected
    or their entry/stop — only the measured return may differ."""
    ctx = sample_ctx(); asof = ctx.daily_panels["T0.NS"]["date"].iloc[-1]
    a = {"id": "A1", "type": "trade_plan", "set": "S1", "entry": {"at": "signal_close"}, "stop": {"from": "C1"}, "confidence": {"method": "conditions_met_count"}}
    v = {"id": "A2", "type": "validate", "of": "program", "shift": {"weeks": -1}, "horizons_w": [1]}
    base = run_program(vstop_prog([a, v]), asof, ctx)["actions"]["A2"]
    ctx2 = sample_ctx()
    cut = asof - pd.Timedelta(weeks=1)
    for t, df in ctx2.daily_panels.items():
        m = df["date"] > cut
        df.loc[m, ["open", "high", "low", "close"]] *= 3.0
    mut = run_program(vstop_prog([a, v]), asof, ctx2)["actions"]["A2"]
    pick = lambda o: sorted((r["ticker"], r["ep"]) for r in o["horizons"]["1"]["rows"])
    assert pick(base) == pick(mut)
    assert base["horizons"]["1"]["mean_return_pct"] != mut["horizons"]["1"]["mean_return_pct"]


def test_t1_literal_event_may_fire_any_day_of_the_window():
    closes = np.r_[np.linspace(120, 80, 60), np.linspace(80, 120, 20)]
    ctx = ctx_for({"A.NS": daily(closes, start="2024-01-01")})
    d = ctx.daily_panels["A.NS"]["date"]
    flip_day = None
    s = {"id": "S1", "from": "universe", "eval": {"mode": "t1_literal", "timeframe": "1D", "t1_window": {"length_sessions": 5, "offsets": [0, 1, 2, 3, 4]}}, "where": {"all": ["C1"]}}
    hits = []
    for wk in pd.date_range(d.iloc[40], d.iloc[-5], freq="W-MON"):
        out = run_program(prog([{"id": "C1", "lhs": ind("vstop", length=10, mult=2, source="close"), "op": "flip", "dir": "long"}], sets=[s]), wk, ctx)
        hits += [str(wk.date())] * out["sets"]["S1"]["count"]
    assert len(hits) >= 1


def test_outperformance_and_hit_rate_never_default_their_lookback():
    ctx = sample_ctx(); asof = ctx.daily_panels["T0.NS"]["date"].iloc[-1]
    cond = [{"id": "C1", "lhs": {"field": "price"}, "op": ">", "value": 0}]
    g = {"id": "A1", "type": "group_by", "set": "S1", "key": "sector", "highlight": {"metric": "median_return_of_qualifiers", "rule": {"top_k": 1}}}
    with pytest.raises(ProgramError, match="lookback_weeks"):
        run_program(prog(cond, actions=[g]), asof, ctx)
    t = {"id": "A1", "type": "trade_plan", "set": "S1", "entry": {"at": "signal_close"}, "stop": {"from": "C1"}, "confidence": {"method": "historical_hit_rate"}}
    with pytest.raises(ProgramError, match="n_weeks"):
        run_program(vstop_prog([t]), asof, ctx)


def test_result_is_strict_json_even_when_a_value_could_not_be_computed():
    import json
    from engine.v5.run import sanitize
    out = sanitize({"a": float("nan"), "b": [float("inf"), np.float64(1.5), np.int64(3)], "c": {"d": pd.Timestamp("2026-01-02")}})
    assert out == {"a": None, "b": [None, 1.5, 3], "c": {"d": "2026-01-02"}}
    json.dumps(out, allow_nan=False)


def test_no_hidden_defaults_every_registry_param_is_required_and_changes_the_result():
    """Driven by the registry itself (a new indicator extends the coverage): omitting a param is reported,
    never filled; changing a param to another valid value changes the computed series."""
    closes = 100 + np.cumsum(np.sin(np.arange(160) / 4) * 3 + np.cos(np.arange(160) / 9))
    df = daily(closes).assign(volume=lambda d: 1e6 + np.arange(len(d)) * 5e4,
                              open=lambda d: d["close"] * (1 + 0.02 * np.sin(np.arange(len(d)) / 3)), high=lambda d: d["close"] + 2.0, low=lambda d: d["close"] - 2.0)
    good = {"length": 10, "mult": 2.0, "source": "close", "fast": 12, "slow": 26, "signal": 9, "bars": 5, "lookback": 20,
            "tenkan": 9, "kijun": 26, "span_b": 52, "shift": 26, "within": 5, "skip": 1}
    alt = {"length": 15, "mult": 3.0, "source": "open", "fast": 8, "slow": 30, "signal": 5, "bars": 9, "lookback": 40,
           "tenkan": 12, "kijun": 30, "span_b": 60, "shift": 20, "within": 12, "skip": 2}
    for name, reg in INDICATORS.items():
        params = {p.name: good[p.name] for p in reg.params}
        for p in reg.params:
            # an optional param (e.g. `skip`, 0 = include today) may be left out; every other one must be reported, never filled
            assert check_params(reg, {k: v for k, v in params.items() if k != p.name}) == ([] if p.optional else [f"missing required param '{p.name}'"])
            changed = {**params, p.name: alt[p.name]}
            a, b = reg.compute(df, params)[list(reg.outputs)], reg.compute(df, changed)[list(reg.outputs)]
            assert not np.allclose(a.to_numpy(dtype=float, na_value=0.0), b.to_numpy(dtype=float, na_value=0.0)), f"{name}.{p.name} does not affect the result"


def _weekly_with_open_week(closes):
    """Weekly bars whose final (in-progress) week has an open/high/low/volume but no close yet — what the
    data source returns when the run date falls inside a week that has not closed."""
    n = len(closes)
    w = pd.DataFrame({"date": pd.date_range("2026-01-05", periods=n + 1, freq="7D"),
                      "open": list(closes) + [closes[-1]], "high": list(closes) + [closes[-1]],
                      "low": list(closes) + [closes[-1]], "close": list(closes) + [float("nan")],
                      "volume": [1_000_000.0] * n + [80_913.0]})
    return w


def test_latest_field_values_ignore_an_unclosed_final_week():
    # Market cap / price / volume are "latest available", not "as of the in-progress bar": the NaN close of a
    # week that has not closed must not knock the stock out of the screen.
    w = _weekly_with_open_week([100.0] * 12)
    ctx = ctx_for({"S.NS": daily(np.full(60, 100.0))}, weekly_panels={"S.NS": w})
    ctx.shares["S.NS"] = 0.9e9                                        # 100 * 0.9e9 / 1e7 = 9,000 cr
    as_of = w["date"].iloc[-1]                                          # the unclosed week itself
    conds = [{"id": "C1", "lhs": {"field": "mcap_cr"}, "op": "<", "value": 10000},
             {"id": "C2", "lhs": {"field": "price"}, "op": ">", "value": 50},
             {"id": "C3", "lhs": {"field": "volume"}, "op": ">=", "value": 500_000},
             {"id": "C4", "lhs": {"field": "traded_value_cr", "params": {"window": "4W"}}, "op": ">", "value": 0.5}]
    p = prog(conds)
    p["sets"][0]["where"] = {"all": ["C1", "C2", "C3", "C4"]}
    out = run_program(p, as_of, ctx)
    assert [m["ticker"] for m in out["sets"]["S1"]["members"]] == ["S.NS"]


def test_full_table_lists_every_universe_stock_with_every_condition_and_marks_the_selected():
    # opt-in: every stock in the universe with each condition's value and pass/fail, not only the members
    ctx = ctx_for({"S.NS": daily(np.full(30, 100.0)), "BIG.NS": daily(np.full(30, 100.0)), "TINY.NS": daily(np.full(30, 100.0))})
    ctx.shares.update({"S.NS": 0.9e9, "BIG.NS": 1e12, "TINY.NS": 1e6})          # 9,000 / 10,000,000 / 10 cr
    conds = [{"id": "C1", "lhs": {"field": "mcap_cr"}, "op": "<", "value": 10000},
             {"id": "C2", "lhs": {"field": "price"}, "op": ">", "value": 50}]
    p = prog(conds)
    p["sets"][0]["where"] = {"all": ["C1", "C2"]}
    asof = ctx.daily_panels["S.NS"]["date"].iloc[-1]
    assert "table" not in run_program(p, asof, ctx)
    out = run_program(p, asof, ctx, full_table=True)
    rows = {r["ticker"]: r for r in out["table"]["rows"]}
    assert set(rows) == {"S.NS", "BIG.NS", "TINY.NS"}                           # the whole universe, not just members
    assert rows["BIG.NS"]["conditions"]["C1"] == {"passed": False, "value": 10_000_000.0, "state": 0}
    assert rows["BIG.NS"]["conditions"]["C2"]["passed"] is True                  # every condition is evaluated, none short-circuited
    assert rows["S.NS"]["selected"] == ["S1"] and rows["BIG.NS"]["selected"] == [] and rows["TINY.NS"]["selected"] == ["S1"]
    assert out["table"]["conditions"] == ["C1", "C2"]
