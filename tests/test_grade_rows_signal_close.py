"""
_grade_rows(entry_price_source="signal_close") -- Literal spec's EP definition
(decided 26 Sep 2026: EP = Friday's signal close, not the following week's open).
Hermetic, mirrors tests/test_d7_holding_week.py's synthetic-panel pattern.
"""
from __future__ import annotations

import pandas as pd
import pytest

from tests.track_forward import _grade_rows

AS_OF = pd.Timestamp("2026-09-07")
NEXT_WEEK = pd.Timestamp("2026-09-14")


def _weekly_panel(next_open, next_low, next_close):
    return pd.DataFrame({
        "date": [AS_OF, NEXT_WEEK],
        "open": [100.0, next_open], "high": [101.0, next_close + 1],
        "low": [99.0, next_low], "close": [100.0, next_close], "volume": [1e6, 1e6],
    })


def test_default_mode_is_unchanged_next_week_open():
    """Regression guard: omitting entry_price_source must behave exactly as before."""
    panel = _weekly_panel(next_open=105.0, next_low=104.0, next_close=110.0)
    row = {"ticker": "T.NS", "vstop_line_SL": 95.0, "signal_close": 100.0}
    out, _ = _grade_rows([row], {"T.NS": panel}, AS_OF, cost=0.0)
    assert out[0]["EP_actual"] == 105.0  # next week's open, not the signal close
    assert "next_week_open_check" not in out[0]


def test_signal_close_mode_uses_recorded_signal_close_as_ep():
    panel = _weekly_panel(next_open=105.0, next_low=104.0, next_close=110.0)
    row = {"ticker": "T.NS", "vstop_line_SL": 95.0, "signal_close": 100.0}
    out, _ = _grade_rows([row], {"T.NS": panel}, AS_OF, cost=0.0, entry_price_source="signal_close")
    assert out[0]["EP_actual"] == 100.0                    # the Friday signal close, not 105.0
    assert out[0]["next_week_open_check"] == 105.0         # Monday's open, informational only
    assert out[0]["ret_pct"] == pytest.approx((110.0 - 100.0) / 100.0 * 100)


def test_signal_close_mode_still_honours_stop_hit_on_the_holding_weeks_low():
    # Even though EP is the signal close, a stop-hit exit still checks the FOLLOWING
    # week's low against SL -- the holding period is unchanged, only EP moved.
    panel = _weekly_panel(next_open=101.0, next_low=90.0, next_close=110.0)
    row = {"ticker": "T.NS", "vstop_line_SL": 95.0, "signal_close": 100.0}
    out, _ = _grade_rows([row], {"T.NS": panel}, AS_OF, cost=0.0, entry_price_source="signal_close")
    assert out[0]["exit_reason"] == "stop_hit"
    assert out[0]["exit_price"] == 95.0
    assert out[0]["EP_actual"] == 100.0


def test_signal_close_mode_gap_stop_uses_next_week_open_as_the_honest_fill():
    # A gap-through-stop is still measured off the following week's OPEN as the honest
    # fill (D1's fix), even though EP itself is the signal close, not that open.
    panel = _weekly_panel(next_open=90.0, next_low=88.0, next_close=95.0)
    row = {"ticker": "T.NS", "vstop_line_SL": 95.0, "signal_close": 100.0}
    out, _ = _grade_rows([row], {"T.NS": panel}, AS_OF, cost=0.0, entry_price_source="signal_close")
    assert out[0]["exit_reason"] == "gap_stop_at_open"
    assert out[0]["exit_price"] == 90.0
    assert out[0]["next_week_open_check"] == 90.0
