"""
Phase 8: the T1 rolling-window shadow scan (docs/forward-test-response-and-
volume-plan.md §3.2, §3.4). Tests the orchestration in record_t1_shadow() —
which mid-week flips are genuinely "extra" vs Control, and which of those
would have reversed before Friday — against synthetic daily/weekly panels.
Indicator math itself (VStop flip timing, RSI) is covered elsewhere
(test_indicators.py, test_daily_scale.py); here the RSI-band predicate is
relaxed via monkeypatch so the test can focus purely on the set logic.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

import src.screen.engine as engine_mod
import tests.track_forward as tf
from tests.offline import make_daily_panel, make_panel


class _FakeAdapter:
    def __init__(self, daily_panels):
        self._daily_panels = daily_panels

    def benchmark_series(self, ticker, history_weeks):
        return pd.DataFrame()

    def daily_benchmark_series(self, ticker, history_days):
        return pd.DataFrame()

    def daily_ohlcv(self, tickers, history_days):
        return {t: self._daily_panels[t] for t in tickers if t in self._daily_panels}


def _relaxed_predicate(predicate, locals_):
    """vstop_flip -> real flip_up; rsi_band -> always True. Isolates the test
    from needing to hand-tune a price path that also lands RSI in [50,65]."""
    if "flip_up" in predicate:
        return bool(locals_.get("flip_up"))
    return True


def _flat_weekly_panel(ticker_count_days=40):
    return make_panel(np.full(ticker_count_days, 500.0), start="2023-01-02")


def _rule_spec():
    from src.config import load_rule_spec
    from pathlib import Path
    return load_rule_spec(str(Path(__file__).resolve().parents[1] / "config" / "rules.yaml"))


def _universe_and_shares(tickers):
    uni = pd.DataFrame([{"ticker": t, "name": t, "sector": "Test", "isin": "X"} for t in tickers])
    shares = {t: 3e8 for t in tickers}  # close ~500 * 3e8 / 1e7 = 15,000 cr, inside the band
    return uni, shares


@pytest.fixture
def patch_predicate(monkeypatch):
    monkeypatch.setattr(engine_mod, "evaluate_predicate", _relaxed_predicate)
    # record_t1_shadow()'s own Friday re-check reads the real RSI value directly
    # (not through evaluate_predicate), so relax the band the same way here —
    # this test is about the extra/reversed set logic, not RSI precision.
    monkeypatch.setattr(tf, "_rsi_band_bounds", lambda rule_spec: (0.0, 100.0))


def test_extra_flip_that_holds_through_friday_is_confirmed(monkeypatch, patch_predicate, tmp_path):
    tickers = ["HOLD.NS"]
    # 40-day downtrend, then a 5-day rally: flips up on day 2 of the window and
    # is still trending up on day 5 (Friday).
    down = np.linspace(600, 500, 40)
    ramp = np.linspace(500, 560, 5)
    daily = make_daily_panel(np.concatenate([down, ramp]), start="2023-01-02")
    weekly = _flat_weekly_panel()  # never flips -> Control sees nothing

    uni, shares = _universe_and_shares(tickers)
    weekly_panels = {t: weekly for t in tickers}
    adapter = _FakeAdapter({t: daily for t in tickers})

    monkeypatch.setattr(tf, "env", lambda: (_rule_spec(), adapter, uni, weekly_panels, shares))
    monkeypatch.setattr(tf, "OUT", tmp_path)

    rec = tf.record_t1_shadow()
    assert rec is not None
    assert rec["n_extra_confirmed"] == 1
    assert rec["picks"][0]["ticker"] == "HOLD.NS"
    assert rec["n_extra_reversed"] == 0


def test_extra_flip_that_reverses_before_friday_is_not_confirmed(monkeypatch, patch_predicate, tmp_path):
    tickers = ["REV.NS"]
    # 40-day downtrend, brief 3-day rally that flips up, then drops back down
    # for the last 2 days of the window -> reversed again before Friday.
    down = np.linspace(600, 500, 40)
    ramp = np.linspace(500, 545, 3)
    drop = np.linspace(545, 470, 2)
    daily = make_daily_panel(np.concatenate([down, ramp, drop]), start="2023-01-02")
    weekly = _flat_weekly_panel()

    uni, shares = _universe_and_shares(tickers)
    weekly_panels = {t: weekly for t in tickers}
    adapter = _FakeAdapter({t: daily for t in tickers})

    monkeypatch.setattr(tf, "env", lambda: (_rule_spec(), adapter, uni, weekly_panels, shares))
    monkeypatch.setattr(tf, "OUT", tmp_path)

    rec = tf.record_t1_shadow()
    assert rec is not None
    assert rec["n_extra_confirmed"] == 0
    assert rec["n_extra_reversed"] == 1
    assert rec["extra_reversed_tickers"] == ["REV.NS"]
    assert rec["picks"] == []


def test_ticker_already_in_control_is_not_double_counted(monkeypatch, patch_predicate, tmp_path):
    """A name Control's own weekly screen already caught isn't 'extra' just
    because the daily scan also sees it flip."""
    tickers = ["BOTH.NS"]
    down_d = np.linspace(600, 500, 40)
    ramp_d = np.linspace(500, 560, 5)
    daily = make_daily_panel(np.concatenate([down_d, ramp_d]), start="2023-01-02")
    # Weekly panel also flips, landing the flip exactly on the CURRENT (last)
    # weekly bar -- that's what Control's own single-as_of screen actually
    # checks, unlike the multi-day T1 window above. Needs >= min_bars_required
    # (30) weekly bars.
    down_w = np.linspace(600, 500, 30)
    ramp_w = np.linspace(500, 524, 2)
    weekly = make_panel(np.concatenate([down_w, ramp_w]), start="2022-04-04")

    uni, shares = _universe_and_shares(tickers)
    weekly_panels = {t: weekly for t in tickers}
    adapter = _FakeAdapter({t: daily for t in tickers})

    monkeypatch.setattr(tf, "env", lambda: (_rule_spec(), adapter, uni, weekly_panels, shares))
    monkeypatch.setattr(tf, "OUT", tmp_path)

    rec = tf.record_t1_shadow()
    assert rec is not None
    assert "BOTH.NS" in rec["control_survivors"]
    assert rec["n_extra_confirmed"] == 0
    assert rec["n_extra_reversed"] == 0


def test_no_daily_cache_reports_cleanly_instead_of_crashing(monkeypatch, tmp_path):
    class _EmptyAdapter:
        def benchmark_series(self, ticker, history_weeks):
            return pd.DataFrame()

        def daily_ohlcv(self, tickers, history_days):
            return {}

    uni, shares = _universe_and_shares(["X.NS"])
    weekly_panels = {"X.NS": _flat_weekly_panel()}
    monkeypatch.setattr(tf, "env", lambda: (_rule_spec(), _EmptyAdapter(), uni, weekly_panels, shares))
    monkeypatch.setattr(tf, "OUT", tmp_path)

    assert tf.record_t1_shadow() is None
