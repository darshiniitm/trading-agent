"""
Daily -> weekly bar resampling (docs/open-decisions-implementation-plan.md §2 step 1, §4).

Produces bars in exactly the shape the weekly pipeline expects: one row per ticker per
calendar week, dated on that week's MONDAY (the same convention as yfinance `interval="1wk"`
and tests/track_forward.py's signal_week_note), open = first session's open, high = max,
low = min, close = last session's close, volume = sum.

Used to build weekly history from 2019 onward for the dev and holdout_ext segments. The
live/forward weekly path (OpenSourceAdapter.weekly_ohlcv, data_cache/weekly_ohlcv_260w.parquet)
is untouched.
"""
from __future__ import annotations

import pandas as pd

WEEKLY_COLS = ["ticker", "date", "open", "high", "low", "close", "volume"]


def daily_to_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    """daily: long frame [ticker, date, open, high, low, close, volume] (any order)."""
    if daily.empty:
        return pd.DataFrame(columns=WEEKLY_COLS)
    d = daily.dropna(subset=["open", "high", "low", "close"]).copy()
    d["date"] = pd.to_datetime(d["date"]).dt.tz_localize(None).dt.normalize()
    d["week"] = d["date"] - pd.to_timedelta(d["date"].dt.weekday, unit="D")   # Monday of that week
    d = d.sort_values(["ticker", "date"])
    g = d.groupby(["ticker", "week"], sort=True)
    out = pd.DataFrame({
        "open": g["open"].first(), "high": g["high"].max(), "low": g["low"].min(),
        "close": g["close"].last(), "volume": g["volume"].sum(min_count=1),
    }).reset_index().rename(columns={"week": "date"})
    return out[WEEKLY_COLS]


def compare_to_weekly(resampled: pd.DataFrame, weekly: pd.DataFrame, price_tol: float = 0.001,
                      volume_tol: float = 0.01) -> dict:
    """Integrity check on the overlap: fraction of ticker-weeks whose OHLC match within
    `price_tol` (relative) and volume within `volume_tol`. Returns counts plus the mismatches."""
    w = weekly.copy()
    w["date"] = pd.to_datetime(w["date"]).dt.tz_localize(None).dt.normalize()
    m = w.merge(resampled, on=["ticker", "date"], suffixes=("_w", "_r"), how="inner")
    if m.empty:
        return {"n_overlap": 0, "match_rate": None, "mismatches": pd.DataFrame()}
    ok = pd.Series(True, index=m.index)
    for c in ("open", "high", "low", "close"):
        ok &= ((m[f"{c}_r"] - m[f"{c}_w"]).abs() <= price_tol * m[f"{c}_w"].abs())
    vol_ok = ((m["volume_r"] - m["volume_w"]).abs() <= volume_tol * m["volume_w"].abs().clip(lower=1))
    ok_all = ok & vol_ok
    return {"n_overlap": int(len(m)), "price_match_rate": float(ok.mean()),
            "match_rate": float(ok_all.mean()), "mismatches": m.loc[~ok_all]}
