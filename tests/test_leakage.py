"""
Leakage probes — test plan section 7. The highest-value tests in the suite.

Look-ahead is the rank-1 defect: silent, flattering, and invisible to ordinary
testing. These probes detect it structurally rather than by inspection.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.screen.engine import run_screen, _slice_as_of
from src.trade.builder import build_trades
from src.backtest.harness import single_week_check
from src.backtest.horizons import grade_horizons
from tests.offline import env, all_dates, make_panel

RNG = np.random.default_rng(20260829)


def _corrupt_after(panels: dict, as_of: pd.Timestamp) -> dict:
    """Replace every bar strictly after as_of with garbage, preserving shape."""
    out = {}
    for t, p in panels.items():
        q = p.copy(deep=True)
        mask = q["date"] > as_of
        n = int(mask.sum())
        if n:
            noise = RNG.uniform(1.0, 5000.0, size=n)
            q.loc[mask, "open"] = noise
            q.loc[mask, "high"] = noise * 1.5
            q.loc[mask, "low"] = noise * 0.5
            q.loc[mask, "close"] = noise
            q.loc[mask, "volume"] = RNG.uniform(0, 1e9, size=n)
        out[t] = q
    return out


def _truncate_after(panels: dict, as_of: pd.Timestamp) -> dict:
    return {t: p[p["date"] <= as_of].reset_index(drop=True).copy() for t, p in panels.items()}


def _comparable(screen_result) -> pd.DataFrame:
    s = screen_result["survivors"]
    if s.empty:
        return s
    cols = [c for c in ["ticker", "close", "vstop_line", "rsi", "atr", "mktcap_cr",
                        "flip_up", "uptrend", "median_weekly_turnover_cr"] if c in s.columns]
    return s[cols].sort_values("ticker").reset_index(drop=True)


AS_OF_OFFSETS = [-3, -20, -60]


@pytest.mark.parametrize("offset", AS_OF_OFFSETS)
def test_future_mutation_canary(offset):
    """
    THE canary: corrupt every bar after as_of. The screen's decision for as_of
    must be bit-identical. If it isn't, future data is reaching a past decision.
    """
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[offset]

    base = _comparable(run_screen(as_of, rule_spec, adapter, uni, panels, shares))
    mutated_panels = _corrupt_after(panels, as_of)
    mutated = _comparable(run_screen(as_of, rule_spec, adapter, uni, mutated_panels, shares))

    assert len(base) == len(mutated), (
        f"survivor COUNT changed when future data was corrupted "
        f"({len(base)} -> {len(mutated)}) at as_of={as_of.date()} — LOOK-AHEAD LEAK"
    )
    pd.testing.assert_frame_equal(base, mutated, check_exact=False, rtol=1e-12,
                                  obj=f"survivors at as_of={as_of.date()}")


@pytest.mark.parametrize("offset", AS_OF_OFFSETS)
def test_truncation_equivalence(offset):
    """Screening on full history sliced to as_of == screening on history that ENDS at as_of."""
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[offset]

    full = _comparable(run_screen(as_of, rule_spec, adapter, uni, panels, shares))
    trunc = _comparable(run_screen(as_of, rule_spec, adapter, uni, _truncate_after(panels, as_of), shares))
    pd.testing.assert_frame_equal(full, trunc, check_exact=False, rtol=1e-12)


def test_slice_as_of_excludes_future_and_is_inclusive_of_as_of():
    rule_spec, adapter, uni, panels, shares = env()
    dates = all_dates(panels)
    as_of = dates[-10]
    p = panels[next(iter(panels))]
    sliced = _slice_as_of(p, as_of)
    assert (sliced["date"] <= as_of).all(), "slice leaked a future bar"
    if (p["date"] == as_of).any():
        assert (sliced["date"] == as_of).any(), "as_of bar itself must be included (inclusive)"


@pytest.mark.parametrize("offset", [-3, -20])
def test_entry_is_strictly_after_signal(offset):
    """
    Entry-timing probe: EP must be the OPEN of a bar strictly AFTER the signal bar.
    Entering at the signal week's own close silently gifts the strategy a free week.
    """
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[offset]
    out = single_week_check(as_of, rule_spec, adapter, uni, panels, shares)
    graded = out["graded"]
    if graded.empty:
        pytest.skip("no graded trades at this as_of")

    for _, t in graded.iterrows():
        p = panels[t["ticker"]]
        nxt = p[p["date"] > as_of].sort_values("date").iloc[0]
        assert t["week_end"] > as_of, "exit bar must be after the signal bar"
        assert t["EP"] == pytest.approx(float(nxt["open"])), (
            f"{t['ticker']}: EP {t['EP']} is not the next bar's open {nxt['open']}"
        )
        signal_close = float(p[p["date"] == as_of]["close"].iloc[0])
        # EP coinciding with the signal close would be the classic off-by-one.
        # Only meaningful when open != close for that bar.
        if abs(float(nxt["open"]) - signal_close) > 1e-9:
            assert t["EP"] != pytest.approx(signal_close), "EP equals SIGNAL week close — off-by-one entry"


def test_live_screen_cannot_grade_itself():
    """At the newest as_of there is no forward bar; grading must yield nothing, not a fabricated number."""
    rule_spec, adapter, uni, panels, shares = env()
    last = all_dates(panels)[-1]
    out = single_week_check(last, rule_spec, adapter, uni, panels, shares)
    assert out["graded"].empty, "graded trades produced for a week that has not happened yet"


def test_build_trades_live_marks_entry_pending():
    """Live screen (no next-week data) must mark EP as pending, never as a real fill."""
    rule_spec, adapter, uni, panels, shares = env()
    last = all_dates(panels)[-1]
    res = run_screen(last, rule_spec, adapter, uni, panels, shares)
    trades = build_trades(res["survivors"], rule_spec)
    if trades.empty:
        pytest.skip("no survivors at last as_of")
    assert (trades["entry_status"] == "pending_next_week_open").all()


def _horizon_test_setup():
    """One ticker, a clean uptrend long enough for VStop's 10-week warmup plus every
    horizon plus room to corrupt beyond it. No stop ever triggers (SL pinned far below
    every close) -- this canary is about leakage, not stop-hit behaviour."""
    closes = np.linspace(100.0, 160.0, 30)
    panel = make_panel(closes, start="2024-01-01")  # Monday-dated weekly bars
    ticker = "T.NS"
    as_of = panel["date"].iloc[14]
    ep = float(panel[panel["date"] == as_of]["close"].iloc[0])
    pick = {"ticker": ticker, "EP": ep, "SL": 1.0}
    rule_spec = {"signals": [{"id": "vstop_flip", "params": {"length": 10, "mult": 2.0, "source": "close"}}]}
    return pick, {ticker: panel}, as_of, rule_spec


def _corrupt_weekly_after(panels: dict, boundary: pd.Timestamp) -> dict:
    out = {}
    for t, p in panels.items():
        q = p.copy(deep=True)
        mask = q["date"] > boundary
        n = int(mask.sum())
        if n:
            noise = RNG.uniform(1.0, 5000.0, size=n)
            q.loc[mask, ["open", "high", "low", "close"]] = np.column_stack(
                [noise, noise * 1.5, noise * 0.5, noise])
        out[t] = q
    return out


@pytest.mark.parametrize("horizon", [1, 2, 3])
def test_grade_horizons_future_mutation_canary(horizon):
    """A horizon-N grade for signal Friday t may only read bars up to t+N. Corrupting
    every bar strictly after that boundary must not change horizon N's row, in EITHER
    view -- if it does, a later week's data reached an earlier horizon's grade."""
    pick, panels, as_of, rule_spec = _horizon_test_setup()
    horizons = [1, 2, 3]

    base_rows = grade_horizons([pick], panels, as_of, horizons, bench=None, rule_spec=rule_spec)
    boundary = as_of + pd.Timedelta(weeks=horizon)
    mutated_rows = grade_horizons([pick], _corrupt_weekly_after(panels, boundary), as_of, horizons,
                                   bench=None, rule_spec=rule_spec)

    def _row_at(rows, h, view):
        return next(r for r in rows if r["horizon_weeks"] == h and r["view"] == view)

    for view in ("signal", "trade"):
        base_row = _row_at(base_rows, horizon, view)
        mut_row = _row_at(mutated_rows, horizon, view)
        assert base_row["status"] == "graded", f"horizon {horizon} ({view}) should be gradable in this setup"
        assert mut_row["r_Nw"] == pytest.approx(base_row["r_Nw"]), (
            f"horizon {horizon} ({view}) return changed when data after t+{horizon} was "
            f"corrupted — LOOK-AHEAD LEAK"
        )
        assert mut_row["mdd_to_Nw"] == pytest.approx(base_row["mdd_to_Nw"]), (
            f"horizon {horizon} ({view}) drawdown changed when future-only data was corrupted"
        )


def test_grade_horizons_pending_never_guesses_an_ungraded_horizon():
    """A horizon that hasn't happened yet in the data available must be 'pending',
    never a fabricated number."""
    closes = np.linspace(100.0, 130.0, 16)  # only 1 week of forward data past week 14
    panel = make_panel(closes, start="2024-01-01")
    ticker = "T.NS"
    as_of = panel["date"].iloc[14]
    pick = {"ticker": ticker, "EP": float(panel[panel["date"] == as_of]["close"].iloc[0]), "SL": 1.0}
    rule_spec = {"signals": [{"id": "vstop_flip", "params": {"length": 10, "mult": 2.0, "source": "close"}}]}

    rows = grade_horizons([pick], {ticker: panel}, as_of, [1, 2, 3], bench=None, rule_spec=rule_spec)
    by_h = {(r["horizon_weeks"], r["view"]): r for r in rows}
    assert by_h[(1, "signal")]["status"] == "graded"
    assert by_h[(2, "signal")]["status"] == "pending"
    assert by_h[(2, "signal")]["r_Nw"] is None
    assert by_h[(3, "trade")]["status"] == "pending"
