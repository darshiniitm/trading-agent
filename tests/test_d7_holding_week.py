"""
D7 fix probe (.claude/HARNESS.md #7): a weekly bar in a week whose Monday is an NSE
holiday reports the previous Friday's close as that week's open. corrected_week_bar()
should prefer the holding week's own daily sessions when available, and fall back to
the (defective) weekly bar untouched otherwise. Hermetic.
"""
from __future__ import annotations

import pandas as pd

from src.data.holding_week import corrected_week_bar
from tests.track_forward import _grade_rows

MONDAY = pd.Timestamp("2026-09-14")  # NSE holiday (Ganesh Chaturthi) per findings 2026-09-16


def _daily_panel(dates, opens, lows, closes):
    return pd.DataFrame({"date": dates, "open": opens, "high": [c + 1 for c in closes],
                          "low": lows, "close": closes, "volume": [1e6] * len(dates)})


def test_holiday_week_uses_first_real_session_open_not_prior_friday_close():
    # Monday is a holiday: first real session is Tuesday, whose open differs from the
    # weekly bar's (defective) open == prior Friday's close.
    daily = _daily_panel(
        dates=[pd.Timestamp("2026-09-15"), pd.Timestamp("2026-09-16"), pd.Timestamp("2026-09-18")],
        opens=[105.0, 106.0, 107.0], lows=[103.0, 104.0, 106.0], closes=[106.0, 107.0, 108.0],
    )
    bar = corrected_week_bar("T.NS", {"T.NS": daily}, MONDAY,
                              fallback_open=100.0, fallback_low=99.0, fallback_close=108.0)
    assert bar["source"] == "daily"
    assert bar["open"] == 105.0            # Tuesday's real open, not Friday's close (100.0)
    assert bar["low"] == 103.0             # min low across the real sessions
    assert bar["close"] == 108.0           # last real session's close


def test_holiday_monday_zero_volume_placeholder_row_is_skipped():
    # Residual defect (findings 2026-09-14): yfinance inserts a zero-volume placeholder
    # row *on* the holiday Monday itself, open==high==low==close==prior Friday's close,
    # ahead of the first real session (Tuesday). Without a volume filter, days.iloc[0]
    # picks that placeholder's open, reproducing the pre-fix D7 bug.
    placeholder_close = 100.0  # identical to the prior Friday's close
    daily = pd.DataFrame({
        "date": [MONDAY, pd.Timestamp("2026-09-15"), pd.Timestamp("2026-09-16"), pd.Timestamp("2026-09-18")],
        "open": [placeholder_close, 105.0, 106.0, 107.0],
        "high": [placeholder_close, 106.0, 107.0, 108.0],
        "low": [placeholder_close, 103.0, 104.0, 106.0],
        "close": [placeholder_close, 106.0, 107.0, 108.0],
        "volume": [0, 1e6, 1e6, 1e6],
    })
    bar = corrected_week_bar("T.NS", {"T.NS": daily}, MONDAY,
                              fallback_open=100.0, fallback_low=99.0, fallback_close=108.0)
    assert bar["source"] == "daily"
    assert bar["open"] == 105.0            # Tuesday's real open, not the Monday placeholder's
    assert bar["low"] == 103.0             # placeholder's low (100.0) excluded from the min
    assert bar["close"] == 108.0


def test_all_placeholder_rows_falls_back_to_weekly_bar():
    # A week with no real (nonzero-volume) session at all should behave like no daily
    # coverage, not silently return the placeholder's values as if they were real.
    daily = pd.DataFrame({
        "date": [MONDAY], "open": [100.0], "high": [100.0], "low": [100.0], "close": [100.0], "volume": [0],
    })
    bar = corrected_week_bar("T.NS", {"T.NS": daily}, MONDAY,
                              fallback_open=100.0, fallback_low=99.0, fallback_close=108.0)
    assert bar == {"open": 100.0, "low": 99.0, "close": 108.0, "source": "weekly_bar"}


def test_no_daily_coverage_falls_back_to_weekly_bar_unchanged():
    bar = corrected_week_bar("T.NS", {}, MONDAY, fallback_open=100.0, fallback_low=99.0, fallback_close=108.0)
    assert bar == {"open": 100.0, "low": 99.0, "close": 108.0, "source": "weekly_bar"}

    bar_none = corrected_week_bar("T.NS", None, MONDAY, fallback_open=100.0, fallback_low=99.0, fallback_close=108.0)
    assert bar_none["source"] == "weekly_bar"


def test_grade_rows_uses_daily_bar_when_provided():
    weekly_panel = pd.DataFrame({
        "date": [pd.Timestamp("2026-09-07"), MONDAY],
        "open": [100.0, 100.0],  # defective: equals the prior Friday's close
        "high": [101.0, 109.0], "low": [99.0, 99.0], "close": [100.0, 108.0], "volume": [1e6, 1e6],
    })
    daily = _daily_panel(
        dates=[pd.Timestamp("2026-09-15"), pd.Timestamp("2026-09-16"), pd.Timestamp("2026-09-18")],
        opens=[105.0, 106.0, 107.0], lows=[103.0, 104.0, 106.0], closes=[106.0, 107.0, 108.0],
    )
    row = {"ticker": "T.NS", "vstop_line_SL": 95.0}
    without_daily, _ = _grade_rows([row], {"T.NS": weekly_panel}, pd.Timestamp("2026-09-07"), cost=0.0)
    with_daily, _ = _grade_rows([row], {"T.NS": weekly_panel}, pd.Timestamp("2026-09-07"), cost=0.0,
                                 daily_panels={"T.NS": daily})

    assert without_daily[0]["EP_actual"] == 100.0
    assert without_daily[0]["ep_source"] == "weekly_bar"
    assert with_daily[0]["EP_actual"] == 105.0
    assert with_daily[0]["ep_source"] == "daily"
    # different EP -> different (correct) return, not silently identical
    assert with_daily[0]["ret_pct"] != without_daily[0]["ret_pct"]
