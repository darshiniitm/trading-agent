"""Batch assembly for GET /metrics (P6). Display only — never imported by screening, selection or grading."""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

from engine.metrics import compute_symbol_metrics

CONCURRENCY = 4
NSE_INDICES = {"^NSEI", "^NSEBANK", "^BSESN", "^CNXIT"}
CACHE_DIR = Path("data_cache/views_daily")
CACHE_TTL_S = 6 * 3600


def benchmark_for(symbol: str) -> str:
    """W5: NIFTY 50 for NSE/BSE symbols and Indian indices, S&P 500 for everything else."""
    s = symbol.upper()
    if s.endswith((".NS", ".BO")) or s in NSE_INDICES or s.startswith(("^CNX", "^NSE")):
        return "^NSEI"
    return "^GSPC"


def default_history(symbol: str) -> pd.DataFrame:
    """Max-depth daily bars, split/dividend adjusted, cached on disk for a few hours."""
    path = CACHE_DIR / f"{symbol.replace('^', '_').replace('/', '_')}.parquet"
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_TTL_S:
        return pd.read_parquet(path)
    import yfinance as yf
    raw = yf.Ticker(symbol).history(period="max", interval="1d", auto_adjust=True)
    if raw is None or raw.empty:
        return pd.DataFrame()
    df = raw.reset_index().rename(columns=str.lower)
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df = df[["date", "open", "high", "low", "close", "volume"]]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path)
    return df


def compute_batch(symbols: list[str], tf: str, history_fn, today: pd.Timestamp | None = None) -> dict[str, dict]:
    needed = list(dict.fromkeys([*symbols, *(benchmark_for(s) for s in symbols)]))
    loaded: dict[str, pd.DataFrame | Exception] = {}

    def load(sym):
        try:
            return sym, history_fn(sym)
        except Exception as exc:
            return sym, exc

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        loaded.update(pool.map(load, needed))

    out: dict[str, dict] = {}
    for sym in symbols:
        df = loaded[sym]
        if isinstance(df, Exception):
            out[sym] = {"error": str(df)}
            continue
        if df is None or len(df) == 0:
            out[sym] = {"error": "no price history"}
            continue
        bm_name = benchmark_for(sym)
        bm = loaded.get(bm_name)
        bm = None if isinstance(bm, Exception) else bm
        row = compute_symbol_metrics(df, bm, tf, today)
        row["beta_benchmark"] = bm_name
        out[sym] = row
    return out
