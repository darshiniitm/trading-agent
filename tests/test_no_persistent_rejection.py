"""
Housekeeping check (docs/forward-test-response-and-volume-plan.md §3.2 table):
a name rejected by the 15% risk cap in one week must be re-screened fresh next
week, never silently excluded going forward.

build_trades() takes no state beyond its own arguments and run_screen() takes
no state across calls, so nothing in the codebase can carry a rejection from
one week into the next. This is asserted directly rather than only by
inspection.
"""
from __future__ import annotations

import pandas as pd

from src.trade.builder import build_trades
from tests.offline import env


def _survivor_row(ticker: str, close: float, sl: float, rsi: float = 57.5) -> pd.DataFrame:
    return pd.DataFrame([{
        "ticker": ticker,
        "name": ticker,
        "sector": "Test",
        "close": close,
        "vstop_line": sl,
        "rsi": rsi,
        "atr": close * 0.02,
        "volume": 1_000_000.0,
        "avg_vol_8w": 1_000_000.0,
        "median_weekly_turnover_cr": 20.0,
        "mktcap_cr": 20000.0,
    }])


def test_risk_cap_rejection_does_not_carry_into_next_call():
    rule_spec, *_ = env()
    ticker = "SAMENAME.NS"

    # Week 1: SL implausibly far below close -> R/EP > 15% -> rejected.
    wide = _survivor_row(ticker, close=100.0, sl=80.0)
    week1 = build_trades(wide, rule_spec)
    assert ticker not in set(week1["ticker"]) if not week1.empty else True

    # Week 2: same ticker, SL now close to entry -> R/EP within cap -> accepted.
    tight = _survivor_row(ticker, close=100.0, sl=92.0)
    week2 = build_trades(tight, rule_spec)
    assert ticker in set(week2["ticker"]), (
        "a ticker rejected by the risk cap in a prior call was excluded again "
        "even though this call's own R/EP is within the cap — some state is "
        "leaking across calls"
    )

    # Order shouldn't matter either: re-run week 1's wide-SL case again, after
    # week 2 already accepted the same ticker, and confirm it's rejected again
    # on its own merits (not remembered as previously accepted).
    week1_again = build_trades(wide, rule_spec)
    assert ticker not in (set(week1_again["ticker"]) if not week1_again.empty else set())


def test_run_screen_has_no_module_level_mutable_rejection_state():
    """Static guard: run_screen()/build_trades() must stay pure functions of
    their arguments. A module-level mutable default (e.g. a set/dict used to
    remember rejected tickers) would defeat the re-screening-every-week
    guarantee the plan doc asks for."""
    import inspect

    import src.screen.engine as engine_mod
    import src.trade.builder as builder_mod

    for mod in (engine_mod, builder_mod):
        for name, val in vars(mod).items():
            if name.startswith("_"):
                continue
            assert not isinstance(val, (set, dict, list)), (
                f"{mod.__name__}.{name} is a module-level mutable {type(val).__name__} "
                f"— could accumulate state across screening calls"
            )
