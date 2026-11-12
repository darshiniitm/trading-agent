"""RSI(period), Wilder smoothing, weekly close (design doc §4.3)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _wilder_smooth_sma_seeded(x: pd.Series, period: int) -> pd.Series:
    """Textbook Wilder smoothing: seed at index `period` with a simple average of
    x[1..period] (x[0] is always NaN, the diff series' leading value), then recurse
    avg[i] = (avg[i-1]*(period-1) + x[i]) / period from index `period+1` onward.

    Confirmed against TradingView 2026-09-29 (docs/forward_test_findings.md): the
    previous `ewm(alpha=1/period, adjust=False)`-from-bar-1 shortcut matched fine for
    long-history tickers (the seed choice decays away after ~150+ bars at this alpha)
    but materially diverged for short-history/recent-IPO tickers, where the seed
    hasn't decayed yet -- e.g. URBANCO.NS (54 weekly bars): 62.99 (old) vs 64.5667
    (this seeding, matching TradingView's 64.57 to within 0.003)."""
    n = len(x)
    out = np.full(n, np.nan)
    if n <= period:
        return pd.Series(out, index=x.index)
    out[period] = x.iloc[1:period + 1].mean()
    for i in range(period + 1, n):
        out[i] = (out[i - 1] * (period - 1) + x.iloc[i]) / period
    return pd.Series(out, index=x.index)


def compute_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = _wilder_smooth_sma_seeded(gain, period)
    avg_loss = _wilder_smooth_sma_seeded(loss, period)
    rs = avg_gain / avg_loss.replace(0, float("nan"))
    rsi = 100 - (100 / (1 + rs))
    # avg_loss == 0 -> 100, unconditionally (matches TradingView's Pine v6 RSI:
    # `down == 0 ? 100 : ...`, confirmed against the real source 2026-09-29) --
    # including a truly flat series (avg_gain also 0). D4 (26 Sep 2026) used to
    # override this one case to a neutral 50; reverted 2026-09-29 once the real
    # TradingView source confirmed 100 is correct, and an Explore agent confirmed
    # the flat case never fires on any real screening candidate (only on suspended/
    # illiquid tickers that fail liquidity/market-cap filters regardless) -- see
    # docs/forward_test_findings.md's dated entry.
    rsi = rsi.where(avg_loss != 0, 100.0)
    return rsi
