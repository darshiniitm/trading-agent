"""Universe / index-constituent chain (spec §3.2).

Tiers, in order:
  0 user_upload        — uploaded CSV for this prompt/index wins                       (primary → ok)
  1 local_snapshot     — nearest dated snapshot on/before as_of, if fresh              (primary → ok)
  2 niftyindices       — live constituent CSV; on success saved as a dated snapshot    (primary → ok)
  3 older_snapshot     — nearest snapshot within tolerance → fallback; beyond → stale
  4 rule_approx        — top-N by market cap among eligible stocks                     (approx)
Snapshot layout: <cache_dir>/<index_slug>/<YYYY-MM-DD>.csv (legacy flat <slug>_<date>.csv is still read).
niftyindices constituent URLs verified reachable 2026-10-07 (see config/index_registry.yaml).
"""
from __future__ import annotations

import io
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Callable

import pandas as pd

from engine.resolution.config import IndexRegistry, load_config, load_registry
from engine.resolution.resolver import DataResolver
from engine.resolution.types import DataRequest, DataType, ProviderError, ProviderResult, Reason

FRESH_DAYS = 7          # a snapshot this close to as_of is served by tier 1 without a live check


def _d(x) -> date:
    return pd.Timestamp(x).date()


def parse_symbols(raw: bytes | str) -> list[str]:
    df = pd.read_csv(io.BytesIO(raw) if isinstance(raw, bytes) else io.StringIO(raw))
    col = next((c for c in df.columns if c.strip().lower() == "symbol"), None)
    if col is None:
        raise ProviderError("CSV has no Symbol column")
    out = [f"{s.strip()}.NS" for s in df[col].dropna() if str(s).strip()]
    if not out:
        raise ProviderError("CSV has no symbols")
    return out


def list_snapshots(cache_dir: Path, slug: str) -> list[tuple[date, Path]]:
    found = []
    for f in (cache_dir / slug).glob("*.csv") if (cache_dir / slug).is_dir() else []:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", f.stem):
            found.append((_d(f.stem), f))
    for f in cache_dir.glob(f"{slug}_*.csv"):
        m = re.search(r"_(\d{4}-\d{2}-\d{2})\.csv$", f.name)
        if m:
            found.append((_d(m.group(1)), f))
    return sorted(found)


def nearest_snapshot(cache_dir: Path, slug: str, as_of: date) -> tuple[date, Path] | None:
    cands = [s for s in list_snapshots(cache_dir, slug) if s[0] <= as_of]
    return cands[-1] if cands else None


def save_snapshot(cache_dir: Path, slug: str, on: date, raw: bytes) -> Path:
    d = cache_dir / slug
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"{on}.csv"
    tmp = out.with_suffix(".csv.tmp")
    tmp.write_bytes(raw)
    tmp.replace(out)                                   # atomic
    out.with_suffix(".meta.json").write_text(f'{{"source": "niftyindices", "as_of": "{on}"}}')
    return out


class UserUploadProvider:
    name, data_type, primary = "user_upload", DataType.UNIVERSE, True

    def __init__(self, upload_dir: Path):
        self.dir = Path(upload_dir)

    def fetch(self, req: DataRequest) -> ProviderResult:
        uid, pid = req.params.get("user_id"), req.params.get("prompt_id")
        if uid is None or pid is None:
            raise ProviderError("no upload context")
        d = self.dir / str(uid) / str(pid)
        files = sorted(d.glob("*.csv")) if d.is_dir() else []
        if not files:
            raise ProviderError("no upload")
        return ProviderResult(parse_symbols(files[-1].read_bytes()), req.as_of, "ok", source="user_upload",
                              meta={"file": files[-1].name})


class LocalSnapshotProvider:
    """tier 1 (fresh_only=True) and tier 3 (fresh_only=False, graded by age)."""
    data_type = DataType.UNIVERSE

    def __init__(self, cache_dir: Path, registry: IndexRegistry, tolerance_days: int, fresh_only: bool):
        self.dir, self.reg, self.tol, self.fresh_only = Path(cache_dir), registry, tolerance_days, fresh_only
        self.name = "local_snapshot" if fresh_only else "older_snapshot"
        self.primary = fresh_only

    def fetch(self, req: DataRequest) -> ProviderResult:
        as_of = _d(req.as_of)
        snap = nearest_snapshot(self.dir, self.reg.slug(req.key), as_of)
        if snap is None:
            raise ProviderError("no snapshot on or before as_of")
        sdate, path = snap
        age = (as_of - sdate).days
        if self.fresh_only:
            if age > FRESH_DAYS:
                raise ProviderError(f"snapshot is {age}d old")
            return ProviderResult(parse_symbols(path.read_bytes()), sdate, "ok", source="cache:niftyindices",
                                  meta={"snapshot": str(sdate), "age_days": age})
        if age <= self.tol:
            return ProviderResult(parse_symbols(path.read_bytes()), sdate, "fallback", source="cache:niftyindices",
                                  meta={"snapshot": str(sdate), "age_days": age})
        return ProviderResult(parse_symbols(path.read_bytes()), sdate, "stale", Reason.STALE_DATA,
                              source="cache:niftyindices", meta={"snapshot": str(sdate), "age_days": age})


class _Throttle:
    def __init__(self, per_s: float):
        self.gap, self.last, self.lock = 1.0 / per_s, {}, threading.Lock()

    def wait(self, host: str):
        with self.lock:
            now = time.monotonic()
            nxt = max(now, self.last.get(host, 0) + self.gap)
            self.last[host] = nxt
        if nxt > now:
            time.sleep(nxt - now)


def _ssl_context():
    # python.org macOS builds ship without a root-cert store; certifi (a requests dependency) has one.
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def http_fetcher(user_agent: str, per_s: float = 2.0) -> Callable[[str, float], bytes]:
    th = _Throttle(per_s)

    def fetch(url: str, timeout: float) -> bytes:
        th.wait(urllib.parse.urlparse(url).netloc)
        req = urllib.request.Request(url, headers={"User-Agent": user_agent})
        return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()).read()
    return fetch


class NiftyIndicesProvider:
    name, data_type, primary = "niftyindices", DataType.UNIVERSE, True

    def __init__(self, cache_dir: Path, registry: IndexRegistry, fetcher: Callable[[str, float], bytes],
                 timeout: float = 15, today: Callable[[], date] = date.today):
        self.dir, self.reg, self.fetcher, self.timeout, self.today = Path(cache_dir), registry, fetcher, timeout, today

    def fetch(self, req: DataRequest) -> ProviderResult:
        url = self.reg.url(req.key)
        if not url:
            raise ProviderError(f"{req.key!r} is not in the index registry")
        raw = self.fetcher(url, self.timeout)
        symbols = parse_symbols(raw)                   # validate before saving
        today = self.today()
        save_snapshot(self.dir, self.reg.slug(req.key), today, raw)
        historical = _d(req.as_of) < today - timedelta(days=FRESH_DAYS)
        # a current list used for a past date is a survivorship hazard (§3.2): attach the reason, keep the quality
        return ProviderResult(symbols, today, "ok", Reason.SURVIVORSHIP_RISK if historical else None,
                              source="niftyindices", meta={"snapshot": str(today), "url": url})


class ApproxUniverseProvider:
    """Top-N by market cap among eligible stocks. mcap: Series indexed by ticker (computed by the caller)."""
    name, data_type, primary = "rule_approx", DataType.UNIVERSE, False

    def __init__(self, registry: IndexRegistry, allowed: bool = True):
        self.reg, self.allowed = registry, allowed

    def fetch(self, req: DataRequest) -> ProviderResult:
        if not self.allowed:
            raise ProviderError("approximated universes are disabled")
        rule = (self.reg.spec(req.key) or {}).get("approximation")
        mcap = req.params.get("mcap")
        mcap = mcap() if callable(mcap) else mcap      # lazy: only computed if every earlier tier failed
        if not rule or mcap is None or len(mcap.dropna()) == 0:
            raise ProviderError("no approximation rule or no market-cap data")
        ranked = mcap.dropna().sort_values(ascending=False)
        skip, n = int(rule.get("skip_top_n", 0)), int(rule["top_n_by_mcap"])
        tickers = list(ranked.index[skip:skip + n])
        return ProviderResult(tickers, req.as_of, "approx", Reason.APPROX_INPUT, source="rule_approx",
                              meta={"rule": f"top {n} by mcap" + (f" after skipping {skip}" if skip else ""),
                                    "universe_size_requested": n})


def build_universe_resolver(config: dict | None = None, registry: IndexRegistry | None = None,
                            cache_dir: str | Path | None = None, network: bool = True,
                            fetcher: Callable[[str, float], bytes] | None = None,
                            today: Callable[[], date] = date.today, gap_log=None, sleep=time.sleep,
                            success_log=None) -> DataResolver:
    cfg = config or load_config()
    reg = registry or load_registry()
    ucfg, pcfg = cfg["universe"], cfg["providers"]
    cache = Path(cache_dir or ucfg["cache_dir"])
    tol = int(ucfg["snapshot_tolerance_days"])
    chain: list = [UserUploadProvider(Path(ucfg["upload_dir"])),
                   LocalSnapshotProvider(cache, reg, tol, fresh_only=True)]
    if network and pcfg.get("niftyindices", {}).get("enabled", True):
        chain.append(NiftyIndicesProvider(
            cache, reg, fetcher or http_fetcher(pcfg["niftyindices"].get("user_agent", "Mozilla/5.0"), pcfg.get("max_req_per_s", 2)),
            pcfg.get("timeout_s", 15), today))
    chain.append(LocalSnapshotProvider(cache, reg, tol, fresh_only=False))
    chain.append(ApproxUniverseProvider(reg, cfg["fallback"]["allow_approx_universe"]))
    r = DataResolver(cfg, sleep=sleep, gap_log=gap_log, success_log=success_log)
    r.register(DataType.UNIVERSE, chain)
    return r
