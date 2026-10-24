"""Operations (spec §9): shared gap log, user uploads, data-health payload, nightly prefetch."""
from __future__ import annotations

import io
import re
import time
from datetime import date, timedelta

from src import telemetry
from pathlib import Path
from typing import Callable

import pandas as pd

from engine.resolution.calendar import TradingCalendar
from engine.resolution.config import load_config, load_registry
from engine.resolution.gaplog import GapLog
from engine.resolution.ohlcv import BhavcopyProvider, OhlcvCache
from engine.resolution.types import DataRequest, DataType
from engine.resolution.universe import build_universe_resolver, http_fetcher, parse_symbols, save_snapshot

_GAPLOG: dict[str, GapLog] = {}


def get_gaplog(config: dict | None = None) -> GapLog:
    cfg = config or load_config()
    path = cfg["ops"]["meta_db"]
    if path not in _GAPLOG:
        _GAPLOG[path] = GapLog(path)
    return _GAPLOG[path]


# ---------------------------------------------------------------- user upload (spec §9.4)
def save_upload(user_id: int, prompt_id: int, name: str, text: str, config: dict | None = None) -> Path:
    """Universe CSV (a `symbol` column required, optional `sector`). Stored as tier 0 for that prompt. Numeric ids only."""
    if not isinstance(user_id, int) or not isinstance(prompt_id, int) or isinstance(user_id, bool) or isinstance(prompt_id, bool):
        raise ValueError("user_id and prompt_id must be integers")
    try:
        parse_symbols(text)                                       # validates: needs a Symbol column and at least one symbol
    except Exception as exc:
        raise ValueError(f"invalid universe CSV: {exc}") from exc
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", Path(name).name) or "upload.csv"
    if not safe.lower().endswith(".csv"):
        safe += ".csv"
    d = Path((config or load_config())["universe"]["upload_dir"]) / str(user_id) / str(prompt_id)
    d.mkdir(parents=True, exist_ok=True)
    out = d / safe
    tmp = out.with_suffix(".tmp"); tmp.write_text(text); tmp.replace(out)
    return out


# ---------------------------------------------------------------- health (spec §9.2)
def data_health(loaded_provenance: list[dict] | None = None, config: dict | None = None) -> dict:
    """loaded_provenance: ticker->ResolvedData dicts of any environments already in memory (never loads one)."""
    log = get_gaplog(config)
    stale = missing = 0
    for prov in loaded_provenance or []:
        for r in prov.values():
            stale += r.quality == "stale"
            missing += r.quality == "missing"
    return {"last_success": log.last_success(), "stale_symbols": stale, "missing_symbols": missing,
            "approximated_indices": log.approx_indices(), "failures_by_provider": log.failures_by_provider(),
            "recent_gaps": log.recent(50), "gap_count": log.count()}


# ---------------------------------------------------------------- nightly prefetch (spec §9.1)
def run_prefetch(config: dict | None = None, today: date | None = None, force: bool = False, adapter=None,
                 fetcher: Callable[[str, float], bytes] | None = None, calendar: TradingCalendar | None = None,
                 log: GapLog | None = None) -> dict:
    """Order: equity master -> index snapshots -> bhavcopy -> Yahoo for symbols bhavcopy missed -> sector map -> corp actions.
    Idempotent: every step skips work already on disk for the day; per-symbol cache writes de-duplicate by date."""
    cfg = config or load_config()
    today = today or date.today()
    cal = calendar or TradingCalendar.from_file(cfg["ohlcv"].get("holidays_file"))
    log = log or get_gaplog(cfg)
    log.begin_run()
    summary: dict = {"date": str(today), "steps": {}}
    if not force and not cal.is_trading_day(today):
        summary["skipped"] = "not a trading day"
        return summary
    fetch = fetcher or http_fetcher(cfg["providers"]["niftyindices"].get("user_agent", "Mozilla/5.0"), cfg["providers"]["max_req_per_s"])
    timeout = cfg["providers"]["timeout_s"]
    reg = load_registry()
    cache = OhlcvCache(cfg["ohlcv"]["cache_dir"])

    def step(name: str, fn: Callable[[], object]):
        try:
            with telemetry.tool_span("data.prefetch", args={"step": name}):
                summary["steps"][name] = fn()
        except Exception as exc:
            summary["steps"][name] = f"failed: {type(exc).__name__}: {exc}"
            log({"data_type": name, "symbol": None, "provider": "prefetch", "reason": "no_data", "detail": f"{type(exc).__name__}: {exc}"})

    master: dict = {}

    def equity_master():
        d = Path(cfg["ops"]["equity_master_dir"]); d.mkdir(parents=True, exist_ok=True)
        out = d / f"{today}.csv"
        if not out.exists():
            raw = fetch(cfg["urls"]["equity_master"], timeout)
            tmp = out.with_suffix(".tmp"); tmp.write_bytes(raw); tmp.replace(out)
            log.success("nse_equity_master", "MCAP")
        df = pd.read_csv(out)
        df.columns = [c.strip() for c in df.columns]
        master["tickers"] = [f"{s.strip()}.NS" for s in df.loc[df["SERIES"].str.strip() == "EQ", "SYMBOL"]]
        return len(master["tickers"])

    def index_snapshots():
        done = 0
        for name, spec in reg.indices.items():
            slug = reg.slug(name)
            if (Path(cfg["universe"]["cache_dir"]) / slug / f"{today}.csv").exists():
                done += 1
                continue
            raw = fetch(reg.base_url + spec["file"], timeout)
            parse_symbols(raw)
            save_snapshot(Path(cfg["universe"]["cache_dir"]), slug, today, raw)
            log.success("niftyindices", "UNIVERSE")
            done += 1
        return done

    bhav_syms: set = set()

    def bhavcopy():
        bp = BhavcopyProvider(cfg["urls"]["bhavcopy"], cfg["ohlcv"]["bhavcopy_dir"], fetch, cal, timeout)
        n, d, got = 0, cal.last_trading_day(today), 0
        while n < cfg["ops"]["prefetch_bhavcopy_days"]:
            if cal.is_trading_day(d):
                df = bp.day(d)
                if df is not None:
                    got += 1
                    if d == cal.last_trading_day(today):
                        bhav_syms.update(df["ticker"])
                        for s, g in df.groupby("ticker"):
                            cache.save(s, g, "nse_bhavcopy")
                    log.success("nse_bhavcopy", "OHLCV")
                n += 1
            d -= timedelta(days=1)
        if not got:
            raise RuntimeError("no bhavcopy day available")
        return got

    def yahoo_missing():
        if adapter is None:
            return "skipped: no adapter"
        want = [t for t in master.get("tickers", []) if t not in bhav_syms]
        if not want:
            return 0
        got = adapter.daily_ohlcv(want, 60)
        for s, df in got.items():
            cache.save(s, df, "yahoo")
        log.success("yahoo", "OHLCV")
        return len(got)

    def sector_map():
        from engine.resolution.reference import NseIndustryProvider
        tickers = master.get("tickers", [])
        res = NseIndustryProvider(cfg["universe"]["cache_dir"]).fetch(DataRequest(DataType.SECTOR, today, symbols=tickers))
        p = Path(cfg["sector"]["map_file"]); p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        pd.DataFrame({"ticker": list(res.value), "sector": list(res.value.values())}).to_parquet(tmp, index=False)
        tmp.replace(p)
        log.success("nse_industry", "SECTOR")
        return len(res.value)

    def corp_actions():
        from engine.resolution.reference import annotate_corporate_actions, build_actions_resolver
        panels = {s: cache.load(s) for s in bhav_syms}                 # jump scan runs on cached history only
        return annotate_corporate_actions({k: v for k, v in panels.items() if v is not None}, {}, build_actions_resolver(), today, cfg, log)

    for name, fn in [("equity_master", equity_master), ("index_snapshots", index_snapshots), ("bhavcopy", bhavcopy),
                     ("yahoo_missing", yahoo_missing), ("sector_map", sector_map), ("corp_actions", corp_actions)]:
        step(name, fn)
    return summary
