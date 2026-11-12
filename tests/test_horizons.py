"""
Step 5 extended (docs/literal-spec-plan.md, added 27 Sep 2026): grade_horizons()
behavioral tests -- the trailing-stop trade view, the signal/trade freeze-on-exit
divergence, step returns, and benchmark/excess. Leakage is covered separately in
tests/test_leakage.py::test_grade_horizons_future_mutation_canary.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.backtest.horizons import grade_horizons
from src.indicators.vstop import compute_vstop
from tests.offline import make_panel

RULE_SPEC = {"signals": [{"id": "vstop_flip", "params": {"length": 10, "mult": 2.0, "source": "close"}}]}


def _crash_and_recover_panel():
    """14 weeks of smooth uptrend (warmup + entry week, index 13), then: week 14 a
    mild continuation (no stop hit), week 15 a hard crash that gaps below any
    plausible VStop line, week 16 a full recovery. Entry SL is read off the SAME
    compute_vstop() grade_horizons() itself calls, so the test doesn't guess ATR math
    -- it only asserts the WALK's behaviour (freeze on exit, trailing stop source),
    which is the part this feature actually adds."""
    warmup = np.linspace(100.0, 140.0, 14)
    closes = np.concatenate([warmup, [145.0, 25.0, 200.0]])
    panel = make_panel(closes, start="2024-01-01")
    vdf = compute_vstop(panel, length=10, mult=2.0, source="close")
    entry_idx = 13
    entry_SL = float(vdf.loc[entry_idx, "vstop_line"])
    week14_stop = float(vdf.loc[14, "vstop_line"])  # what step 2 must use as prev_stop, not entry_SL
    as_of = panel["date"].iloc[entry_idx]
    ep = float(panel["close"].iloc[entry_idx])
    pick = {"ticker": "T.NS", "EP": ep, "SL": entry_SL}
    return pick, {"T.NS": panel}, as_of, ep, entry_SL, week14_stop


def test_no_stop_hit_signal_and_trade_agree_at_horizon_1():
    pick, panels, as_of, ep, entry_SL, _ = _crash_and_recover_panel()
    rows = grade_horizons([pick], panels, as_of, [1, 2, 3], bench=None, rule_spec=RULE_SPEC)
    by = {(r["horizon_weeks"], r["view"]): r for r in rows}
    expected_r1 = round((145.0 - ep) / ep * 100, 4)
    assert by[(1, "signal")]["r_Nw"] == pytest.approx(expected_r1)
    assert by[(1, "trade")]["r_Nw"] == pytest.approx(expected_r1)
    assert by[(1, "trade")]["exit_reason"] == "open"
    assert by[(1, "trade")]["sl_hit_week"] is None


def test_gap_stop_freezes_trade_view_but_signal_view_reflects_recovery():
    pick, panels, as_of, ep, entry_SL, week14_stop = _crash_and_recover_panel()
    rows = grade_horizons([pick], panels, as_of, [1, 2, 3], bench=None, rule_spec=RULE_SPEC)
    by = {(r["horizon_weeks"], r["view"]): r for r in rows}

    # week 15 (horizon 2) opens/closes at 25 -- a real crash, both views see it the
    # same way because the trade hasn't exited before this week happens.
    expected_r2 = round((25.0 - ep) / ep * 100, 4)
    assert by[(2, "signal")]["r_Nw"] == pytest.approx(expected_r2)
    assert by[(2, "trade")]["r_Nw"] == pytest.approx(expected_r2)
    assert by[(2, "trade")]["exit_reason"] == "gap_stop_at_open"
    assert by[(2, "trade")]["sl_level_used"] == pytest.approx(week14_stop)
    assert by[(2, "trade")]["sl_hit_week"] == str(pd.Timestamp(as_of + pd.Timedelta(weeks=2)).date())

    # week 16 (horizon 3) recovers to 200 -- signal view follows it, trade view stays
    # frozen at the week-15 exit price (the brief's "carries forward unchanged").
    expected_r3_signal = round((200.0 - ep) / ep * 100, 4)
    assert by[(3, "signal")]["r_Nw"] == pytest.approx(expected_r3_signal)
    assert by[(3, "trade")]["r_Nw"] == pytest.approx(expected_r2)  # frozen, identical to horizon 2
    assert by[(3, "trade")]["exit_reason"] == "gap_stop_at_open"
    assert by[(3, "trade")]["sl_hit_week"] == by[(2, "trade")]["sl_hit_week"]


def test_trailing_stop_uses_prior_closed_week_line_not_entry_line():
    """The stop used to grade horizon 2 must be week 14's OWN closed VStop line
    (trailing week-by-week, Dharmin's decision 27 Sep 2026), not the entry SL
    reused unchanged -- the two differ in this fixture (uptrend still climbing at
    week 14), so this is a real behavioural check, not a tautology."""
    pick, panels, as_of, ep, entry_SL, week14_stop = _crash_and_recover_panel()
    assert week14_stop != pytest.approx(entry_SL), "fixture must have a moving stop to test trailing"
    rows = grade_horizons([pick], panels, as_of, [2], bench=None, rule_spec=RULE_SPEC)
    trade_row = next(r for r in rows if r["view"] == "trade")
    assert trade_row["sl_level_used"] == pytest.approx(week14_stop)


def test_step_returns_zero_once_frozen_but_track_recovery_on_signal_view():
    pick, panels, as_of, ep, entry_SL, _ = _crash_and_recover_panel()
    rows = grade_horizons([pick], panels, as_of, [1, 2, 3], bench=None, rule_spec=RULE_SPEC)
    by = {(r["horizon_weeks"], r["view"]): r for r in rows}
    # trade view: nothing moves between horizon 2 and 3 once exited.
    assert by[(3, "trade")]["step_ret"] == pytest.approx(0.0, abs=1e-6)
    # signal view: the week-16 recovery shows up as a large positive step.
    assert by[(3, "signal")]["step_ret"] > 50.0
    assert by[(1, "signal")]["step_ret"] is None  # no horizon 0 to step from


def test_benchmark_and_excess_return():
    pick, panels, as_of, ep, entry_SL, _ = _crash_and_recover_panel()
    # A flat benchmark that never moves -- excess should equal the raw return exactly.
    bench_dates = pd.date_range(as_of - pd.Timedelta(weeks=1), periods=6, freq="W-MON")
    bench = pd.DataFrame({"date": bench_dates, "close": [1000.0] * len(bench_dates)})
    rows = grade_horizons([pick], panels, as_of, [1], bench=bench, rule_spec=RULE_SPEC)
    row = next(r for r in rows if r["view"] == "signal")
    assert row["bench_Nw"] == pytest.approx(0.0, abs=1e-6)
    assert row["excess_Nw"] == pytest.approx(row["r_Nw"])


def test_missing_panel_is_pending_not_a_crash():
    rows = grade_horizons([{"ticker": "MISSING.NS", "EP": 100.0, "SL": 90.0}], {}, pd.Timestamp("2024-01-01"),
                           [1, 2, 3], bench=None, rule_spec=RULE_SPEC)
    assert all(r["status"] == "pending" for r in rows)
    assert len(rows) == 6  # 3 horizons x 2 views
