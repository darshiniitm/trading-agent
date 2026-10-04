"""
Source adapter interface (design doc §3.3).

Everything downstream (indicators, screen, backtest) talks to this interface only.
Swapping opensource -> paid means writing a new adapter class and flipping
`data_source` in the rule spec — no other code changes.
"""
from __future__ import annotations

import io
import json
import time
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import requests

NSE_ARCHIVE_URLS = {
    "midcap150": "https://archives.nseindia.com/content/indices/ind_niftymidcap150list.csv",
    "smallcap250": "https://archives.nseindia.com/content/indices/ind_niftysmallcap250list.csv",
    "nifty500": "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
}

# Literal spec (step 1: "all stocks", not an index-constituent proxy) — NSE's public
# master equity list, no API key. Unlike the index CSVs above it has no sector column;
# sector_map_pit() falls back to the index-CSV union for names it covers and "Unknown"
# for the rest (see literal-spec-plan.md — a documented caveat, not a silent gap).
FULL_EQUITY_LIST_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}

KNOWN_CAVEATS = [
    "yfinance weekly bars / corporate-action adjustment not independently verified",
    "market cap uses TODAY's shares outstanding held constant across history "
    "(no point-in-time share count available from open-source sources) — "
    "see design doc section 3.2",
    "delisted / merged tickers are not included -> survivorship bias, "
    "backtest returns are likely biased upward",
    "sector map is NSE index-classification 'Industry' field as of the CSV "
    "snapshot date, not strictly point-in-time historically",
]

FULL_LIST_KNOWN_CAVEATS = KNOWN_CAVEATS + [
    "universe.source=full_nse_equity_list (Literal spec): the same shares-outstanding "
    "and survivorship caveats above now apply across ~4x more tickers than the "
    "index-constituent proxy — a larger surface for the same unresolved limitations, "
    "not a fix for them",
    "the full equity master list carries no sector field; sector_map_pit() reports "
    "'Unknown' for any ticker outside the midcap150/smallcap250/nifty500 union",
]


class SourceAdapter:
    """Interface every data source must implement."""

    def nse_equities_pit(self, as_of) -> pd.DataFrame:
        raise NotImplementedError

    def weekly_ohlcv(self, tickers: list[str], history_weeks: int) -> dict[str, pd.DataFrame]:
        raise NotImplementedError

    def daily_ohlcv(self, tickers: list[str], history_days: int) -> dict[str, pd.DataFrame]:
        raise NotImplementedError

    def sector_map_pit(self, as_of) -> pd.DataFrame:
        raise NotImplementedError

    def benchmark_series(self, ticker: str, history_weeks: int) -> pd.DataFrame:
        raise NotImplementedError

    def daily_benchmark_series(self, ticker: str, history_days: int) -> pd.DataFrame:
        raise NotImplementedError

    def caveats(self) -> list[str]:
        raise NotImplementedError


@dataclass
class OpenSourceAdapter(SourceAdapter):
    cache_dir: Path
    index_lists: list[str]
    universe_source: str = "index_lists"  # "index_lists" (Control) | "full_nse_equity_list" (Literal)

    def __post_init__(self):
        self.cache_dir = Path(self.cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    # ---- universe + sector map ------------------------------------------------
    def _fetch_index_csv(self, key: str) -> pd.DataFrame:
        cache_path = self.cache_dir / f"universe_{key}.csv"
        if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < 24 * 3600:
            return pd.read_csv(cache_path)
        url = NSE_ARCHIVE_URLS[key]
        r = requests.get(url, headers=UA, timeout=20)
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text))
        df.to_csv(cache_path, index=False)
        return df

    def _load_universe_raw(self) -> pd.DataFrame:
        frames = []
        for key in self.index_lists:
            df = self._fetch_index_csv(key)
            df = df.rename(
                columns={
                    "Company Name": "name",
                    "Industry": "sector",
                    "Symbol": "symbol",
                    "Series": "series",
                    "ISIN Code": "isin",
                }
            )
            frames.append(df[["symbol", "name", "sector", "isin"]])
        out = pd.concat(frames, ignore_index=True).drop_duplicates(subset="symbol")
        out["ticker"] = out["symbol"].astype(str).str.strip() + ".NS"
        return out.reset_index(drop=True)

    def _fetch_full_equity_list(self) -> pd.DataFrame:
        """NSE's public EQ-series master list (Literal spec, step 1). No sector column."""
        cache_path = self.cache_dir / "universe_full_equity_list.csv"
        if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < 24 * 3600:
            df = pd.read_csv(cache_path)
        else:
            r = requests.get(FULL_EQUITY_LIST_URL, headers=UA, timeout=30)
            r.raise_for_status()
            df = pd.read_csv(io.StringIO(r.text))
            df.to_csv(cache_path, index=False)
        df.columns = [c.strip() for c in df.columns]
        df = df[df["SERIES"].astype(str).str.strip() == "EQ"]
        df = df.rename(columns={
            "SYMBOL": "symbol",
            "NAME OF COMPANY": "name",
            "ISIN NUMBER": "isin",
        })
        return df[["symbol", "name", "isin"]].reset_index(drop=True)

    def _load_universe_full(self) -> pd.DataFrame:
        full = self._fetch_full_equity_list()
        full["symbol"] = full["symbol"].astype(str).str.strip()
        # Sector coverage: NSE's full equity list has no sector field. Backfill from the
        # index-constituent CSVs' 'Industry' field where available; the rest are "Unknown"
        # (a documented caveat — see FULL_LIST_KNOWN_CAVEATS — not a silent gap).
        sector_map = self._load_universe_raw()[["symbol", "sector"]].drop_duplicates(subset="symbol")
        out = full.merge(sector_map, on="symbol", how="left")
        out["sector"] = out["sector"].fillna("Unknown")
        out["ticker"] = out["symbol"] + ".NS"
        return out.drop_duplicates(subset="symbol").reset_index(drop=True)

    def nse_equities_pit(self, as_of) -> pd.DataFrame:
        # NOTE: both paths return the CURRENT list, not the constituent/listing list as
        # of `as_of` historically. This is a known open-source limitation (see caveats());
        # intraday-index-reconstitution / delisting drift is out of scope for the POC.
        if self.universe_source == "full_nse_equity_list":
            return self._load_universe_full()
        return self._load_universe_raw()

    def sector_map_pit(self, as_of) -> pd.DataFrame:
        if self.universe_source == "full_nse_equity_list":
            u = self._load_universe_full()
        else:
            u = self._load_universe_raw()
        return u[["ticker", "symbol", "sector"]]

    # ---- OHLCV ------------------------------------------------------------
    def weekly_ohlcv(self, tickers: list[str], history_weeks: int) -> dict[str, pd.DataFrame]:
        import yfinance as yf

        cache_path = self.cache_dir / f"weekly_ohlcv_{history_weeks}w.parquet"
        meta_path = self.cache_dir / f"weekly_ohlcv_{history_weeks}w.meta.json"
        cached_tickers = set()
        panel = None
        if cache_path.exists() and meta_path.exists():
            meta = json.loads(meta_path.read_text())
            if time.time() - meta.get("fetched_at", 0) < 12 * 3600:
                panel = pd.read_parquet(cache_path)
                cached_tickers = set(panel["ticker"].unique())

        missing = [t for t in tickers if t not in cached_tickers]
        if missing:
            period = f"{int(history_weeks * 7 / 30) + 2}mo"
            fetched = yf.download(
                tickers=missing,
                period=period,
                interval="1wk",
                auto_adjust=False,
                group_by="ticker",
                threads=True,
                progress=False,
            )
            frames = []
            for t in missing:
                try:
                    sub = fetched[t]  # yf.download with group_by='ticker' is always MultiIndex, even for 1 ticker
                    sub = sub.dropna(how="all")
                    if sub.empty:
                        continue
                    sub = sub.reset_index().rename(columns=str.lower)
                    sub["ticker"] = t
                    frames.append(sub[["ticker", "date", "open", "high", "low", "close", "volume"]])
                except Exception:
                    continue
            new_panel = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
            panel = pd.concat([panel, new_panel], ignore_index=True) if panel is not None else new_panel
            panel = panel.drop_duplicates(subset=["ticker", "date"]).sort_values(["ticker", "date"])
            panel.to_parquet(cache_path, index=False)
            meta_path.write_text(json.dumps({"fetched_at": time.time()}))

        out = {}
        for t in tickers:
            sub = panel[panel["ticker"] == t].sort_values("date").reset_index(drop=True)
            if not sub.empty:
                out[t] = sub
        return out

    # ---- daily OHLCV (T1 rolling-window shadow arm only; weekly path above is untouched) --
    def daily_ohlcv(self, tickers: list[str], history_days: int) -> dict[str, pd.DataFrame]:
        import yfinance as yf

        cache_path = self.cache_dir / f"daily_ohlcv_{history_days}d.parquet"
        meta_path = self.cache_dir / f"daily_ohlcv_{history_days}d.meta.json"
        cached_tickers = set()
        panel = None
        if cache_path.exists() and meta_path.exists():
            meta = json.loads(meta_path.read_text())
            if time.time() - meta.get("fetched_at", 0) < 12 * 3600:
                panel = pd.read_parquet(cache_path)
                cached_tickers = set(panel["ticker"].unique())

        missing = [t for t in tickers if t not in cached_tickers]
        if missing:
            period = f"{history_days}d"
            fetched = yf.download(
                tickers=missing,
                period=period,
                interval="1d",
                auto_adjust=False,
                group_by="ticker",
                threads=True,
                progress=False,
            )
            frames = []
            for t in missing:
                try:
                    sub = fetched[t]  # yf.download with group_by='ticker' is always MultiIndex, even for 1 ticker
                    sub = sub.dropna(how="all")
                    if sub.empty:
                        continue
                    sub = sub.reset_index().rename(columns=str.lower)
                    sub["ticker"] = t
                    frames.append(sub[["ticker", "date", "open", "high", "low", "close", "volume"]])
                except Exception:
                    continue
            new_panel = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
            panel = pd.concat([panel, new_panel], ignore_index=True) if panel is not None else new_panel
            panel = panel.drop_duplicates(subset=["ticker", "date"]).sort_values(["ticker", "date"])
            panel.to_parquet(cache_path, index=False)
            meta_path.write_text(json.dumps({"fetched_at": time.time()}))

        out = {}
        for t in tickers:
            sub = panel[panel["ticker"] == t].sort_values("date").reset_index(drop=True)
            if not sub.empty:
                out[t] = sub
        return out

    def daily_benchmark_series(self, ticker: str, history_days: int) -> pd.DataFrame:
        d = self.daily_ohlcv([ticker], history_days)
        return d.get(ticker, pd.DataFrame())

    def shares_outstanding(self, tickers: list[str]) -> dict[str, float]:
        import yfinance as yf

        cache_path = self.cache_dir / "shares_outstanding.json"
        cached = {}
        if cache_path.exists() and (time.time() - cache_path.stat().st_mtime) < 24 * 3600:
            cached = json.loads(cache_path.read_text())

        missing = [t for t in tickers if t not in cached]
        for t in missing:
            try:
                fi = yf.Ticker(t).fast_info
                shares = fi.get("shares")
                if shares:
                    cached[t] = float(shares)
            except Exception:
                continue
        cache_path.write_text(json.dumps(cached))
        return {t: cached[t] for t in tickers if t in cached}

    def benchmark_series(self, ticker: str, history_weeks: int) -> pd.DataFrame:
        d = self.weekly_ohlcv([ticker], history_weeks)
        return d.get(ticker, pd.DataFrame())

    def caveats(self) -> list[str]:
        if self.universe_source == "full_nse_equity_list":
            return FULL_LIST_KNOWN_CAVEATS
        return KNOWN_CAVEATS


def build_adapter(rule_spec: dict) -> SourceAdapter:
    source = rule_spec.get("data_source", "opensource")
    if source == "opensource":
        universe_cfg = rule_spec["universe"]
        universe_source = universe_cfg.get("source", "index_lists")
        return OpenSourceAdapter(
            cache_dir=rule_spec["data"]["cache_dir"],
            index_lists=universe_cfg.get("index_lists", []),
            universe_source=universe_source,
        )
    raise NotImplementedError(f"data_source={source!r} not implemented (POC is opensource-only)")
