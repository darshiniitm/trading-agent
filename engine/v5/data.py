"""Bars for a (ticker, timeframe) at an as_of date.

as_of convention (documented because it is easy to get wrong):
  * 1D  — daily bars with date <= as_of.
  * 1W  — weekly bars labelled by their Monday. Panels supplied by the caller (the Literal
          arm's own weekly panels, holiday-corrected) are trusted as-is: bar.date <= as_of.
          Otherwise bars are resampled from daily and a week is used only if its Friday has
          been reached by the data AND it is not the in-progress week at as_of (a Mon/Fri/Sat/
          Sun as_of means "that week is the signal week"; Tue-Thu means it is still open).
  * 1M  — month-start labelled; used only once the month has ended by as_of.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

CR = 1e7
_AGG = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}


def resample_weekly(daily: pd.DataFrame) -> pd.DataFrame:
    d = daily.copy()
    d["date"] = pd.to_datetime(d["date"])
    d = d.sort_values("date")
    d["_wk"] = d["date"].dt.normalize() - pd.to_timedelta(d["date"].dt.weekday, unit="D")
    w = d.groupby("_wk").agg(_AGG).dropna(subset=["close"]).reset_index().rename(columns={"_wk": "date"})
    return w


def resample_monthly(daily: pd.DataFrame) -> pd.DataFrame:
    d = daily.copy()
    d["date"] = pd.to_datetime(d["date"])
    m = d.sort_values("date").set_index("date").resample("MS").agg(_AGG).dropna(subset=["close"])
    return m.reset_index()


@dataclass
class DataContext:
    universe_df: pd.DataFrame
    shares: dict = field(default_factory=dict)
    daily_panels: dict | None = None
    weekly_panels: dict | None = None
    benchmark: pd.DataFrame | None = None         # date, close (weekly); always sliced to as_of before use
    rule_spec: dict | None = None                  # carries sector.* config for literal_sector_rs
    index_snapshot_dir: str | None = None
    universe_resolver: object | None = None       # engine.resolution DataResolver; None = snapshots+approx, no network
    upload: dict | None = None                     # {user_id, prompt_id} for tier-0 user uploads
    provenance: dict | None = None                 # ticker -> ResolvedData for daily OHLCV
    unfeedable: set = field(default_factory=set)   # condition ids with no data source at all (spec §6.3)
    sector_available: bool = True
    gap_log: object | None = None                  # GapLog (None offline/tests)
    universe_quality: str = "ok"
    universe_reason: str | None = None
    _cache: dict = field(default_factory=dict)

    def _full(self, ticker: str, tf: str) -> pd.DataFrame | None:
        key = (ticker, tf)
        if key in self._cache:
            return self._cache[key]
        out = None
        if tf == "1W" and self.weekly_panels and ticker in self.weekly_panels:
            out = self.weekly_panels[ticker]
        else:
            daily = (self.daily_panels or {}).get(ticker)
            if daily is not None and not daily.empty:
                if tf == "1D":
                    out = daily.copy().assign(date=lambda x: pd.to_datetime(x["date"])).sort_values("date")
                elif tf == "1W":
                    out = resample_weekly(daily)
                elif tf == "1M":
                    out = resample_monthly(daily)
        if out is not None:
            out = out.assign(date=pd.to_datetime(out["date"])).sort_values("date").reset_index(drop=True)
        self._cache[key] = out
        return out

    def prime(self, tfs: tuple[str, ...] = ("1D", "1W"), progress=None) -> int:
        """Build every ticker's bars for these timeframes now, so the first screen doesn't pay for it (~30s over ~2,300 stocks).
        The engine calls this while warming; results are identical to building lazily. Returns the number of series built."""
        tickers = sorted(set(self.daily_panels or {}) | set(self.weekly_panels or {}))
        built = 0
        for i, t in enumerate(tickers):
            if progress and i % 100 == 0:
                progress(i, len(tickers))
            for tf in tfs:
                if (t, tf) not in self._cache:
                    self._full(t, tf)
                    built += 1
        if progress:
            progress(len(tickers), len(tickers))
        return built

    def bars(self, ticker: str, tf: str, as_of: pd.Timestamp) -> pd.DataFrame | None:
        full = self._full(ticker, tf)
        if full is None or full.empty:
            return None
        as_of = pd.Timestamp(as_of).normalize()
        if tf == "1D":
            out = full[full["date"] <= as_of]
        elif tf == "1W":
            trusted = bool(self.weekly_panels) and ticker in self.weekly_panels
            monday = as_of - pd.Timedelta(days=as_of.weekday())
            out = full[full["date"] <= (as_of if trusted else monday)]
            if not trusted and as_of.weekday() in (1, 2, 3):
                out = out[out["date"] < monday]
            if not trusted:
                daily = (self.daily_panels or {}).get(ticker)
                last = pd.to_datetime(daily["date"]).max() if daily is not None and not daily.empty else None
                out = out[[(last is not None and last >= d + pd.Timedelta(days=4)) for d in out["date"]]]
        else:  # 1M
            month_end = full["date"] + pd.offsets.MonthEnd(0)
            out = full[month_end <= as_of]
        return out.reset_index(drop=True) if len(out) else None

    def has_data(self) -> bool:
        return bool(self.daily_panels) or bool(self.weekly_panels)
