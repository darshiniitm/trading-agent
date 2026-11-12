"""T-05: on the real offline cache, the matrix's A01&A03 / A01&A03&A04 sets equal
Control's actual survivors/trades for that week (I2/I3, checked directly here
rather than only via the CLI)."""
from __future__ import annotations

from src.flags.matrix import build_flag_matrix
from src.flags.registry import load_registry
from src.screen.engine import run_screen
from src.trade.builder import build_trades
from tests.offline import all_dates, env


def test_i2_i3_hold_on_last_cached_week():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[-1]
    registry = load_registry()
    df, manifest = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares)

    control_res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    control_survivors = set(control_res["survivors"]["ticker"]) if not control_res["survivors"].empty else set()
    trades = build_trades(control_res["survivors"], rule_spec)
    control_trades = set(trades["ticker"]) if not trades.empty else set()

    matrix_survivors = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1), "ticker"])
    matrix_trades = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1)
                                & (df["A04_risk_cap_ok"] == 1), "ticker"])

    assert matrix_survivors == control_survivors
    assert matrix_trades == control_trades


def test_2026_09_07_matches_the_recorded_picks_file():
    """Pinned real-data regression: the actual Control survivors/trades for the
    2026-09-07 signal week, cross-checked against the flag matrix."""
    rule_spec, adapter, uni, panels, shares = env()
    import pandas as pd
    as_of = pd.Timestamp("2026-09-07")
    registry = load_registry()
    df, manifest = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares)

    assert len(df) == 264
    a01_a03 = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1), "ticker"])
    a01_a03_a04 = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1)
                              & (df["A04_risk_cap_ok"] == 1), "ticker"])
    assert a01_a03 == {"JUBLPHARMA.NS", "PINELABS.NS", "SPLPETRO.NS"}
    assert a01_a03_a04 == {"JUBLPHARMA.NS", "SPLPETRO.NS"}
