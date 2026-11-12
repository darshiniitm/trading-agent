"""
Midweek-scan-on-Literal: the OLD mid-week rolling-window scan
(src/screen/t1_scan.py:scan_t1_week()) fed Literal's rule_spec/environment instead of
Control's (tests/track_literal.py's midweek_scan_record()/midweek_scan_grade()/
midweek_scan_replay()). Frozen, no longer called T1 (27 Sep 2026 redefinition, see
tests/track_literal.py's module docstring) -- kept here as a regression probe for the
scan code itself, which Literal's environment still exercises. Mirrors
tests/test_t1_shadow.py's structure exactly -- same scan code, same set-logic
assertions -- plus a grading test that checks the Literal-specific EP convention
(entry_price_source="signal_close": EP is the row's own signal_close, never
overwritten by next week's open, which is only reported as next_week_open_check).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

import src.screen.engine as engine_mod
import src.screen.t1_scan as t1_scan_mod
import tests.track_literal as tl
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
    if "flip_up" in predicate:
        return bool(locals_.get("flip_up"))
    return True


def _flat_weekly_panel(ticker_count_days=40):
    return make_panel(np.full(ticker_count_days, 500.0), start="2022-05-30")


def _rule_spec():
    from pathlib import Path

    from src.config import load_rule_spec
    return load_rule_spec(str(Path(__file__).resolve().parents[1] / "config" / "rules_literal.yaml"))


def _universe_and_shares(tickers):
    uni = pd.DataFrame([{"ticker": t, "name": t, "sector": "Test", "isin": "X"} for t in tickers])
    shares = {t: 3e8 for t in tickers}
    return uni, shares


@pytest.fixture
def patch_predicate(monkeypatch):
    monkeypatch.setattr(engine_mod, "evaluate_predicate", _relaxed_predicate)
    monkeypatch.setattr(t1_scan_mod, "_rsi_band_bounds", lambda rule_spec: (0.0, 100.0))


def test_extra_flip_that_holds_through_friday_is_confirmed(monkeypatch, patch_predicate, tmp_path):
    tickers = ["HOLD.NS"]
    down = np.linspace(600, 500, 40)
    ramp = np.linspace(500, 560, 5)
    daily = make_daily_panel(np.concatenate([down, ramp]), start="2023-01-02")
    weekly = _flat_weekly_panel()

    uni, shares = _universe_and_shares(tickers)
    weekly_panels = {t: weekly for t in tickers}
    adapter = _FakeAdapter({t: daily for t in tickers})

    monkeypatch.setattr(tl, "env_literal_with_daily",
                         lambda: (_rule_spec(), adapter, uni, weekly_panels, shares, adapter.daily_ohlcv(tickers, 0)))
    monkeypatch.setattr(tl, "OUT", tmp_path)

    rec = tl.midweek_scan_record()
    assert rec is not None
    assert rec["record_id"].endswith("_t1")
    assert rec["n_extra_confirmed"] == 1
    assert rec["picks"][0]["ticker"] == "HOLD.NS"
    assert rec["n_extra_reversed"] == 0
    assert (tmp_path / f"t1_picks_{rec['signal_week_start']}.json").exists()


def test_extra_flip_that_reverses_before_friday_is_not_confirmed(monkeypatch, patch_predicate, tmp_path):
    tickers = ["REV.NS"]
    down = np.linspace(600, 500, 40)
    ramp = np.linspace(500, 545, 3)
    drop = np.linspace(545, 470, 2)
    daily = make_daily_panel(np.concatenate([down, ramp, drop]), start="2023-01-02")
    weekly = _flat_weekly_panel()

    uni, shares = _universe_and_shares(tickers)
    weekly_panels = {t: weekly for t in tickers}
    adapter = _FakeAdapter({t: daily for t in tickers})

    monkeypatch.setattr(tl, "env_literal_with_daily",
                         lambda: (_rule_spec(), adapter, uni, weekly_panels, shares, adapter.daily_ohlcv(tickers, 0)))
    monkeypatch.setattr(tl, "OUT", tmp_path)

    rec = tl.midweek_scan_record()
    assert rec is not None
    assert rec["n_extra_confirmed"] == 0
    assert rec["n_extra_reversed"] == 1
    assert rec["picks"] == []


def test_no_daily_cache_reports_cleanly_instead_of_crashing(monkeypatch, tmp_path):
    class _EmptyAdapter:
        def benchmark_series(self, ticker, history_weeks):
            return pd.DataFrame()

        def daily_ohlcv(self, tickers, history_days):
            return {}

    uni, shares = _universe_and_shares(["X.NS"])
    weekly_panels = {"X.NS": _flat_weekly_panel()}
    monkeypatch.setattr(tl, "env_literal_with_daily",
                         lambda: (_rule_spec(), _EmptyAdapter(), uni, weekly_panels, shares, {}))
    monkeypatch.setattr(tl, "OUT", tmp_path)

    assert tl.midweek_scan_record() is None


def test_grade_uses_signal_close_as_ep_not_next_week_open(monkeypatch, patch_predicate, tmp_path):
    """Literal's EP convention (decided 26 Sep 2026): the row's own signal_close is the
    real, already-fixed EP -- next week's open is only ever reported as an
    informational next_week_open_check, never used to compute the return."""
    tickers = ["HOLD.NS"]
    down = np.linspace(600, 500, 40)
    ramp = np.linspace(500, 560, 5)
    daily = make_daily_panel(np.concatenate([down, ramp]), start="2023-01-02")
    weekly = _flat_weekly_panel()

    uni, shares = _universe_and_shares(tickers)
    weekly_panels = {t: weekly for t in tickers}
    adapter = _FakeAdapter({t: daily for t in tickers})

    monkeypatch.setattr(tl, "env_literal_with_daily",
                         lambda: (_rule_spec(), adapter, uni, weekly_panels, shares, adapter.daily_ohlcv(tickers, 0)))
    monkeypatch.setattr(tl, "OUT", tmp_path)

    rec = tl.midweek_scan_record()
    assert rec is not None
    signal_close = rec["picks"][0]["signal_close"]

    # A following week whose open differs sharply from signal_close -- if grading
    # mistakenly used next_week_open as EP, ret_pct would come out very different.
    next_week = make_panel([600.0], start=str(pd.Timestamp(rec["signal_week_start"]) + pd.Timedelta(weeks=1)))
    weekly_panels_with_next = {"HOLD.NS": pd.concat([weekly, next_week], ignore_index=True)}
    monkeypatch.setattr(tl, "env_literal_with_daily",
                         lambda: (_rule_spec(), adapter, uni, weekly_panels_with_next, shares,
                                  adapter.daily_ohlcv(tickers, 0)))

    path = tmp_path / f"t1_picks_{rec['signal_week_start']}.json"
    tl.midweek_scan_grade(str(path))

    graded = __import__("json").loads(path.read_text())["graded"]
    detail = graded["detail"][0]
    assert detail["EP_actual"] == pytest.approx(signal_close, abs=1e-6)
    assert "next_week_open_check" in detail
    assert detail["next_week_open_check"] == pytest.approx(600.0, abs=1e-6)
