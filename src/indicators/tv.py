"""TradingView-compatible building blocks (Wilder RMA with an SMA seed, SMA-seeded EMA, Pine ta.dmi/ta.supertrend).

The engine's registry used pandas ewm (seeded by the first value), which drifts from TradingView on short
histories and on borderline crossovers. These follow the Pine definitions statement for statement; the
independent oracle for them is tests/golden/ref_indicators.py (never imported here)."""
from __future__ import annotations

import numpy as np
import pandas as pd


def rma(x, n: int) -> np.ndarray:
    """Pine ta.rma: SMA seed over the first n values (ignoring a leading NaN run), then Wilder smoothing."""
    x = np.asarray(x, dtype=float)
    out = np.full(len(x), np.nan)
    ok = np.where(~np.isnan(x))[0]
    if len(ok) == 0 or len(x) - ok[0] < n:
        return out
    s = ok[0]
    out[s + n - 1] = x[s:s + n].mean()
    for i in range(s + n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out


def ema(x, n: int) -> np.ndarray:
    """Pine ta.ema: SMA seed, then alpha = 2/(n+1). A leading NaN run (e.g. a MACD line) is skipped."""
    x = np.asarray(x, dtype=float)
    out = np.full(len(x), np.nan)
    ok = np.where(~np.isnan(x))[0]
    if len(ok) == 0 or len(x) - ok[0] < n:
        return out
    s = ok[0]
    a = 2.0 / (n + 1)
    out[s + n - 1] = x[s:s + n].mean()
    for i in range(s + n, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out


def true_range(h, l, c) -> np.ndarray:
    h, l, c = (np.asarray(a, dtype=float) for a in (h, l, c))
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    tr[0] = h[0] - l[0]
    return tr


def atr(h, l, c, n: int) -> np.ndarray:
    return rma(true_range(h, l, c), n)


def macd(close, fast: int, slow: int, signal: int):
    c = np.asarray(close, dtype=float)
    line = ema(c, fast) - ema(c, slow)
    sig = ema(line, signal)
    return line, sig, line - sig


def dmi(h, l, c, n: int):
    """Pine ta.dmi(n, n): (adx, +di, -di)."""
    h, l, c = (np.asarray(a, dtype=float) for a in (h, l, c))
    up = np.diff(h, prepend=np.nan)
    dn = -np.diff(l, prepend=np.nan)
    pdm = np.where((up > dn) & (up > 0), up, 0.0)
    mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pdm[0] = mdm[0] = 0.0
    tr = rma(true_range(h, l, c), n)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = 100 * rma(pdm, n) / tr
        mdi = 100 * rma(mdm, n) / tr
        s = pdi + mdi
        dx = np.where(s == 0, 0.0, np.abs(pdi - mdi) / np.where(s == 0, 1, s))
    return 100 * rma(dx, n), pdi, mdi


def supertrend(h, l, c, factor: float, n: int):
    """Pine ta.supertrend(factor, n): (line, uptrend bool array). NaN line until the ATR exists."""
    h, l, c = (np.asarray(a, dtype=float) for a in (h, l, c))
    a = atr(h, l, c, n)
    src = (h + l) / 2
    ub, lb = src + factor * a, src - factor * a
    size = len(c)
    line = np.full(size, np.nan)
    up = np.full(size, False)
    pub = plb = pst = np.nan
    for i in range(size):
        if np.isnan(a[i]):
            continue
        u, lo = ub[i], lb[i]
        if not np.isnan(plb):
            lo = lo if (lo > plb or c[i - 1] < plb) else plb
            u = u if (u < pub or c[i - 1] > pub) else pub
        if i == 0 or np.isnan(a[i - 1]):
            bull = False
        elif pst == pub:
            bull = c[i] > u
        else:
            bull = not (c[i] < lo)
        line[i] = lo if bull else u
        up[i] = bull
        pub, plb, pst = u, lo, line[i]
    return line, up


def ichimoku(h, l, c, tenkan: int, kijun: int, span_b: int, shift: int):
    """TradingView Ichimoku: spans are plotted `shift-1` bars ahead, so the cloud read at bar t comes from bar t-(shift-1)."""
    h, l = pd.Series(h, dtype=float), pd.Series(l, dtype=float)
    mid = lambda n: (h.rolling(n).max() + l.rolling(n).min()) / 2
    t, k = mid(tenkan), mid(kijun)
    d = shift - 1
    span_a = ((t + k) / 2).shift(d)
    span_bb = mid(span_b).shift(d)
    return t.to_numpy(), k.to_numpy(), span_a.to_numpy(), span_bb.to_numpy()
