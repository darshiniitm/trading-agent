"""V3 (pullback limit entry) / V4 (same-week confirmation) engine probes. Hermetic."""
from __future__ import annotations

import pandas as pd
import pytest

from src.backtest.daily_exit import horizon_end_date, simulate_daily_exit
from src.backtest.entry import pullback_limit_fill, same_week_entry
from src.config import load_rule_spec

FRIDAY = pd.Timestamp("2021-01-08")  # a Friday


def _daily(dates, opens, highs, lows, closes):
    return pd.DataFrame({"date": dates, "open": opens, "high": highs, "low": lows,
                         "close": closes, "volume": [1e6] * len(dates)})


# ---- V3: pullback_limit_fill ------------------------------------------------------------

def test_pullback_fills_at_min_open_limit_on_first_low_breach():
    dates = [FRIDAY + pd.Timedelta(days=i) for i in (3, 4, 5, 6, 7)]  # next 5 sessions
    daily = _daily(dates, opens=[102, 101, 98, 97, 96], highs=[103, 102, 100, 99, 98],
                    lows=[101, 99, 97, 96, 95], closes=[102, 100, 99, 97, 96])
    r = pullback_limit_fill(daily, FRIDAY, limit=100.0, window_days=5)
    assert r["filled"] is True
    # day1 (idx0): low=101 > 100 -> no fill; day2 (idx1): low=99<=100 -> fill at min(open=101, limit=100)
    assert r["fill_price"] == pytest.approx(100.0)
    assert r["fill_date"] == dates[1]


def test_pullback_no_fill_within_window():
    dates = [FRIDAY + pd.Timedelta(days=i) for i in (3, 4, 5, 6, 7)]
    daily = _daily(dates, opens=[110] * 5, highs=[112] * 5, lows=[105] * 5, closes=[111] * 5)
    r = pullback_limit_fill(daily, FRIDAY, limit=100.0, window_days=5)
    assert r == {"filled": False, "fill_price": None, "fill_date": None}


# ---- V4: same_week_entry ----------------------------------------------------------------

def test_same_week_entry_falls_back_to_control_fill_when_only_friday_confirms():
    rule_spec = load_rule_spec("config/rules.yaml")
    # Not enough daily history for compute_features_for_ticker to return non-None on any day
    # within the week -> confirm_day stays None -> falls back to first day after the week.
    week_start = pd.Timestamp("2021-01-04")  # Monday
    dates = [week_start + pd.Timedelta(days=i) for i in range(0, 10)]
    daily = _daily(dates, opens=[100 + i for i in range(10)], highs=[101 + i for i in range(10)],
                    lows=[99 + i for i in range(10)], closes=[100 + i for i in range(10)])
    r = same_week_entry(daily, rule_spec, week_start)
    assert r["confirmed_early"] is False
    assert r["entry_date"] == week_start + pd.Timedelta(days=7)  # first day after week_end (Sun)


# ---- daily_exit -----------------------------------------------------------------------

def test_horizon_end_date_first_holding_week_is_entry_weeks_friday():
    tuesday_entry = pd.Timestamp("2021-01-05")  # Tue
    assert horizon_end_date(tuesday_entry, n_weeks=1) == pd.Timestamp("2021-01-08")  # that week's Fri
    assert horizon_end_date(tuesday_entry, n_weeks=2) == pd.Timestamp("2021-01-15")


def test_simulate_daily_exit_stop_hit_same_day_as_entry_checks_low_only():
    entry_date = pd.Timestamp("2021-01-05")
    dates = [entry_date, entry_date + pd.Timedelta(days=1)]
    daily = _daily(dates, opens=[100, 99], highs=[101, 100], lows=[85, 96], closes=[99, 98])
    g = simulate_daily_exit(daily, entry_date, EP=100.0, SL=90.0,
                            horizon_end=pd.Timestamp("2021-01-08"), cost_pct=0.0)
    assert g["exit_reason"] == "stop_hit"
    assert g["exit_price"] == pytest.approx(90.0)
    assert g["exit_date"] == entry_date  # same-day stop, not a gap check on the entry's own open


def test_simulate_daily_exit_horizon_close_when_no_stop():
    entry_date = pd.Timestamp("2021-01-05")
    dates = [entry_date + pd.Timedelta(days=i) for i in range(4)]
    daily = _daily(dates, opens=[100, 101, 102, 103], highs=[102, 103, 104, 105],
                    lows=[98, 99, 100, 101], closes=[101, 102, 103, 104])
    g = simulate_daily_exit(daily, entry_date, EP=100.0, SL=90.0,
                            horizon_end=pd.Timestamp("2021-01-08"), cost_pct=0.0)
    assert g["exit_reason"] == "horizon_close"
    assert g["exit_price"] == pytest.approx(104.0)


def test_simulate_daily_exit_returns_none_when_not_enough_forward_data():
    entry_date = pd.Timestamp("2021-01-05")
    daily = _daily([entry_date], opens=[100], highs=[101], lows=[98], closes=[100])
    g = simulate_daily_exit(daily, entry_date, EP=100.0, SL=90.0,
                            horizon_end=pd.Timestamp("2021-01-08"), cost_pct=0.0)
    assert g is None
