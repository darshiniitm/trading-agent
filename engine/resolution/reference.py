"""Reference-data chains (spec §3.4-§3.6): market cap / shares, sector, corporate actions.

Each is a chain run through DataResolver.resolve_panel (per symbol: first provider that has it wins).
Fetchers are injected so tests stay hermetic; defaults use yfinance lazily.
"""
from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

import pandas as pd
import yaml

from engine.resolution.config import ROOT, load_config
from engine.resolution.resolver import DataResolver
from engine.resolution.types import DataRequest, DataType, ProviderError, ProviderResult, Reason

UNCLASSIFIED = "Unclassified"


def _d(x) -> date:
    return pd.Timestamp(x).date()


# ------------------------------------------------------------------------------------------------ market cap / shares
class SharesCacheProvider:
    """tier 1: local cache (shares_outstanding.json), fresh within `fresh_days`."""
    name, data_type, primary = "cache", DataType.MCAP, True

    def __init__(self, path: str | Path, fresh_days: int):
        self.path, self.fresh = Path(path), fresh_days

    def fetch(self, req: DataRequest) -> ProviderResult:
        if not self.path.exists() or time.time() - self.path.stat().st_mtime > self.fresh * 86400:
            raise ProviderError("no fresh shares cache")
        data = json.loads(self.path.read_text())
        out = {s: {"shares": float(data[s])} for s in req.symbols or [] if s in data}
        if not out:
            raise ProviderError("symbols not cached")
        return ProviderResult(out, _d(req.as_of), source="cache:yahoo")


class YahooInfoProvider:
    """tier 3/4: Yahoo info — sharesOutstanding, else marketCap/close ("computed", fallback)."""
    log_miss = True
    name, data_type, primary = "yahoo_info", DataType.MCAP, False

    def __init__(self, info_fetch: Callable[[str], dict], cache_path: str | Path | None = None):
        self.fetch_info, self.cache_path = info_fetch, cache_path

    def fetch(self, req: DataRequest) -> ProviderResult:
        out, close = {}, req.params.get("close") or {}
        for s in req.symbols or []:
            try:
                info = self.fetch_info(s) or {}
            except Exception:
                continue
            if info.get("sharesOutstanding"):
                out[s] = {"shares": float(info["sharesOutstanding"])}
            elif info.get("marketCap") and close.get(s):
                out[s] = {"shares": float(info["marketCap"]) / float(close[s])}
        if not out:
            raise ProviderError("yahoo info returned nothing")
        if self.cache_path:                                  # remember, so the next run has a "previous value"
            p = Path(self.cache_path)
            old = json.loads(p.read_text()) if p.exists() else {}
            old.update({s: v["shares"] for s, v in out.items()})
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(".tmp"); tmp.write_text(json.dumps(old)); tmp.replace(p)
        return ProviderResult(out, _d(req.as_of))


class PreviousSharesProvider:
    name, data_type, primary = "previous_value", DataType.MCAP, False

    def __init__(self, path: str | Path, fresh_days: int):
        self.path, self.fresh = Path(path), fresh_days

    def fetch(self, req: DataRequest) -> ProviderResult:
        if not self.path.exists():
            raise ProviderError("no previous value")
        data = json.loads(self.path.read_text())
        out = {s: {"shares": float(data[s])} for s in req.symbols or [] if s in data}
        if not out:
            raise ProviderError("no previous value for symbols")
        age = (time.time() - self.path.stat().st_mtime) / 86400
        stale = age > self.fresh
        return ProviderResult(out, _d(req.as_of), "stale" if stale else "ok",
                              Reason.STALE_DATA if stale else None, source="cache:previous")


def build_mcap_resolver(config=None, info_fetch=None, gap_log=None, sleep=time.sleep) -> DataResolver:
    cfg = config or load_config()
    m = cfg["mcap"]
    if info_fetch is None:
        def info_fetch(sym):
            import yfinance as yf
            return yf.Ticker(sym).info
    r = DataResolver(cfg, gap_log=gap_log, sleep=sleep)
    r.register(DataType.MCAP, [SharesCacheProvider(m["shares_cache"], m["fresh_days"]),
                               YahooInfoProvider(info_fetch, m["shares_cache"]),
                               PreviousSharesProvider(m["shares_cache"], m["fresh_days"])])
    return r


def resolve_shares(resolver: DataResolver, symbols: list[str], as_of, close: dict | None = None):
    """-> (shares {sym: float}, provenance {sym: ResolvedData})"""
    res = resolver.resolve_panel(DataRequest(DataType.MCAP, _d(as_of), symbols=list(symbols), params={"close": close or {}}))
    return {s: r.value["shares"] for s, r in res.items() if not r.missing}, res


# ------------------------------------------------------------------------------------------------ sector
def load_sector_mapping(path: str | Path | None = None) -> dict:
    p = Path(path) if path else ROOT / "config" / "sector_mapping.yaml"
    return (yaml.safe_load(p.read_text()) or {}).get("yahoo_to_nse", {}) if p.exists() else {}


class SectorCacheProvider:
    name, data_type, primary = "cache", DataType.SECTOR, True

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def fetch(self, req: DataRequest) -> ProviderResult:
        if not self.path.exists():
            raise ProviderError("no sector map")
        m = pd.read_parquet(self.path).set_index("ticker")["sector"]
        out = {s: m[s] for s in req.symbols or [] if s in m.index and m[s] not in (None, "", "Unknown", UNCLASSIFIED)}
        if not out:
            raise ProviderError("symbols not in sector map")
        return ProviderResult(out, _d(req.as_of), source="cache:nse")


class NseIndustryProvider:
    """NSE taxonomy: the Industry column of index constituent snapshots + sectors already on the universe frame."""
    name, data_type, primary = "nse_industry", DataType.SECTOR, True

    def __init__(self, index_dir: str | Path, known: pd.Series | None = None):
        self.dir, self.known = Path(index_dir), known

    def fetch(self, req: DataRequest) -> ProviderResult:
        m: dict[str, str] = {}
        if self.known is not None:
            m.update({t: s for t, s in self.known.items() if s and s not in ("Unknown", UNCLASSIFIED)})
        for f in sorted(self.dir.glob("*/*.csv")) + sorted(self.dir.glob("*.csv")):     # older first; newest wins
            try:
                df = pd.read_csv(f)
            except Exception:
                continue
            cols = {c.strip().lower(): c for c in df.columns}
            if "symbol" in cols and "industry" in cols:
                m.update({f"{a.strip()}.NS": b for a, b in zip(df[cols["symbol"]], df[cols["industry"]]) if isinstance(b, str)})
        out = {s: m[s] for s in req.symbols or [] if s in m}
        if not out:
            raise ProviderError("no NSE industry data")
        return ProviderResult(out, _d(req.as_of))


class YahooSectorProvider:
    log_miss = True
    name, data_type, primary = "yahoo_sector", DataType.SECTOR, False

    def __init__(self, info_fetch: Callable[[str], dict], mapping: dict):
        self.fetch_info, self.mapping = info_fetch, mapping

    def fetch(self, req: DataRequest) -> ProviderResult:
        out = {}
        for s in req.symbols or []:
            try:
                sec = (self.fetch_info(s) or {}).get("sector")
            except Exception:
                continue
            if sec:
                out[s] = self.mapping.get(sec, sec)          # unmapped stays as-is; quality is fallback either way
        if not out:
            raise ProviderError("yahoo sector returned nothing")
        return ProviderResult(out, _d(req.as_of))


def build_sector_resolver(config=None, info_fetch=None, known: pd.Series | None = None, gap_log=None, sleep=time.sleep) -> DataResolver:
    cfg = config or load_config()
    if info_fetch is None:
        def info_fetch(sym):
            import yfinance as yf
            return yf.Ticker(sym).info
    r = DataResolver(cfg, gap_log=gap_log, sleep=sleep)
    r.register(DataType.SECTOR, [SectorCacheProvider(cfg["sector"]["map_file"]),
                                 NseIndustryProvider(cfg["universe"]["cache_dir"], known),
                                 YahooSectorProvider(info_fetch, load_sector_mapping(cfg["sector"].get("mapping_file")))])
    return r


def resolve_sectors(resolver: DataResolver, symbols: list[str], as_of) -> tuple[dict[str, str], dict]:
    """Every symbol gets a sector; the last resort is "Unclassified" (it still screens, spec §3.5)."""
    res = resolver.resolve_panel(DataRequest(DataType.SECTOR, _d(as_of), symbols=list(symbols)))
    return {s: (UNCLASSIFIED if r.missing else r.value) for s, r in res.items()}, res


# ------------------------------------------------------------------------------------------------ corporate actions
class YahooSplitsProvider:
    log_miss = True
    name, data_type, primary = "yahoo_splits", DataType.CORP_ACTIONS, False

    def __init__(self, split_fetch: Callable[[str], pd.Series]):
        self.fetch_splits = split_fetch

    def fetch(self, req: DataRequest) -> ProviderResult:
        out = {}
        for s in req.symbols or []:
            try:
                sp = self.fetch_splits(s)
            except Exception:
                continue
            if sp is not None:
                out[s] = [(pd.Timestamp(d).date(), float(r)) for d, r in sp.items() if r and r != 1]
        if not out:
            raise ProviderError("no split history")
        return ProviderResult(out, _d(req.as_of))


def build_actions_resolver(config=None, nse_fetch=None, split_fetch=None, gap_log=None, sleep=time.sleep) -> DataResolver:
    """Chain: NSE corporate-actions archive (nse_fetch: symbol -> [(date, ratio)], best effort) -> Yahoo splits."""
    cfg = config or load_config()
    chain: list = []
    if nse_fetch is not None:
        class NseActions(YahooSplitsProvider):
            name, primary = "nse_corp_actions", True
        chain.append(NseActions(nse_fetch))
    if split_fetch is None:
        def split_fetch(sym):
            import yfinance as yf
            return yf.Ticker(sym).splits
    chain.append(YahooSplitsProvider(split_fetch))
    r = DataResolver(cfg, gap_log=gap_log, sleep=sleep)
    r.register(DataType.CORP_ACTIONS, chain)
    return r


def annotate_corporate_actions(panels: dict, prov: dict, resolver: DataResolver, as_of, config=None, gap_log=None) -> list[str]:
    """Flag single-day jumps > threshold with no matching split/bonus. Only those symbols are looked up (one call each)."""
    cfg = (config or load_config())["corp_actions"]
    jumpy = {}
    for s, df in panels.items():
        c = pd.to_numeric(df["close"], errors="coerce")
        r = c.pct_change().abs()
        if (r > cfg["jump_threshold"]).any():
            jumpy[s] = pd.to_datetime(df["date"])[r > cfg["jump_threshold"]].dt.date.tolist()
    if not jumpy:
        return []
    acts = resolver.resolve_panel(DataRequest(DataType.CORP_ACTIONS, _d(as_of), symbols=list(jumpy)))
    flagged = []
    for s, days in jumpy.items():
        known = [] if acts[s].missing else [d for d, _ in acts[s].value]
        unexplained = [d for d in days if not any(abs((d - k).days) <= cfg["match_window_days"] for k in known)]
        if unexplained:
            flagged.append(s)
            if s in prov and prov[s].reason is None:
                prov[s].reason = Reason.UNADJUSTED_PRICES.value
            if gap_log:
                gap_log({"data_type": "CORP_ACTIONS", "symbol": s, "provider": "jump_check",
                         "reason": "possible_unadjusted_action", "detail": f"moves >{cfg['jump_threshold']:.0%} on {unexplained}"})
    return flagged
