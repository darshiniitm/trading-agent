"""
Offline/hermetic test fixtures.

No test may touch the network. Everything below is served from data_cache/,
so the suite is deterministic and reproducible forever.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import load_rule_spec  # noqa: E402
from src.data.adapter import SourceAdapter  # noqa: E402

CACHE = ROOT / "data_cache"


class OfflineAdapter(SourceAdapter):
    """Same interface as OpenSourceAdapter, served entirely from the local cache."""

    def __init__(self, index_lists=("midcap150", "smallcap250", "nifty500")):
        self.index_lists = list(index_lists)
        self._panel = pd.read_parquet(CACHE / "weekly_ohlcv_260w.parquet")
        self._shares = json.loads((CACHE / "shares_outstanding.json").read_text())
        self._daily_panel = None  # lazy: no daily cache exists until the T1 backfill runs

    def _load_universe_raw(self) -> pd.DataFrame:
        frames = []
        for key in self.index_lists:
            df = pd.read_csv(CACHE / f"universe_{key}.csv")
            df = df.rename(columns={
                "Company Name": "name", "Industry": "sector",
                "Symbol": "symbol", "Series": "series", "ISIN Code": "isin",
            })
            frames.append(df[["symbol", "name", "sector", "isin"]])
        out = pd.concat(frames, ignore_index=True).drop_duplicates(subset="symbol")
        out["ticker"] = out["symbol"].astype(str).str.strip() + ".NS"
        return out.reset_index(drop=True)

    def nse_equities_pit(self, as_of) -> pd.DataFrame:
        return self._load_universe_raw()

    def sector_map_pit(self, as_of) -> pd.DataFrame:
        u = self._load_universe_raw()
        return u[["ticker", "symbol", "sector"]]

    def weekly_ohlcv(self, tickers, history_weeks) -> dict[str, pd.DataFrame]:
        out = {}
        for t in tickers:
            sub = self._panel[self._panel["ticker"] == t].sort_values("date").reset_index(drop=True)
            if not sub.empty:
                out[t] = sub
        return out

    def shares_outstanding(self, tickers) -> dict[str, float]:
        return {t: self._shares[t] for t in tickers if t in self._shares}

    def benchmark_series(self, ticker, history_weeks) -> pd.DataFrame:
        return self.weekly_ohlcv([ticker], history_weeks).get(ticker, pd.DataFrame())

    def _load_daily_panel(self) -> pd.DataFrame | None:
        if self._daily_panel is not None:
            return self._daily_panel
        candidates = sorted(CACHE.glob("daily_ohlcv_*d.parquet"))
        if not candidates:
            return None
        self._daily_panel = pd.read_parquet(candidates[-1])
        return self._daily_panel

    def daily_ohlcv(self, tickers, history_days) -> dict[str, pd.DataFrame]:
        panel = self._load_daily_panel()
        if panel is None:
            return {}
        out = {}
        for t in tickers:
            sub = panel[panel["ticker"] == t].sort_values("date").reset_index(drop=True)
            if not sub.empty:
                out[t] = sub
        return out

    def daily_benchmark_series(self, ticker, history_days) -> pd.DataFrame:
        return self.daily_ohlcv([ticker], history_days).get(ticker, pd.DataFrame())

    def caveats(self):
        return []


_CACHED_ENV = {}


def env(ticker_limit: int | None = None):
    """Bootstrap the full pipeline offline. Cached across tests for speed."""
    key = ticker_limit or "all"
    if key in _CACHED_ENV:
        return _CACHED_ENV[key]
    rule_spec = load_rule_spec(str(ROOT / "config" / "rules.yaml"))
    adapter = OfflineAdapter(rule_spec["universe"]["index_lists"])
    universe_df = adapter.nse_equities_pit(as_of=None)
    if ticker_limit:
        universe_df = universe_df.head(ticker_limit)
    tickers = universe_df["ticker"].tolist()
    panels = adapter.weekly_ohlcv(tickers, rule_spec["data"]["history_weeks"])
    shares = adapter.shares_outstanding(list(panels.keys()))
    _CACHED_ENV[key] = (rule_spec, adapter, universe_df, panels, shares)
    return _CACHED_ENV[key]


def env_with_daily(ticker_limit: int | None = None):
    """Same as env(), plus daily panels attached (empty dict per ticker if the
    real daily-bar backfill hasn't been run yet — callers must handle that)."""
    rule_spec, adapter, universe_df, panels, shares = env(ticker_limit)
    tickers = universe_df["ticker"].tolist()
    daily_panels = adapter.daily_ohlcv(tickers, rule_spec["data"]["history_weeks"] * 7)
    return rule_spec, adapter, universe_df, panels, shares, daily_panels


def all_dates(panels) -> list[pd.Timestamp]:
    return sorted({pd.Timestamp(d) for p in panels.values() for d in p["date"]})


def make_panel(closes, highs=None, lows=None, opens=None, start="2021-01-04"):
    """Synthetic weekly panel with controllable OHLC."""
    closes = np.asarray(closes, dtype=float)
    n = len(closes)
    return pd.DataFrame({
        "date": pd.date_range(start, periods=n, freq="W-MON"),
        "open": closes if opens is None else np.asarray(opens, float),
        "high": closes * 1.01 if highs is None else np.asarray(highs, float),
        "low": closes * 0.99 if lows is None else np.asarray(lows, float),
        "close": closes,
        "volume": np.full(n, 1_000_000.0),
    })


def make_daily_panel(closes, highs=None, lows=None, opens=None, start="2021-01-04"):
    """Synthetic daily (business-day) panel with controllable OHLC — same shape
    as make_panel(), used to unit-test the T1 rolling-window scan without the
    real daily-bar backfill."""
    closes = np.asarray(closes, dtype=float)
    n = len(closes)
    return pd.DataFrame({
        "date": pd.date_range(start, periods=n, freq="B"),
        "open": closes if opens is None else np.asarray(opens, float),
        "high": closes * 1.01 if highs is None else np.asarray(highs, float),
        "low": closes * 0.99 if lows is None else np.asarray(lows, float),
        "close": closes,
        "volume": np.full(n, 1_000_000.0),
    })
