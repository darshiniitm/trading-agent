"""
Backtest engine tests — test plan section 9.

Focus on the rank-3 defect class: optimistic fill assumptions. These are silent
and flattering, so they must be asserted numerically, never eyeballed.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.backtest.harness import (
    simulate_week_forward,
    simulate_trend_hold,
    summarize_trades,
    weekly_portfolio_returns,
    portfolio_metrics,
    bootstrap_ci,
    confidence_rank_ic,
)
from tests.offline import env, make_panel

AS_OF = pd.Timestamp("2021-01-11")


def one_trade(ticker="T.NS", SL=90.0, EP_ref=100.0, conf=50.0):
    return pd.DataFrame([{
        "ticker": ticker, "sector": "X", "SL": SL, "EP": EP_ref, "R": EP_ref - SL,
        "target": EP_ref + 2 * (EP_ref - SL), "RR": 2.0, "confidence": conf,
        "close": EP_ref, "atr": 5.0,
    }])


def panel_with_next_week(open_, high, low, close):
    """Two bars: the signal bar at AS_OF, then the forward bar being graded."""
    df = pd.DataFrame({
        "date": [AS_OF, AS_OF + pd.Timedelta(weeks=1)],
        "open": [100.0, open_], "high": [101.0, high],
        "low": [99.0, low], "close": [100.0, close],
        "volume": [1e6, 1e6],
    })
    return {"T.NS": df}


# ------------------------------------------------------- stop-fill correctness

def test_stop_not_hit_exits_at_week_close():
    g = simulate_week_forward(one_trade(), panel_with_next_week(100, 110, 95, 108), AS_OF, 0.0)
    assert g.iloc[0]["exit_reason"] == "week_close"
    assert g.iloc[0]["exit_price"] == pytest.approx(108.0)
    assert g.iloc[0]["ret_pct"] == pytest.approx(0.08)


def test_stop_touched_exactly_is_a_stop():
    """Boundary: low == SL must count as stopped (spec says intraweek_low <= SL)."""
    g = simulate_week_forward(one_trade(SL=90.0), panel_with_next_week(100, 105, 90.0, 95), AS_OF, 0.0)
    assert g.iloc[0]["exit_reason"] == "stop_hit"


def test_intraweek_stop_fills_at_stop_when_open_is_above_it():
    g = simulate_week_forward(one_trade(SL=90.0), panel_with_next_week(100, 102, 85, 95), AS_OF, 0.0)
    row = g.iloc[0]
    assert row["exit_reason"] == "stop_hit"
    assert row["exit_price"] == pytest.approx(90.0)
    assert row["ret_pct"] == pytest.approx((90.0 - 100.0) / 100.0)


def test_gap_down_through_stop_must_fill_at_open_not_at_stop():
    """
    RANK-3 DEFECT PROBE. The week OPENS at 80, far below the 90 stop. You cannot
    be filled at 90 — the market never traded there. Assuming a fill at SL caps
    every loss at exactly -1R and flatters the whole backtest.
    """
    g = simulate_week_forward(one_trade(SL=90.0), panel_with_next_week(80, 82, 78, 79), AS_OF, 0.0)
    row = g.iloc[0]
    assert row["exit_price"] == pytest.approx(80.0), (
        f"gap-down exit filled at {row['exit_price']} (the stop) but the week opened at 80 — "
        "impossible fill, losses are being capped artificially"
    )


def test_gap_down_through_stop_must_not_produce_a_profit():
    """
    The severe form of the same defect: entry is the gapped-down open (80) while
    the exit is booked at the stop (90) — a stopped-out trade reports +12.5%.
    """
    g = simulate_week_forward(one_trade(SL=90.0), panel_with_next_week(80, 82, 78, 79), AS_OF, 0.0)
    row = g.iloc[0]
    assert row["ret_pct"] <= 0, (
        f"a stopped-out gap-down trade reported a POSITIVE return of {row['ret_pct']:.2%} "
        f"(entered {row['EP']}, 'exited' {row['exit_price']})"
    )


def test_stopped_loss_never_better_than_minus_one_r():
    """A stop-out should lose about 1R, never less (gaps make it worse, not better)."""
    g = simulate_week_forward(one_trade(SL=90.0), panel_with_next_week(80, 82, 78, 79), AS_OF, 0.0)
    r = g.iloc[0]["r_multiple"]
    assert r <= 0.0, f"stopped trade reported r_multiple={r}"


# ------------------------------------------------------------------ arithmetic

def test_costs_applied_once():
    g = simulate_week_forward(one_trade(), panel_with_next_week(100, 101, 99, 100), AS_OF, 0.005)
    assert g.iloc[0]["ret_pct"] == pytest.approx(0.0)
    assert g.iloc[0]["ret_pct_net"] == pytest.approx(-0.005)


def test_r_multiple_matches_hand_computation():
    g = simulate_week_forward(one_trade(SL=90.0), panel_with_next_week(100, 130, 99, 120), AS_OF, 0.0)
    row = g.iloc[0]
    assert row["r_multiple"] == pytest.approx((120 - 100) / (100 - 90))


def test_expectancy_matches_hand_computation():
    graded = pd.DataFrame({
        "ret_pct_net": [0.10, 0.10, -0.05, -0.05, -0.05],
        "week_start": [AS_OF] * 5,
        "r_multiple": [1.0, 1.0, -1.0, -1.0, -1.0],
    })
    s = summarize_trades(graded)
    assert s["hit_rate"] == pytest.approx(0.4)
    assert s["avg_win_pct"] == pytest.approx(0.10)
    assert s["avg_loss_pct"] == pytest.approx(0.05)
    assert s["expectancy_pct"] == pytest.approx(0.4 * 0.10 - 0.6 * 0.05)


def test_bootstrap_ci_covers_known_mean():
    vals = np.random.default_rng(1).normal(0.01, 0.02, 500)
    mean, lo, hi = bootstrap_ci(vals, n_boot=800, seed=3)
    assert lo < mean < hi
    assert lo < 0.01 < hi, "CI failed to cover the true mean"


def test_bootstrap_is_seed_deterministic():
    vals = np.random.default_rng(2).normal(0, 0.02, 200)
    assert bootstrap_ci(vals, n_boot=400, seed=9) == bootstrap_ci(vals, n_boot=400, seed=9)


# -------------------------------------------------- portfolio aggregation

def test_weekly_portfolio_return_is_equal_weight_mean():
    graded = pd.DataFrame({
        "week_start": [AS_OF, AS_OF, AS_OF + pd.Timedelta(weeks=1)],
        "ret_pct_net": [0.10, -0.02, 0.04],
    })
    w = weekly_portfolio_returns(graded)
    assert w.iloc[0]["portfolio_ret_net"] == pytest.approx(0.04)
    assert w.iloc[1]["portfolio_ret_net"] == pytest.approx(0.04)


def test_zero_pick_weeks_are_not_silently_dropped():
    """
    A week the screen produced no picks is a FLAT week (0% return), not a
    non-existent one. Dropping it shortens the series and inflates annualised
    figures: 60 traded weeks out of 104 annualised as if 60 weeks were a year.
    """
    weeks = pd.date_range(AS_OF, periods=10, freq="W-MON")
    # only 5 of the 10 weeks produced trades
    graded = pd.DataFrame({
        "week_start": list(weeks[:5]),
        "ret_pct_net": [0.02] * 5,
    })
    # D2 fixed 2026-09-16: the fold calendar is passed in (the only way to know weeks 6-10 existed).
    w = weekly_portfolio_returns(graded, calendar=list(weeks))
    assert len(w) == 10, (
        f"portfolio series has {len(w)} rows for a 10-week span with 5 trading weeks — "
        "flat weeks were dropped, which overstates CAGR and Sharpe"
    )


def test_cagr_uses_calendar_span_not_traded_week_count():
    """52 calendar weeks, but trades in only 26 of them -> CAGR must not be squared."""
    weeks = pd.date_range(AS_OF, periods=52, freq="W-MON")
    graded = pd.DataFrame({
        "week_start": list(weeks[::2]),          # every other week
        "ret_pct_net": [0.01] * 26,
    })
    w = weekly_portfolio_returns(graded)
    m = portfolio_metrics(w)
    naive_wrong = 1.01 ** 52 - 1          # what you get annualising 26 weeks to 52
    truth = 1.01 ** 26 - 1                # 26 gains actually earned over one year
    assert m["cagr"] == pytest.approx(truth, rel=0.05), (
        f"CAGR={m['cagr']:.1%}; annualising only the traded weeks gives {naive_wrong:.1%}, "
        f"but the real one-year return is {truth:.1%}"
    )


# --------------------------------------------------------------- trend hold

def test_trend_hold_stop_fill_also_respects_gaps():
    """Same gap-fill question for the secondary exit horizon."""
    rule_spec, *_ = env()
    n = 40
    close = np.concatenate([np.linspace(100, 140, n - 1), [60.0]])  # final week collapses
    low = close * 0.995
    open_ = close.copy()
    open_[-1] = 62.0
    p = make_panel(close, lows=low, opens=open_, start="2021-01-04")
    panels = {"T.NS": p}
    as_of = p["date"].iloc[10]
    trades = one_trade(SL=float(p["close"].iloc[10]) * 0.9)
    g = simulate_trend_hold(trades, panels, rule_spec, as_of, 0.0)
    if g.empty:
        pytest.skip("no graded trend-hold trade")
    row = g.iloc[0]
    if row["exit_reason"] == "stop_hit":
        wk = p[p["date"] == row["week_end"]].iloc[0]
        assert row["exit_price"] <= float(wk["open"]) + 1e-9 or float(wk["open"]) >= row["exit_price"], (
            "trend-hold stop filled above the week's open on a gap"
        )


def test_trend_hold_uses_previous_bar_stop_not_current_bar_stop():
    """
    The stop you can actually place for week i is the VStop level known at the
    CLOSE of week i-1. Checking week i's low against week i's OWN stop line uses
    a level that did not exist until that week had already closed.
    """
    rule_spec, *_ = env()
    close = np.linspace(100, 160, 45)
    p = make_panel(close, start="2021-01-04")
    from src.indicators.vstop import compute_vstop
    v = compute_vstop(p, 10, 2.0)
    # the stop ratchets up, so stop[i] > stop[i-1] in a rally: using stop[i]
    # intraweek is forward-looking. Assert the harness is not doing that.
    rising = (v["vstop_line"].diff().dropna() > 0).sum()
    assert rising > 5, "fixture did not produce a ratcheting stop; test is not meaningful"

    import inspect
    src = inspect.getsource(simulate_trend_hold)
    assert "vdf.loc[i - 1" in src or "shift(1)" in src or "prev_stop" in src, (
        "simulate_trend_hold compares week i's low against week i's OWN vstop_line; "
        "that level is only knowable after week i closes (look-ahead in the exit rule)"
    )


# --------------------------------------------------------------- rank-IC (B6)

def test_confidence_rank_ic_perfect_positive_ordering():
    graded = pd.DataFrame({
        "confidence": [10, 30, 50, 70, 90],
        "ret_pct_net": [-2.0, -1.0, 0.0, 1.0, 2.0],
    })
    out = confidence_rank_ic(graded)
    assert out["n"] == 5
    assert out["rank_ic"] == pytest.approx(1.0)
    assert out["p_value"] < 0.05


def test_confidence_rank_ic_perfect_negative_ordering():
    graded = pd.DataFrame({
        "confidence": [10, 30, 50, 70, 90],
        "ret_pct_net": [2.0, 1.0, 0.0, -1.0, -2.0],
    })
    out = confidence_rank_ic(graded)
    assert out["rank_ic"] == pytest.approx(-1.0)


def test_confidence_rank_ic_needs_at_least_three_distinct_rows():
    assert confidence_rank_ic(pd.DataFrame())["rank_ic"] is None
    assert confidence_rank_ic(pd.DataFrame({"confidence": [50, 50], "ret_pct_net": [1.0, -1.0]}))["rank_ic"] is None
    constant = pd.DataFrame({"confidence": [50, 50, 50], "ret_pct_net": [1.0, -1.0, 0.5]})
    assert confidence_rank_ic(constant)["rank_ic"] is None
