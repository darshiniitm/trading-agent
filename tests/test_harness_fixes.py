"""
Backtest harness defect fixes D1/D2/D3/D5/D6 (docs/open-decisions-implementation-plan.md P1),
beyond the original probes in tests/test_backtest_engine.py. Hermetic.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.backtest.harness import (portfolio_metrics, simulate_week_forward, trade_rejections,
                                  weekly_portfolio_returns)

AS_OF = pd.Timestamp("2021-01-11")


def _trade(SL=90.0, EP_ref=100.0):
    return pd.DataFrame([{"ticker": "T.NS", "SL": SL, "EP": EP_ref, "R": EP_ref - SL,
                          "target": EP_ref + 2 * (EP_ref - SL), "RR": 2.0, "close": EP_ref}])


def _panels(open_, high, low, close):
    return {"T.NS": pd.DataFrame({"date": [AS_OF, AS_OF + pd.Timedelta(weeks=1)],
                                  "open": [100.0, open_], "high": [101.0, high], "low": [99.0, low],
                                  "close": [100.0, close], "volume": [1e6, 1e6]})}


def test_d1_gap_exit_labelled_and_flagged():
    row = simulate_week_forward(_trade(), _panels(80, 82, 78, 79), AS_OF, 0.005).iloc[0]
    assert row["exit_reason"] == "gap_stop_at_open"
    assert bool(row["gap_flag"]) is True
    assert row["ret_pct_net"] == pytest.approx(-0.005)


def test_d6_r_and_target_recomputed_off_fill():
    row = simulate_week_forward(_trade(SL=90.0, EP_ref=100.0), _panels(102, 110, 101, 108), AS_OF, 0.0).iloc[0]
    assert row["EP"] == pytest.approx(102.0)
    assert row["R"] == pytest.approx(12.0) and row["R_signal"] == pytest.approx(10.0)
    assert row["target"] == pytest.approx(126.0) and row["target_signal"] == pytest.approx(120.0)
    assert row["r_multiple"] == pytest.approx((108 - 102) / 12.0)


def test_d2_empty_calendar_weeks_and_edges_are_zero():
    cal = list(pd.date_range(AS_OF, periods=6, freq="W-MON"))
    graded = pd.DataFrame({"week_start": [cal[2], cal[2], cal[3]], "ret_pct_net": [0.02, 0.04, -0.01]})
    w = weekly_portfolio_returns(graded, calendar=cal)
    assert list(w["portfolio_ret_net"].round(4)) == [0.0, 0.0, 0.03, -0.01, 0.0, 0.0]
    assert list(w["n_trades"]) == [0, 0, 2, 1, 0, 0]
    assert portfolio_metrics(w)["n_weeks"] == 6


def test_d2_no_trades_at_all_is_a_flat_series():
    cal = list(pd.date_range(AS_OF, periods=4, freq="W-MON"))
    w = weekly_portfolio_returns(pd.DataFrame(columns=["week_start", "ret_pct_net"]), calendar=cal)
    assert len(w) == 4 and (w["portfolio_ret_net"] == 0).all()


def test_d5_rejections_list_every_untaken_survivor():
    rule_spec = {"trade": {"max_r_pct": 0.15}}
    surv = pd.DataFrame([{"ticker": "A", "close": 100.0, "vstop_line": 90.0},
                         {"ticker": "B", "close": 100.0, "vstop_line": 80.0},
                         {"ticker": "C", "close": 100.0, "vstop_line": np.nan}])
    trades = pd.DataFrame([{"ticker": "A"}])
    rej = trade_rejections(surv, trades, rule_spec, AS_OF)
    assert dict(zip(rej["ticker"], rej["reason"])) == {"B": "risk_cap", "C": "no_stop"}
    assert rej.loc[rej["ticker"] == "B", "R_pct_of_close"].iloc[0] == pytest.approx(20.0)


def test_d5_no_survivors_is_empty_not_an_error():
    assert trade_rejections(pd.DataFrame(), pd.DataFrame(), {"trade": {"max_r_pct": 0.15}}, AS_OF).empty
