"""
Invariants I1-I10 (docs/feature-flag-matrix-plan.md §9.2), run on every record.

Each check returns {"id", "status": PASS|FAIL|WARN, "detail": str}. I8/I9
(no-future-bar-used / cache freshness) are checked at whatever precision the
adapter interface actually exposes today — src/data/adapter.py has no
per-fetch timestamp, so I9 is reported WARN "not observable at this layer"
rather than faked as PASS; the leakage-corruption probe (T-06, reusing
tests/test_leakage.py's helpers) is the real enforcement for point-in-time
correctness, same as it is for Control.
"""
from __future__ import annotations

import pandas as pd

NESTED_RULES = [("C01_risk_headroom_5pp", "A04_risk_cap_ok"),
                 ("A04_risk_cap_ok", "A02_vstop_uptrend"),
                 ("B05_trend_quality_strong", "A02_vstop_uptrend"),
                 ("B02_sector_top_k", "B01_sector_rs_4w_pos")]


def _check(id_, status, detail):
    return {"id": id_, "status": status, "detail": detail}


def check_i1_row_count(df: pd.DataFrame, funnel: dict) -> dict:
    expected = funnel.get("liquidity_filter")
    actual = len(df)
    ok = actual == expected
    return _check("I1", "PASS" if ok else "FAIL", f"rows={actual} expected(liquidity_filter)={expected}")


def check_i2_survivors(df: pd.DataFrame, control_survivor_tickers: set[str]) -> dict:
    matrix_set = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1), "ticker"])
    ok = matrix_set == control_survivor_tickers
    return _check("I2", "PASS" if ok else "FAIL",
                  f"matrix={sorted(matrix_set)} control={sorted(control_survivor_tickers)}")


def check_i3_trades(df: pd.DataFrame, control_trade_tickers: set[str]) -> dict:
    matrix_set = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1)
                             & (df["A04_risk_cap_ok"] == 1), "ticker"])
    ok = matrix_set == control_trade_tickers
    return _check("I3", "PASS" if ok else "FAIL",
                  f"matrix={sorted(matrix_set)} control={sorted(control_trade_tickers)}")


def check_i4_flags_met_math(df: pd.DataFrame, countable_ids: list[str]) -> dict:
    if df.empty:
        return _check("I4", "PASS", "no rows")
    bad = []
    for _, row in df.iterrows():
        if row.get("eligible_reason") == "insufficient_history":
            continue
        vals = [row[c] for c in countable_ids]
        evaluable = sum(1 for v in vals if v is not None and not pd.isna(v))
        met = sum(int(v) for v in vals if v is not None and not pd.isna(v) and v == 1)
        if met != row["flags_met"] or evaluable != row["flags_evaluable"]:
            bad.append(row["ticker"])
        if not (0 <= row["flags_met"] <= row["flags_evaluable"] <= len(countable_ids)):
            bad.append(row["ticker"])
    ok = not bad
    return _check("I4", "PASS" if ok else "FAIL", f"bad_tickers={sorted(set(bad))}")


def check_i5_cell_domain(df: pd.DataFrame, flag_ids: list[str]) -> dict:
    bad = []
    for c in flag_ids:
        if c not in df.columns:
            continue
        vals = df[c].dropna()
        if not vals.isin([0, 1]).all():
            bad.append(c)
    ok = not bad
    return _check("I5", "PASS" if ok else "FAIL", f"bad_columns={bad}")


def check_i6_nested_logic(df: pd.DataFrame) -> dict:
    violations = []
    for child, parent in NESTED_RULES:
        if child not in df.columns or parent not in df.columns:
            continue
        bad = df[(df[child] == 1) & (df[parent] != 1)]
        if not bad.empty:
            violations.append(f"{child}=1 does not imply {parent}=1 for {sorted(bad['ticker'])}")
    ok = not violations
    return _check("I6", "PASS" if ok else "FAIL", "; ".join(violations) if violations else "ok")


def check_i7_checksum(manifest: dict, registry_checksum: str) -> dict:
    ok = manifest.get("registry_checksum") == registry_checksum
    return _check("I7", "PASS" if ok else "FAIL",
                  f"manifest={manifest.get('registry_checksum')} current={registry_checksum}")


def check_i8_no_future_bars(panels: dict, as_of: pd.Timestamp) -> dict:
    bad = [t for t, p in panels.items() if not p.empty and pd.Timestamp(p["date"].max()) > pd.Timestamp(as_of)]
    ok = not bad
    return _check("I8", "PASS" if ok else "FAIL", f"tickers_with_future_bars={bad[:10]}")


def check_i9_freshness() -> dict:
    return _check("I9", "WARN", "not observable at this layer — adapter has no per-fetch timestamp")


def check_i10_determinism(df1: pd.DataFrame, df2: pd.DataFrame) -> dict:
    ignore = {"recording_mode"}  # timestamps live in the manifest, not the CSV; nothing else is clock-derived
    cols = [c for c in df1.columns if c not in ignore]
    try:
        pd.testing.assert_frame_equal(df1[cols].reset_index(drop=True), df2[cols].reset_index(drop=True))
        return _check("I10", "PASS", "identical")
    except AssertionError as e:
        return _check("I10", "FAIL", str(e)[:500])


def run_all(df: pd.DataFrame, manifest: dict, funnel: dict, countable_ids: list[str], flag_ids: list[str],
            control_survivor_tickers: set[str], control_trade_tickers: set[str],
            registry_checksum: str, panels: dict, as_of: pd.Timestamp) -> list[dict]:
    return [
        check_i1_row_count(df, funnel),
        check_i2_survivors(df, control_survivor_tickers),
        check_i3_trades(df, control_trade_tickers),
        check_i4_flags_met_math(df, countable_ids),
        check_i5_cell_domain(df, flag_ids),
        check_i6_nested_logic(df),
        check_i7_checksum(manifest, registry_checksum),
        check_i8_no_future_bars(panels, as_of),
        check_i9_freshness(),
    ]
