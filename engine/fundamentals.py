"""Display-only fundamentals per symbol (P6): revenue/EPS TTM, dividends, market cap. yfinance, bounded concurrency."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pandas as pd

CONCURRENCY = 4


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def _ttm(stmt: pd.DataFrame | None, fy: pd.DataFrame | None, row: str):
    """Sum of the last 4 quarters; falls back to the latest fiscal year when quarters are unavailable."""
    for frame, take in ((stmt, 4), (fy, 1)):
        if frame is not None and not frame.empty and row in frame.index:
            vals = frame.loc[row, sorted(frame.columns, reverse=True)].dropna().iloc[:take]
            if len(vals) == take:
                return _num(vals.sum())
    return None


def _one(sym: str, factory) -> dict:
    t = factory(sym)
    info = t.info or {}
    try:
        qs, fy = t.quarterly_income_stmt, t.income_stmt
    except Exception:
        qs = fy = None
    div = None
    try:
        s = t.dividends
        if s is not None and len(s):
            idx = pd.to_datetime(s.index).tz_localize(None) if getattr(s.index, "tz", None) is not None else pd.to_datetime(s.index)
            cutoff = pd.Timestamp.now().normalize() - pd.Timedelta(days=365)
            div = _num(s[idx >= cutoff].sum())
    except Exception:
        div = None
    eps = _ttm(qs, fy, "Diluted EPS")
    if eps is None:
        eps = _num(info.get("trailingEps"))
    return {
        "currency": info.get("currency") or "INR",
        "market_cap": _num(info.get("marketCap")), "shares_out": _num(info.get("sharesOutstanding")),
        "revenue_ttm": _ttm(qs, fy, "Total Revenue") or _num(info.get("totalRevenue")),
        "eps_ttm": eps, "dividend_ttm": div,
    }


def fetch_fundamentals(symbols: list[str], factory=None) -> dict[str, dict]:
    if factory is None:
        import yfinance as yf
        factory = yf.Ticker

    def safe(sym):
        try:
            return sym, _one(sym, factory)
        except Exception as exc:
            return sym, {"error": str(exc)}

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        return dict(pool.map(safe, symbols))
