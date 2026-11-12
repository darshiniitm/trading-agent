"""Independent reference implementations (do NOT import from the app).

- rma / ATR / RSI follow TradingView (Wilder smoothing, SMA seed).
- vstop follows TradingView Pine v6 built-in "Volatility Stop":
    atrM = nz(ta.atr(len) * mult, ta.tr)
    max/min track src; stop ratchets; flip resets max/min and stop.
"""
import numpy as np, pandas as pd

def rma(x, n):
    x = np.asarray(x, float); out = np.full(len(x), np.nan)
    if len(x) < n: return out
    out[n - 1] = x[:n].mean()
    for i in range(n, len(x)):
        out[i] = (out[i - 1] * (n - 1) + x[i]) / n
    return out

def true_range(h, l, c):
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.nanmax(np.vstack([h - l, np.abs(h - pc), np.abs(l - pc)]), axis=0)
    tr[0] = h[0] - l[0]
    return tr

def rsi(close, n=14):
    c = np.asarray(close, float); d = np.diff(c, prepend=np.nan)
    up = np.where(d > 0, d, 0.0); dn = np.where(d < 0, -d, 0.0)
    up[0] = dn[0] = 0.0
    au = rma(up[1:], n); ad = rma(dn[1:], n)
    rs = au / ad
    out = 100 - 100 / (1 + rs)
    out = np.where(ad == 0, 100.0, out)
    return np.concatenate([[np.nan], out])

def vstop(h, l, c, n=10, mult=2.0):
    h, l, c = (np.asarray(a, float) for a in (h, l, c))
    tr = true_range(h, l, c); atr = rma(tr, n)
    stop = np.full(len(c), np.nan); up = np.zeros(len(c), bool)
    mx = mn = c[0]; st = np.nan; uptrend = True; prev_up = True
    for i in range(len(c)):
        src = c[i]
        atrM = atr[i] * mult if not np.isnan(atr[i]) else tr[i]
        mx = max(mx, src); mn = min(mn, src)
        cand = max(st, mx - atrM) if uptrend else min(st, mn + atrM)
        if np.isnan(st) or np.isnan(cand):  # math.max(na, x) is na in Pine -> nz(..., src)
            cand = src
        st = cand
        uptrend = (src - st) >= 0.0
        if uptrend != prev_up:
            mx = mn = src
            st = (mx - atrM) if uptrend else (mn + atrM)
        stop[i] = st; up[i] = uptrend; prev_up = uptrend
    return stop, up

def sma(x, n):
    return pd.Series(x, dtype=float).rolling(n).mean().to_numpy()

def weekly(df):
    """df: one ticker's daily rows indexed by date. Friday-labelled weekly bars."""
    w = df.resample("W-FRI").agg({"open": "first", "high": "max", "low": "min",
                                  "close": "last", "volume": "sum"}).dropna()
    return w


# ---- additional TradingView-matching references ----
def ema(x, n):
    """Pine ta.ema: SMA seed, then alpha = 2/(n+1)."""
    x = np.asarray(x, float); out = np.full(len(x), np.nan)
    if len(x) < n: return out
    a = 2.0 / (n + 1); out[n - 1] = x[:n].mean()
    for i in range(n, len(x)):
        out[i] = a * x[i] + (1 - a) * out[i - 1]
    return out

def ema_skipna(x, n):
    """EMA of a series that starts with NaNs (e.g. MACD line)."""
    x = np.asarray(x, float); out = np.full(len(x), np.nan)
    ok = np.where(~np.isnan(x))[0]
    if len(ok) == 0: return out
    s = ok[0]; out[s:] = ema(x[s:], n); return out

def atr(h, l, c, n=14):
    return rma(true_range(np.asarray(h, float), np.asarray(l, float), np.asarray(c, float)), n)

def supertrend(h, l, c, factor=3.0, n=10):
    """Pine ta.supertrend(factor, atrPeriod). Returns (line, direction) with direction -1 = up(bullish), +1 = down."""
    h, l, c = (np.asarray(a, float) for a in (h, l, c))
    a = atr(h, l, c, n); src = (h + l) / 2
    ub = src + factor * a; lb = src - factor * a
    st = np.full(len(c), np.nan); d = np.full(len(c), np.nan)
    pub = plb = np.nan; pst = np.nan
    for i in range(len(c)):
        if np.isnan(a[i]): continue
        u, lo = ub[i], lb[i]
        if not np.isnan(plb):
            lo = lo if (lo > plb or c[i - 1] < plb) else plb
            u = u if (u < pub or c[i - 1] > pub) else pub
        if np.isnan(a[i - 1]) if i > 0 else True:
            di = 1
        elif pst == pub:
            di = -1 if c[i] > u else 1
        else:
            di = 1 if c[i] < lo else -1
        st[i] = lo if di == -1 else u; d[i] = di
        pub, plb, pst = u, lo, st[i]
    return st, d

def adx(h, l, c, n=14):
    """Pine ta.dmi(n, n) ADX."""
    h, l, c = (np.asarray(a, float) for a in (h, l, c))
    up = np.diff(h, prepend=np.nan); dn = -np.diff(l, prepend=np.nan)
    pdm = np.where((up > dn) & (up > 0), up, 0.0); mdm = np.where((dn > up) & (dn > 0), dn, 0.0)
    pdm[0] = mdm[0] = 0.0
    tr = rma(true_range(h, l, c), n)
    pdi = 100 * rma(pdm, n) / tr; mdi = 100 * rma(mdm, n) / tr
    s = pdi + mdi
    dx = np.where(s == 0, 0.0, np.abs(pdi - mdi) / np.where(s == 0, 1, s))
    out = np.full(len(c), np.nan); ok = np.where(~np.isnan(dx))[0]
    if len(ok): out[ok[0]:] = 100 * rma(dx[ok[0]:], n)
    return out, pdi, mdi

def stdev_pop(x, n):
    return pd.Series(x, dtype=float).rolling(n).std(ddof=0).to_numpy()
