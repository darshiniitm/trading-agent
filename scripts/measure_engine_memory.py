"""Peak memory of the engine's warm-up, phase by phase, with no network — to check it fits the 2 GB VM (1600M cap).

    python scripts/measure_engine_memory.py --mode warm   # caches count as fresh: nothing is downloaded
    python scripts/measure_engine_memory.py --mode cold   # every download runs, fed synthetic Yahoo-shaped frames
                                                          # built from the cached bars (the cold-start peak)

It copies data_cache/ and data_cache_literal/ into a scratch work dir first (the warm-up writes caches and the gap log),
so the real caches are never touched. Yahoo, NSE and Google are stubbed out: nothing leaves the machine.
"""
from __future__ import annotations

import argparse
import faulthandler
import signal
import os
import shutil
import sys
import tempfile
import time
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402

from engine.memory import usage_mb  # noqa: E402

_FIELDS = {"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"}


class _FakeYF(types.ModuleType):
    """Just enough of yfinance for the engine's loaders. cold: download() answers like Yahoo, from the cached bars."""

    def __init__(self, cold: bool, src: Path):
        super().__init__("yfinance")
        self.cold, self.src, self.calls = cold, src, []
        self._weekly = None

    def _bars(self, t: str, interval: str) -> pd.DataFrame | None:
        if interval == "1wk":
            if self._weekly is None:
                self._weekly = dict(tuple(pd.read_parquet(self.src / "data_cache_literal" / "weekly_ohlcv_260w.parquet").groupby("ticker")))
            return self._weekly.get(t)
        p = self.src / "data_cache" / "ohlcv" / "daily" / f"{t}.parquet"
        return pd.read_parquet(p) if p.exists() else None

    def download(self, tickers, period=None, interval="1d", start=None, **_kw):
        tickers = [tickers] if isinstance(tickers, str) else list(tickers)
        self.calls.append(len(tickers))
        if not self.cold:
            return pd.DataFrame()
        cols = {}
        for t in tickers:
            b = self._bars(t, interval)
            if b is None or b.empty:
                continue
            b = b.assign(date=pd.to_datetime(b["date"])).set_index("date")
            if start is not None:
                b = b[b.index >= pd.Timestamp(start)]
            for c, name in _FIELDS.items():
                cols[(t, name)] = b[c]
            cols[(t, "Adj Close")] = b["close"]
        if not cols:
            return pd.DataFrame()
        wide = pd.DataFrame(cols)
        wide.index.name = "Date"
        wide.columns = pd.MultiIndex.from_tuples(wide.columns, names=["Ticker", "Price"])
        return wide

    class Ticker:
        def __init__(self, *_a, **_k):
            raise RuntimeError("network disabled")


def _block_network() -> None:
    import urllib.request
    import requests

    def no_net(*_a, **_k):
        raise OSError("network disabled (measure_engine_memory)")
    urllib.request.urlopen = no_net
    requests.get = no_net
    requests.Session.request = no_net
    # the NSE/Google providers' fetcher is throttled to 2 req/s: fail at once instead of waiting out ~2,300 symbols
    import engine.resolution.universe as universe_mod
    universe_mod.http_fetcher = lambda *_a, **_k: no_net


def _fresh_clock() -> None:
    """Make every on-disk cache's age check pass ("fetched just now"), so warm mode downloads nothing."""
    import src.data.adapter as adapter_mod

    class Clock(types.ModuleType):
        def __getattr__(self, name):
            return getattr(time, name)
    clock = Clock("time")
    clock.time = lambda: 0.0      # every timestamp on disk is "in the future", i.e. younger than any TTL
    adapter_mod.time = clock


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=("warm", "cold"), default="warm")
    ap.add_argument("--workdir", help="scratch dir to copy the caches into (default: a new temp dir, removed after)")
    ap.add_argument("--keep", action="store_true", help="keep the work dir")
    a = ap.parse_args(argv)
    faulthandler.register(signal.SIGUSR1)   # `kill -USR1 <pid>` prints where a slow run is

    work = Path(a.workdir) if a.workdir else Path(tempfile.mkdtemp(prefix="engine_mem_"))
    work.mkdir(parents=True, exist_ok=True)
    for name in ("data_cache", "data_cache_literal"):
        if not (work / name).exists():
            shutil.copytree(ROOT / name, work / name, symlinks=True)
    for name in ("config",):
        if not (work / name).exists():
            (work / name).symlink_to(ROOT / name)
    (work / "results" / "prompt_arms").mkdir(parents=True, exist_ok=True)
    os.chdir(work)

    fake = _FakeYF(a.mode == "cold", work)
    sys.modules["yfinance"] = fake
    _block_network()
    _fresh_clock()   # universe lists / shares count as fresh in both modes (they would need the network otherwise)
    if a.mode == "cold":
        # drop the price caches' fetch stamps so every weekly/daily loader downloads again, like a VM whose caches went stale
        for meta in [*work.glob("data_cache*/weekly_ohlcv_*.meta.json"), *work.glob("data_cache*/daily_ohlcv_*.meta.json")]:
            meta.unlink()

    rows: list[tuple[str, float, dict]] = []
    t0 = time.time()

    def mark(label: str) -> None:
        rows.append((label, round(time.time() - t0, 1), usage_mb()))

    import engine.warmup as warmup
    seen: set = set()

    def progress(phase, done=None, total=None):
        if phase not in seen:
            seen.add(phase)
            mark(f"start {phase}")
    warmup.progress = progress

    mark("imports")
    from engine.app import context_from_env
    from engine.env import load_environment
    env = load_environment("literal")
    mark("environment loaded")
    ctx = context_from_env(env)
    ctx.prime()
    mark("indexes primed")
    from engine import memory
    memory.release()
    mark("after release()")

    print(f"mode={a.mode}  tickers: weekly={len(env.panels)} daily={len(env.daily_panels or {})}  "
          f"yf.download calls={len(fake.calls)} (max batch {max(fake.calls, default=0)})")
    print(f"{'step':<28}{'t (s)':>8}{'rss MB':>10}{'peak MB':>10}")
    for label, t, u in rows:
        rss = "-" if u["rss_mb"] is None else f"{u['rss_mb']:.0f}"
        print(f"{label:<28}{t:>8}{rss:>10}{u['peak_mb']:>10.0f}")

    if not a.keep and not a.workdir:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
