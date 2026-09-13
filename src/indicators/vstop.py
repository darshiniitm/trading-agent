"""
VStop(length, mult) — ATR-based volatility stop (design doc §4.2).

Matches TradingView's built-in "Volatility Stop" recurrence, not
SuperTrend / Chandelier Exit / PSAR (those use different math).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def wilder_atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    # Wilder smoothing == RMA, equivalent to ewm(alpha=1/length, adjust=False)
    atr = tr.ewm(alpha=1 / length, adjust=False, min_periods=length).mean()
    return atr


def compute_vstop(df: pd.DataFrame, length: int = 10, mult: float = 2.0, source: str = "close") -> pd.DataFrame:
    """
    df must have columns: open, high, low, close (weekly bars, ascending date order).
    Returns df with added columns: atr, stop, uptrend, flip_up, flip_down.
    """
    df = df.reset_index(drop=True).copy()
    atr = wilder_atr(df["high"], df["low"], df["close"], length)
    src = df[source]

    n = len(df)
    stop = np.full(n, np.nan)
    uptrend = np.full(n, False)
    max_ = np.nan
    min_ = np.nan
    prev_stop = np.nan
    prev_uptrend = True  # arbitrary seed; first `length` bars are warmup and unreliable anyway

    for i in range(n):
        band = mult * atr.iloc[i]
        s = src.iloc[i]
        if np.isnan(band):
            stop[i] = np.nan
            uptrend[i] = prev_uptrend
            continue

        if np.isnan(max_):
            max_, min_ = s, s
            prev_stop = s - band if prev_uptrend else s + band

        max_ = max(max_, s)
        min_ = min(min_, s)

        candidate = max(prev_stop, max_ - band) if prev_uptrend else min(prev_stop, min_ + band)
        new_uptrend = (s - candidate) >= 0

        if new_uptrend != prev_uptrend:
            max_, min_ = s, s
            candidate = (max_ - band) if new_uptrend else (min_ + band)

        stop[i] = candidate
        uptrend[i] = new_uptrend
        prev_stop = candidate
        prev_uptrend = new_uptrend

    df["atr"] = atr
    df["vstop_line"] = stop
    df["uptrend"] = uptrend
    df["flip_up"] = df["uptrend"] & (~df["uptrend"].shift(1).fillna(False).infer_objects(copy=False).astype(bool))
    df["flip_down"] = (~df["uptrend"]) & (df["uptrend"].shift(1).fillna(True).infer_objects(copy=False).astype(bool))
    # first `length` bars are warmup (ATR not yet stable) — never trust a flip there
    df.loc[: length - 1, ["flip_up", "flip_down"]] = False
    return df
