"""
Phase 7: run the same VStop+RSI funnel against daily bars without moving
config/rules.yaml (docs/forward-test-response-and-volume-plan.md §3.2, T1).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.screen.daily_scale import daily_rule_spec, TRADING_DAYS_PER_WEEK
from src.screen.engine import run_screen
from tests.offline import env, make_daily_panel


def test_daily_rule_spec_scales_only_the_two_bar_count_lookbacks():
    rule_spec, *_ = env()
    scaled = daily_rule_spec(rule_spec)

    assert scaled["universe"]["liquidity"]["lookback_weeks"] == (
        rule_spec["universe"]["liquidity"]["lookback_weeks"] * TRADING_DAYS_PER_WEEK
    )
    assert scaled["sector"]["rs_lookbacks_weeks"] == [
        w * TRADING_DAYS_PER_WEEK for w in rule_spec["sector"]["rs_lookbacks_weeks"]
    ]
    # Everything else — the signal itself, the risk cap — must be untouched.
    assert scaled["signals"] == rule_spec["signals"]
    assert scaled["trade"]["max_r_pct"] == rule_spec["trade"]["max_r_pct"]
    # Original must not be mutated (deep copy).
    assert rule_spec["universe"]["liquidity"]["lookback_weeks"] != scaled["universe"]["liquidity"]["lookback_weeks"]


def test_run_screen_executes_end_to_end_on_daily_bars():
    rule_spec, *_ = env()
    scaled = daily_rule_spec(rule_spec)

    down = np.linspace(100, 60, 40)
    up = np.linspace(60, 120, 30)
    closes = np.concatenate([down, up])
    panel = make_daily_panel(closes, start="2024-01-01")

    universe_df = pd.DataFrame([
        {"ticker": "FLIP.NS", "name": "Flip Co", "sector": "Test", "isin": "X1"},
    ])
    daily_panels = {"FLIP.NS": panel}
    shares_map = {"FLIP.NS": 100_000_000.0}  # close ~100-120 * 1e8 shares -> mid-cap band

    res = run_screen(
        panel["date"].iloc[-1], scaled, adapter=None, universe_df=universe_df,
        weekly_panels=daily_panels, shares_map=shares_map,
        benchmark_fetch=lambda ticker, n: pd.DataFrame(),
    )

    assert set(res.keys()) == {"as_of", "survivors", "near_miss", "sector_rs", "funnel", "drop_log"}
    f = dict(zip(res["funnel"]["stage"], res["funnel"]["count"]))
    assert f["candidate_universe"] == 1
    # Ran to completion on daily bars without needing adapter.benchmark_series at all.
    assert isinstance(res["survivors"], pd.DataFrame)
    assert isinstance(res["near_miss"], pd.DataFrame)


def test_run_screen_default_benchmark_path_is_unchanged():
    """The new benchmark_fetch parameter must be fully backward compatible:
    omitting it reproduces exactly today's adapter.benchmark_series() call."""
    calls = []

    class FakeAdapter:
        def benchmark_series(self, ticker, history_weeks):
            calls.append((ticker, history_weeks))
            return pd.DataFrame()

    rule_spec, *_ = env()
    universe_df = pd.DataFrame([{"ticker": "X.NS", "name": "X", "sector": "S", "isin": "I"}])
    run_screen(pd.Timestamp("2024-06-01"), rule_spec, FakeAdapter(), universe_df, {}, {})

    assert calls == [(
        rule_spec["sector"].get("benchmark_ticker", ""),
        rule_spec["data"]["history_weeks"],
    )]
