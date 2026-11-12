"""Volatility Stop, ported statement-for-statement from TradingView's built-in Pine v6 script
("Volatility Stop", VStop). Used by the v5 engine.

Differs from src/indicators/vstop.py (the frozen Control version) in exactly the two ways found
on 2026-10-07 by comparing against the Pine source:
  * ATR is Pine's ta.atr: RMA seeded with the simple average of the first `length` true ranges
    (not an exponential average started at bar one);
  * the loop runs from the first bar, and until ATR exists the band is the raw true range
    (Pine: nz(ta.atr(len) * factor, ta.tr)), so max/min/stop are seeded from bar one, not from
    the first bar that has an ATR.
Pine's `math.max(na, x)` is na, so the first bar's stop falls through nz() to the source.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def compute_vstop_tv(df: pd.DataFrame, length: int = 20, mult: float = 2.0, source: str = "close") -> pd.DataFrame:
    h, l, c = (df[k].to_numpy(dtype=float) for k in ("high", "low", "close"))
    src = df[source].to_numpy(dtype=float)
    n = len(df)
    prev_close = np.r_[np.nan, c[:-1]]
    tr = np.where(np.isnan(prev_close), h - l, np.maximum.reduce([h - l, np.abs(h - prev_close), np.abs(l - prev_close)]))

    atr = np.full(n, np.nan)
    if n >= length:
        atr[length - 1] = tr[:length].mean()
        for i in range(length, n):
            atr[i] = (atr[i - 1] * (length - 1) + tr[i]) / length

    line = np.full(n, np.nan)
    up = np.full(n, True)
    flip_up = np.zeros(n, dtype=bool)
    flip_down = np.zeros(n, dtype=bool)
    mx = mn = src[0] if n else np.nan
    uptrend, stop = True, np.nan
    for i in range(n):
        atr_m = atr[i] * mult if not np.isnan(atr[i]) else tr[i]
        mx = max(mx, src[i])
        mn = min(mn, src[i])
        prev_up = uptrend
        cand = np.nan if np.isnan(stop) else (max(stop, mx - atr_m) if prev_up else min(stop, mn + atr_m))
        stop = src[i] if np.isnan(cand) else cand
        uptrend = src[i] - stop >= 0.0
        if uptrend != prev_up and i > 0:
            mx = mn = src[i]
            stop = mx - atr_m if uptrend else mn + atr_m
            flip_up[i], flip_down[i] = uptrend, not uptrend
        line[i], up[i] = stop, uptrend
    # drop-in for src/indicators/vstop.py: the input columns come back too (callers read df["close"] etc.)
    out = df.reset_index(drop=True).copy()
    out["atr"], out["vstop_line"], out["uptrend"], out["flip_up"], out["flip_down"] = atr, line, up, flip_up, flip_down
    return out
