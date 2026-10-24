"""Daily OHLCV chain (spec §3.3): cache -> Yahoo -> NSE bhavcopy -> Google (close only) -> stale cache.

Panel providers take request.symbols and return a dict symbol->DataFrame[ticker,date,open,high,low,close,volume]
for the symbols they can serve, with per-symbol detail in meta["per_symbol"]. The resolver gives every symbol
to the first provider that has it. Weekly bars are built locally from daily bars (engine.v5.data), never fetched.
Verified 2026-10-07: bhavcopy UDiFF zip (TradDt,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol).
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

import pandas as pd

from engine.resolution.calendar import TradingCalendar
from engine.resolution.config import load_config
from engine.resolution.resolver import DataResolver
from engine.resolution.types import DataRequest, DataType, ProviderError, ProviderResult, Reason

COLS = ["ticker", "date", "open", "high", "low", "close", "volume"]


def _d(x) -> date:
    return pd.Timestamp(x).date()


def required_bars(n: int, buffer_pct: float = 0.20) -> int:
    return int(n * (1 + buffer_pct)) + 1


class OhlcvCache:
    """Per-symbol parquet: <dir>/<SYMBOL>.parquet + <SYMBOL>.meta.json (source, as_of). Writes are atomic."""

    def __init__(self, root: str | Path):
        self.dir = Path(root)

    def _p(self, sym: str) -> Path:
        return self.dir / f"{sym}.parquet"

    def load(self, sym: str) -> pd.DataFrame | None:
        p = self._p(sym)
        if not p.exists():
            return None
        try:
            return pd.read_parquet(p)
        except Exception:
            return None

    def meta(self, sym: str) -> dict:
        m = self._p(sym).with_suffix(".meta.json")
        return json.loads(m.read_text()) if m.exists() else {}

    def save(self, sym: str, df: pd.DataFrame, source: str) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        old = self.load(sym)
        if old is not None:
            df = pd.concat([old, df], ignore_index=True)
        df = df.assign(date=pd.to_datetime(df["date"])).drop_duplicates(subset=["date"], keep="last").sort_values("date")
        p = self._p(sym)
        tmp = p.with_suffix(".parquet.tmp")
        df[COLS].to_parquet(tmp, index=False)
        tmp.replace(p)
        mt = p.with_suffix(".meta.json.tmp")
        mt.write_text(json.dumps({"source": source, "as_of": str(df["date"].max().date())}))
        mt.replace(p.with_suffix(".meta.json"))


def _slice(df: pd.DataFrame, as_of: date) -> pd.DataFrame:
    return df[pd.to_datetime(df["date"]) <= pd.Timestamp(as_of)].reset_index(drop=True)


class CacheProvider:
    """Serves only symbols whose cache is fresh (last bar = latest trading day <= as_of) and long enough."""
    name, data_type, primary = "cache", DataType.OHLCV, True

    def __init__(self, cache: OhlcvCache, calendar: TradingCalendar):
        self.cache, self.cal = cache, calendar

    def fetch(self, req: DataRequest) -> ProviderResult:
        need, expected = req.params.get("min_bars", 0), self.cal.last_trading_day(req.as_of)
        out, per = {}, {}
        for s in req.symbols or []:
            df = self.cache.load(s)
            if df is None:
                continue
            df = _slice(df, _d(req.as_of))
            if df.empty or _d(df["date"].max()) < expected or len(df) < need:
                continue
            out[s] = df
            m = self.cache.meta(s)
            per[s] = {"source": f"cache:{m.get('source', 'unknown')}", "as_of": _d(df["date"].max())}
        if not out:
            raise ProviderError("no fresh cache")
        return ProviderResult(out, _d(req.as_of), meta={"per_symbol": per})


class YahooProvider:
    """Wraps the existing adapter.daily_ohlcv (yfinance); incremental fetch/caching lives there + in OhlcvCache."""
    log_miss = True
    name, data_type, primary = "yahoo", DataType.OHLCV, True

    def __init__(self, adapter, history_days: int, cache: OhlcvCache | None = None):
        self.adapter, self.history_days, self.cache = adapter, history_days, cache

    def fetch(self, req: DataRequest) -> ProviderResult:
        got = self.adapter.daily_ohlcv(list(req.symbols or []), self.history_days)
        out = {s: _slice(df, _d(req.as_of)) for s, df in got.items()}
        out = {s: df for s, df in out.items() if not df.empty}
        if self.cache is not None:
            for s, df in out.items():
                self.cache.save(s, df, "yahoo")
        if not out:
            raise ProviderError("yahoo returned nothing")
        return ProviderResult(out, _d(req.as_of),
                              meta={"per_symbol": {s: {"as_of": _d(df["date"].max())} for s, df in out.items()}})


def parse_bhavcopy(raw: bytes) -> pd.DataFrame:
    """UDiFF CM bhavcopy zip -> EQ/BE-series rows as ticker,date,open,high,low,close,volume."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        df = pd.read_csv(z.open(z.namelist()[0]))
    df = df[df["SctySrs"].isin(["EQ", "BE", "BZ", "SM", "ST"])]
    return pd.DataFrame({"ticker": df["TckrSymb"].str.strip() + ".NS", "date": pd.to_datetime(df["TradDt"]),
                         "open": df["OpnPric"], "high": df["HghPric"], "low": df["LwPric"],
                         "close": df["ClsPric"], "volume": df["TtlTradgVol"]}).reset_index(drop=True)


class BhavcopyProvider:
    """Authoritative EOD, all symbols per day. One download serves every symbol (day files cached on disk)."""
    log_miss = True
    name, data_type, primary = "nse_bhavcopy", DataType.OHLCV, False

    def __init__(self, url_template: str, day_dir: str | Path, fetcher: Callable[[str, float], bytes],
                 calendar: TradingCalendar, timeout: float = 15, enabled: bool = True):
        self.url, self.dir, self.fetcher, self.cal, self.timeout, self.enabled = url_template, Path(day_dir), fetcher, calendar, timeout, enabled

    def day(self, d: date, only_cached: bool = False) -> pd.DataFrame | None:
        p = self.dir / f"{d}.parquet"
        if p.exists():
            return pd.read_parquet(p)
        if only_cached:
            return None
        try:
            df = parse_bhavcopy(self.fetcher(self.url.format(yyyymmdd=d.strftime("%Y%m%d")), self.timeout))
        except Exception:
            return None                                  # holiday (404) or network error
        self.dir.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp"); df.to_parquet(tmp, index=False); tmp.replace(p)
        return df

    def fetch(self, req: DataRequest) -> ProviderResult:
        if not self.enabled:
            raise ProviderError("nse provider disabled")
        end = self.cal.last_trading_day(req.as_of)
        days, d, want = [], end, int(req.params.get("fill_days", 5))
        while len(days) < want and (end - d).days < 14:
            if self.cal.is_trading_day(d):
                days.append(d)
            d -= timedelta(days=1)
        frames = [f for f in (self.day(x) for x in days) if f is not None]
        if not frames:
            raise ProviderError("no bhavcopy available")
        allb = pd.concat(frames, ignore_index=True)
        out = {s: g.reset_index(drop=True) for s, g in allb[allb["ticker"].isin(req.symbols or [])].groupby("ticker")}
        if not out:
            raise ProviderError("symbols not in bhavcopy")
        return ProviderResult(out, end, meta={"per_symbol": {s: {"as_of": _d(g["date"].max())} for s, g in out.items()}})


class GoogleProvider:
    """Close only (O/H/L missing -> conditions needing them become `?`/partial_fields). Fragile HTML scrape."""
    log_miss = True
    name, data_type, primary = "google_finance", DataType.OHLCV, False

    def __init__(self, url_template: str, fetcher: Callable[[str, float], bytes], timeout: float = 15):
        self.url, self.fetcher, self.timeout = url_template, fetcher, timeout

    def fetch(self, req: DataRequest) -> ProviderResult:
        out, per = {}, {}
        for s in req.symbols or []:
            try:
                html = self.fetcher(self.url.format(symbol=s.replace(".NS", "")), self.timeout).decode("utf-8", "ignore")
                m = re.search(r"₹\s*([\d,]+(?:\.\d+)?)", html)
                if not m:
                    continue
                px = float(m.group(1).replace(",", ""))
            except Exception:
                continue
            out[s] = pd.DataFrame([{"ticker": s, "date": pd.Timestamp(req.as_of), "open": None, "high": None,
                                    "low": None, "close": px, "volume": None}])
            per[s] = {"as_of": _d(req.as_of), "fields": ["close"], "reason": Reason.PARTIAL_FIELDS}
        if not out:
            raise ProviderError("google returned nothing")
        return ProviderResult(out, _d(req.as_of), meta={"per_symbol": per})


class StaleCacheProvider:
    name, data_type, primary = "last_cached_bar", DataType.OHLCV, False

    def __init__(self, cache: OhlcvCache):
        self.cache = cache

    def fetch(self, req: DataRequest) -> ProviderResult:
        out, per = {}, {}
        for s in req.symbols or []:
            df = self.cache.load(s)
            if df is not None:
                df = _slice(df, _d(req.as_of))
                if not df.empty:
                    out[s] = df
                    per[s] = {"source": f"cache:{self.cache.meta(s).get('source', 'unknown')}", "as_of": _d(df["date"].max()),
                              "quality": "stale", "reason": Reason.STALE_DATA}
        if not out:
            raise ProviderError("no cached bars")
        return ProviderResult(out, _d(req.as_of), "stale", Reason.STALE_DATA, meta={"per_symbol": per})


def build_ohlcv_resolver(adapter, history_days: int, config: dict | None = None, network: bool = True,
                         fetcher: Callable[[str, float], bytes] | None = None, calendar: TradingCalendar | None = None,
                         gap_log=None, sleep=None, success_log=None) -> tuple[DataResolver, OhlcvCache, TradingCalendar]:
    from engine.resolution.universe import http_fetcher
    cfg = config or load_config()
    ocfg, pcfg = cfg["ohlcv"], cfg["providers"]
    cal = calendar or TradingCalendar.from_file(ocfg.get("holidays_file") and Path(ocfg["holidays_file"]))
    cache = OhlcvCache(ocfg["cache_dir"])
    fetch = fetcher or http_fetcher(pcfg.get("niftyindices", {}).get("user_agent", "Mozilla/5.0"), pcfg.get("max_req_per_s", 2))
    chain: list = [CacheProvider(cache, cal)]
    if network and adapter is not None:
        chain.append(YahooProvider(adapter, history_days, cache))
    if network and pcfg.get("nse", {}).get("enabled", True):
        chain.append(BhavcopyProvider(cfg["urls"]["bhavcopy"], ocfg["bhavcopy_dir"], fetch, cal, pcfg.get("timeout_s", 15)))
        chain.append(GoogleProvider(cfg["urls"]["google_quote"], fetch, pcfg.get("timeout_s", 15)))
    chain.append(StaleCacheProvider(cache))
    kw = {"sleep": sleep} if sleep else {}
    r = DataResolver(cfg, gap_log=gap_log, success_log=success_log, **kw)
    r.register(DataType.OHLCV, chain)
    return r, cache, cal


class OhlcvService:
    """What the engine calls. Returns the same {ticker: DataFrame} panels it always used, plus per-symbol provenance."""

    def __init__(self, resolver: DataResolver, cache: OhlcvCache, calendar: TradingCalendar, config: dict | None = None,
                 gap_log: Callable[[dict], None] | None = None):
        self.resolver, self.cache, self.cal = resolver, cache, calendar
        self.cfg = (config or load_config())
        self.gap_log = gap_log

    def daily_panels(self, symbols: list[str], as_of, min_bars: int = 0) -> tuple[dict, dict]:
        ocfg = self.cfg["ohlcv"]
        need = required_bars(min_bars, self.cfg["history"]["buffer_pct"]) if min_bars else 0
        res = self.resolver.resolve_panel(DataRequest(DataType.OHLCV, _d(as_of), symbols=list(symbols),
                                                      params={"min_bars": need}))
        expected = self.cal.last_trading_day(_d(as_of))
        panels, prov = {}, {}
        for s, r in res.items():
            if r.missing:
                prov[s] = r
                continue
            behind = self.cal.trading_days_between(r.as_of, expected) if r.as_of else 0
            if r.quality in ("ok", "fallback") and behind > ocfg["stale_after_trading_days"]:
                r.quality, r.reason = "stale", Reason.STALE_DATA.value
                self._log("OHLCV", s, r.source, Reason.STALE_DATA.value, f"last bar {r.as_of}, expected {expected}")
            panels[s] = r.value
            prov[s] = r
        self._cross_validate(panels, prov, expected)
        return panels, prov

    def _cross_validate(self, panels: dict, prov: dict, day: date) -> None:
        """Yahoo vs bhavcopy on the latest day (disk-cached bhavcopy only; never forces a download)."""
        bp = next((p for p in self.resolver.chain(DataType.OHLCV) if isinstance(p, BhavcopyProvider)), None)
        bhav = bp.day(day, only_cached=True) if bp else None
        if bhav is None or bhav.empty:
            return
        tol = self.cfg["ohlcv"]["mismatch_tolerance"]
        ref = bhav.set_index("ticker")
        for s, df in panels.items():
            if s not in ref.index or not str(prov[s].source).startswith(("yahoo", "cache:yahoo")):
                continue
            last = df.iloc[-1]
            if _d(last["date"]) != day:
                continue
            b = ref.loc[s]
            if abs(last["close"] - b["close"]) / b["close"] > tol:
                fixed = df.copy()
                for c in ("open", "high", "low", "close", "volume"):
                    fixed.iloc[-1, fixed.columns.get_loc(c)] = b[c]
                panels[s] = fixed
                prov[s].value, prov[s].source, prov[s].quality = fixed, "nse_bhavcopy", "fallback"
                prov[s].reason = Reason.PRICE_MISMATCH.value
                self._log("OHLCV", s, "yahoo", Reason.PRICE_MISMATCH.value,
                          f"yahoo close {last['close']} vs bhavcopy {b['close']} on {day}")

    def _log(self, dt, sym, provider, reason, detail):
        if self.gap_log:
            self.gap_log({"data_type": dt, "symbol": sym, "provider": provider, "reason": reason, "detail": detail})
