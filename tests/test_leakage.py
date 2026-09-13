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
from tests.offline import env, all_dates

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
