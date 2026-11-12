"""Watchlist-view metrics (P6, docs/watchlist-views-implementation-plan.md §3): one source of truth.

Pure functions over daily OHLCV frames (columns: date, open, high, low, close, volume; adjusted prices).
DISPLAY ONLY — nothing here feeds screening, selection or grading. Ratings are our implementation of the
TradingView rating method and can differ slightly from TradingView's.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from src.indicators.rsi import compute_rsi

MIN_BARS_RATING = 20
MA_LENGTHS = (10, 20, 30, 50, 100, 200)


def _f(x) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _clean(df: pd.DataFrame | None) -> pd.DataFrame:
    if df is None or len(df) == 0:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])
    out = df.copy()
    out["date"] = pd.to_datetime(out["date"])
    out = out.dropna(subset=["close"]).drop_duplicates("date", keep="last").sort_values("date").reset_index(drop=True)
    return out


# ---- price ----------------------------------------------------------------------------------------------------

def avg_vol(df: pd.DataFrame, n: int = 10) -> float | None:
    d = _clean(df)
    if len(d) < n or "volume" not in d:
        return None
    return _f(d["volume"].tail(n).mean())


def volatility(df: pd.DataFrame, sessions: int) -> float | None:
    """Mean of (High - Low) / Low * 100 over the last `sessions` sessions."""
    d = _clean(df)
    if len(d) < sessions:
        return None
    t = d.tail(sessions)
    low = t["low"].astype(float)
    if (low <= 0).any():
        return None
    return _f(((t["high"] - low) / low * 100).mean())


# ---- performance ----------------------------------------------------------------------------------------------

def _close_on_or_before(d: pd.DataFrame, target: pd.Timestamp) -> float | None:
    if d.empty or target < d["date"].iloc[0]:
        return None
    return _f(d.loc[d["date"] <= target, "close"].iloc[-1])


def perf(df: pd.DataFrame) -> dict:
    d = _clean(df)
    keys = ["perf_1w", "perf_1m", "perf_3m", "perf_ytd", "perf_1y", "perf_5y", "perf_all"]
    out: dict = {k: None for k in keys}
    out["first_close_date"] = None
    if d.empty:
        return out
    last_date, last = d["date"].iloc[-1], float(d["close"].iloc[-1])

    def pct(base):
        return None if base in (None, 0) else _f((last / base - 1) * 100)

    out["perf_1w"] = pct(_close_on_or_before(d, last_date - pd.Timedelta(days=7)))
    for key, months in (("perf_1m", 1), ("perf_3m", 3), ("perf_1y", 12), ("perf_5y", 60)):
        out[key] = pct(_close_on_or_before(d, last_date - pd.DateOffset(months=months)))
    prev_year = d.loc[d["date"] < pd.Timestamp(year=last_date.year, month=1, day=1)]
    out["perf_ytd"] = pct(_f(prev_year["close"].iloc[-1])) if not prev_year.empty else None
    out["perf_all"] = pct(float(d["close"].iloc[0])) if len(d) > 1 else None
    out["first_close_date"] = str(d["date"].iloc[0].date())
    return out


# ---- risk -----------------------------------------------------------------------------------------------------

def beta(sym: pd.DataFrame, bm: pd.DataFrame | None, years: int) -> float | None:
    """cov(r_sym, r_bm) / var(r_bm) over the last `years` calendar years, daily simple returns on shared dates."""
    s, b = _clean(sym), _clean(bm)
    if s.empty or b.empty:
        return None
    joined = pd.concat([s.set_index("date")["close"].rename("s"), b.set_index("date")["close"].rename("b")], axis=1, join="inner").sort_index()
    joined = joined[joined.index > joined.index[-1] - pd.DateOffset(years=years)] if len(joined) else joined
    rets = joined.pct_change().dropna()
    if len(rets) < 20:
        return None
    var = rets["b"].var()
    return None if not var else _f(rets["s"].cov(rets["b"]) / var)


# ---- indicators -----------------------------------------------------------------------------------------------

def _sma(x: pd.Series, n: int) -> pd.Series:
    return x.rolling(n).mean()


def _ema(x: pd.Series, n: int) -> pd.Series:
    out = x.ewm(span=n, adjust=False).mean()
    out.iloc[: n - 1] = np.nan
    return out


def _wma(x: pd.Series, n: int) -> pd.Series:
    w = np.arange(1, n + 1, dtype=float)
    return x.rolling(n).apply(lambda v: float(np.dot(v, w) / w.sum()), raw=True)


def _hma(x: pd.Series, n: int) -> pd.Series:
    return _wma(2 * _wma(x, n // 2) - _wma(x, n), int(round(math.sqrt(n))))


def _vwma(close: pd.Series, vol: pd.Series, n: int) -> pd.Series:
    return (close * vol).rolling(n).sum() / vol.rolling(n).sum()


def _cci(d: pd.DataFrame, n: int = 20) -> pd.Series:
    tp = (d["high"] + d["low"] + d["close"]) / 3
    mad = tp.rolling(n).apply(lambda v: float(np.abs(v - v.mean()).mean()), raw=True)
    return (tp - _sma(tp, n)) / (0.015 * mad)


def _ao(d: pd.DataFrame) -> pd.Series:
    hl2 = (d["high"] + d["low"]) / 2
    return _sma(hl2, 5) - _sma(hl2, 34)


def indicators(df: pd.DataFrame) -> dict:
    d = _clean(df)
    c = d["close"].astype(float)
    mom = c - c.shift(10)
    return {
        "rsi14": _f(compute_rsi(c, 14).iloc[-1]) if len(d) else None,
        "mom10": _f(mom.iloc[-1]) if len(d) else None,
        "ao": _f(_ao(d).iloc[-1]) if len(d) else None,
        "cci20": _f(_cci(d).iloc[-1]) if len(d) else None,
    }


def rating_label(r: float | None) -> str | None:
    if r is None:
        return None
    if r < -0.5:
        return "Strong sell"
    if r < -0.1:
        return "Sell"
    if r <= 0.1:
        return "Neutral"
    if r <= 0.5:
        return "Buy"
    return "Strong buy"


def _vote(close: float, ma) -> int:
    ma = _f(ma)
    if ma is None or abs(close - ma) <= 1e-9 * max(abs(close), 1.0):
        return 0
    return 1 if close > ma else -1


def ma_rating(df: pd.DataFrame) -> tuple[float | None, dict]:
    """SMA & EMA 10/20/30/50/100/200, Ichimoku base line (26), VWMA(20), HMA(9): +1 above, -1 below, 0 equal/short."""
    d = _clean(df)
    if len(d) < MIN_BARS_RATING:
        return None, {}
    c = d["close"].astype(float)
    last = float(c.iloc[-1])
    votes: dict[str, int] = {}
    for n in MA_LENGTHS:
        votes[f"SMA{n}"] = _vote(last, _sma(c, n).iloc[-1])
        votes[f"EMA{n}"] = _vote(last, _ema(c, n).iloc[-1])
    base = (d["high"].rolling(26).max() + d["low"].rolling(26).min()) / 2
    votes["ICHIMOKU"] = _vote(last, base.iloc[-1])
    votes["VWMA20"] = _vote(last, _vwma(c, d["volume"].astype(float), 20).iloc[-1])
    votes["HMA9"] = _vote(last, _hma(c, 9).iloc[-1])
    return _f(sum(votes.values()) / len(votes)), votes


def _stoch_k(high, low, close, n, smooth_k=3):
    ll, hh = low.rolling(n).min(), high.rolling(n).max()
    raw = 100 * (close - ll) / (hh - ll).replace(0, np.nan)
    return _sma(raw, smooth_k)


def _adx(d: pd.DataFrame, n: int = 14):
    h, l, c = d["high"], d["low"], d["close"]
    up, down = h.diff(), -l.diff()
    pdm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=d.index)
    ndm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=d.index)
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    a = 1 / n
    atr = tr.ewm(alpha=a, adjust=False).mean()
    pdi = 100 * pdm.ewm(alpha=a, adjust=False).mean() / atr
    ndi = 100 * ndm.ewm(alpha=a, adjust=False).mean() / atr
    dx = 100 * (pdi - ndi).abs() / (pdi + ndi).replace(0, np.nan)
    return dx.ewm(alpha=a, adjust=False).mean(), pdi, ndi


def _last2(s: pd.Series):
    v = s.dropna()
    return (float(v.iloc[-1]), float(v.iloc[-2])) if len(v) >= 2 else (None, None)


def os_rating(df: pd.DataFrame) -> tuple[float | None, dict]:
    """Eleven oscillator votes (+1 buy / -1 sell / 0 neutral or unavailable), TradingView's published rules."""
    d = _clean(df)
    if len(d) < MIN_BARS_RATING:
        return None, {}
    h, l, c = d["high"].astype(float), d["low"].astype(float), d["close"].astype(float)
    v: dict[str, int] = {}

    rsi = compute_rsi(c, 14)
    r, r1 = _last2(rsi)
    v["RSI"] = 0 if r is None else (1 if r < 30 and r > r1 else -1 if r > 70 and r < r1 else 0)

    k = _stoch_k(h, l, c, 14)
    dd = _sma(k, 3)
    (kk, k1), (dv, d1) = _last2(k), _last2(dd)
    v["STOCH"] = 0 if None in (kk, k1, dv, d1) else (1 if kk < 20 and dv < 20 and kk > dv and k1 < d1 else -1 if kk > 80 and dv > 80 and kk < dv and k1 > d1 else 0)

    cci = _cci(d)
    x, x1 = _last2(cci)
    v["CCI"] = 0 if x is None else (1 if x < -100 and x > x1 else -1 if x > 100 and x < x1 else 0)

    adx, pdi, ndi = _adx(d)
    a = _f(adx.iloc[-1])
    (p, p1), (n_, n1) = _last2(pdi), _last2(ndi)
    v["ADX"] = 0 if None in (a, p, p1, n_, n1) else (1 if a > 20 and p1 < n1 and p > n_ else -1 if a > 20 and p1 > n1 and p < n_ else 0)

    ao, ao1 = _last2(_ao(d))
    v["AO"] = 0 if ao is None else (1 if (ao > 0 and ao1 < 0) or (ao > 0 and ao1 > 0 and ao > ao1) else -1 if (ao < 0 and ao1 > 0) or (ao < 0 and ao1 < 0 and ao < ao1) else 0)

    mo, mo1 = _last2(c - c.shift(10))
    v["MOM"] = 0 if mo is None else (1 if mo > mo1 else -1 if mo < mo1 else 0)

    macd = _ema(c, 12) - _ema(c, 26)
    sig = macd.ewm(span=9, adjust=False).mean()
    mv, sv = _f(macd.iloc[-1]), _f(sig.iloc[-1])
    v["MACD"] = 0 if mv is None or sv is None else (1 if mv > sv else -1 if mv < sv else 0)

    lo_r, hi_r = rsi.rolling(14).min(), rsi.rolling(14).max()
    srsi = 100 * (rsi - lo_r) / (hi_r - lo_r).replace(0, np.nan)
    sk = _sma(srsi, 3)
    sd = _sma(sk, 3)
    (a1, a0), (b1, b0) = _last2(sk), _last2(sd)
    v["STOCHRSI"] = 0 if None in (a1, a0, b1, b0) else (1 if a1 < 20 and b1 < 20 and a1 > b1 and a0 < b0 else -1 if a1 > 80 and b1 > 80 and a1 < b1 and a0 > b0 else 0)

    wr = -100 * (h.rolling(14).max() - c) / (h.rolling(14).max() - l.rolling(14).min()).replace(0, np.nan)
    w, w1 = _last2(wr)
    v["WR"] = 0 if w is None else (1 if w < -80 and w > w1 else -1 if w > -20 and w < w1 else 0)

    e13 = _ema(c, 13)
    bbp = (h - e13) + (l - e13)
    bb, bb1 = _last2(bbp)
    v["BBP"] = 0 if bb is None else (1 if bb > 0 and bb > bb1 else -1 if bb < 0 and bb < bb1 else 0)

    pc = c.shift()
    bp = c - pd.concat([l, pc], axis=1).min(axis=1)
    tr = pd.concat([h, pc], axis=1).max(axis=1) - pd.concat([l, pc], axis=1).min(axis=1)
    avg = lambda n: bp.rolling(n).sum() / tr.rolling(n).sum().replace(0, np.nan)  # noqa: E731
    uo = _f((100 * (4 * avg(7) + 2 * avg(14) + avg(28)) / 7).iloc[-1])
    v["UO"] = 0 if uo is None else (1 if uo > 70 else -1 if uo < 30 else 0)

    return _f(sum(v.values()) / len(v)), v


# ---- assembly -------------------------------------------------------------------------------------------------

def _weekly_completed(d: pd.DataFrame, today: pd.Timestamp | None) -> pd.DataFrame:
    g = d.assign(_wk=d["date"].dt.to_period("W-FRI"))
    agg = g.groupby("_wk").agg(date=("date", "last"), open=("open", "first"), high=("high", "max"),
                               low=("low", "min"), close=("close", "last"), volume=("volume", "sum")).reset_index(drop=True)
    if len(agg):
        last = agg["date"].iloc[-1]
        friday = last + pd.Timedelta(days=(4 - last.weekday()) % 7)
        complete = last.weekday() == 4 or (today is not None and today.normalize() > friday)
        if not complete:
            agg = agg.iloc[:-1]
    return agg


def compute_symbol_metrics(df: pd.DataFrame, bm: pd.DataFrame | None, tf: str = "1D", today: pd.Timestamp | None = None) -> dict:
    """Every symbol_metrics column for one symbol. Technicals use the `tf` bars (completed bars only); the rest
    are computed on daily bars cut at the same as-of date."""
    d = _clean(df)
    tech = d if tf == "1D" else _weekly_completed(d, today)
    out: dict = {"timeframe": tf, "as_of": str(tech["date"].iloc[-1].date()) if len(tech) else None}
    if len(tech) == 0:
        return out
    cut = tech["date"].iloc[-1]
    d = d[d["date"] <= cut]
    bm_cut = _clean(bm)
    bm_cut = bm_cut[bm_cut["date"] <= cut] if len(bm_cut) else bm_cut

    out["avg_vol_10"] = avg_vol(d, 10)
    out.update(perf(d))
    out["beta_1y"], out["beta_3y"], out["beta_5y"] = (beta(d, bm_cut, y) for y in (1, 3, 5))
    out["vol_1d"], out["vol_1w"], out["vol_1m"] = (volatility(d, n) for n in (1, 5, 21))
    out.update(indicators(tech))
    ma, ma_votes = ma_rating(tech)
    os_, os_votes = os_rating(tech)
    out["ma_rating"], out["os_rating"] = ma, os_
    out["tech_rating"] = _f((ma + os_) / 2) if ma is not None and os_ is not None else None
    out["votes"] = {"ma": ma_votes, "os": os_votes}
    return out
