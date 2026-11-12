"""V2 fixed-N-week-hold engine probes (config/experiments.yaml id V2). Hermetic."""
from __future__ import annotations

import pandas as pd
import pytest

from src.backtest.v2_horizon import simulate_fixed_hold

AS_OF = pd.Timestamp("2021-01-01")


def _trade(SL=90.0):
    return pd.DataFrame([{"ticker": "T.NS", "SL": SL, "close": 100.0}])


def _weekly_panel(rows):
    """rows: list of (open, high, low, close) for weeks AS_OF+1 .. AS_OF+len(rows)."""
    dates = [AS_OF] + [AS_OF + pd.Timedelta(weeks=i + 1) for i in range(len(rows))]
    opens = [100.0] + [r[0] for r in rows]
    highs = [101.0] + [r[1] for r in rows]
    lows = [99.0] + [r[2] for r in rows]
    closes = [100.0] + [r[3] for r in rows]
    return {"T.NS": pd.DataFrame({"date": dates, "open": opens, "high": highs, "low": lows,
                                  "close": closes, "volume": [1e6] * len(dates)})}


def test_holds_to_horizon_close_when_no_stop_hit():
    panels = _weekly_panel([(102, 105, 101, 104), (104, 108, 103, 107)])
    g = simulate_fixed_hold(_trade(SL=90.0), panels, AS_OF, cost_pct=0.0, n_weeks=2).iloc[0]
    assert g["exit_reason"] == "horizon_close"
    assert g["hold_weeks"] == 2
    assert g["exit_price"] == pytest.approx(107.0)
    assert g["EP"] == pytest.approx(102.0)


def test_stop_hit_before_horizon_exits_early_at_static_signal_stop():
    # week 1: fine; week 2: intraweek low breaches the STATIC signal-week SL (never trailed);
    # weeks 3-4 exist on disk (so there's enough forward data to grade an N=4 horizon) but are
    # never reached since the stop-out in week 2 ends the trade first.
    panels = _weekly_panel([(102, 105, 101, 104), (103, 106, 85, 106),
                            (95, 100, 92, 98), (96, 99, 94, 97)])
    g = simulate_fixed_hold(_trade(SL=90.0), panels, AS_OF, cost_pct=0.0, n_weeks=4).iloc[0]
    assert g["exit_reason"] == "stop_hit"
    assert g["exit_price"] == pytest.approx(90.0)  # SL, not the week's low
    assert g["hold_weeks"] == 2


def test_gap_through_stop_at_open_beats_stop_hit():
    panels = _weekly_panel([(85, 90, 80, 88)])  # opens below SL
    g = simulate_fixed_hold(_trade(SL=90.0), panels, AS_OF, cost_pct=0.0, n_weeks=1).iloc[0]
    assert g["exit_reason"] == "gap_stop_at_open"
    assert g["exit_price"] == pytest.approx(85.0)


def test_insufficient_forward_data_is_dropped_not_fabricated():
    panels = _weekly_panel([(102, 105, 101, 104)])  # only 1 forward week
    g = simulate_fixed_hold(_trade(SL=90.0), panels, AS_OF, cost_pct=0.0, n_weeks=4)
    assert g.empty
