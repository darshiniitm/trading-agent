"""Refresh the weekly price cache from the UI (the "Refresh data" button), without ever leaving a half-empty cache.

bootstrap_literal.py only fetches tickers that are NOT cached, and a running engine keeps its loaded data in memory, so a
refresh = rebuild the weekly panel for every cached ticker in a temp dir -> swap it in only if (almost) every ticker came
back (old files kept as *.bak) -> the caller reloads the engine's environment.
"""
from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


class RefreshState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.state, self.done, self.total = "idle", 0, 0
        self.started_at = self.finished_at = self.error = None

    def try_begin(self, total: int = 0) -> bool:
        """Claim the (single) refresh slot. False if one is already running."""
        with self._lock:
            if self.state == "running":
                return False
            self.state, self.done, self.total = "running", 0, total
            self.started_at, self.finished_at, self.error = time.time(), None, None
            return True

    def set_total(self, total: int) -> None:
        with self._lock:
            if self.state != "running":
                self.state, self.started_at, self.finished_at, self.error = "running", time.time(), None, None
            self.total, self.done = total, 0

    def progress(self, done: int) -> None:
        with self._lock:
            self.done = done

    def finish(self) -> None:
        with self._lock:
            self.state, self.finished_at = "done", time.time()

    def fail(self, message: str) -> None:
        with self._lock:
            self.state, self.finished_at, self.error = "error", time.time(), message[:500]

    def snapshot(self) -> dict:
        with self._lock:
            return {"state": self.state, "done": self.done, "total": self.total, "started_at": self.started_at,
                    "finished_at": self.finished_at, "error": self.error}


def _weekly_paths(cache_dir: Path, weeks: int) -> tuple[Path, Path]:
    return cache_dir / f"weekly_ohlcv_{weeks}w.parquet", cache_dir / f"weekly_ohlcv_{weeks}w.meta.json"


def last_refreshed(cache_dir: Path, weeks: int) -> dict:
    """When the weekly cache was last fetched, and the newest bar it holds (a week still in progress counts)."""
    import json
    parquet, meta = _weekly_paths(Path(cache_dir), weeks)
    if not parquet.exists() or not meta.exists():
        return {"fetched_at": None, "latest_bar_date": None}
    try:
        fetched = datetime.fromtimestamp(json.loads(meta.read_text())["fetched_at"], tz=timezone.utc).isoformat(timespec="seconds")
        latest = str(pd.read_parquet(parquet, columns=["date"])["date"].max().date())
    except Exception:
        return {"fetched_at": None, "latest_bar_date": None}
    return {"fetched_at": fetched, "latest_bar_date": latest}


def run_refresh(adapter, cache_dir: Path, weeks: int, state: RefreshState, chunk: int = 60, pause: float = 6.0,
                min_fraction: float = 0.95, sleep=time.sleep) -> bool:
    """Returns True when the new cache was swapped in. Never raises: failures end in state 'error'."""
    cache_dir = Path(cache_dir)
    parquet, meta = _weekly_paths(cache_dir, weeks)
    tmp = None
    try:
        tickers = sorted(pd.read_parquet(parquet, columns=["ticker"])["ticker"].unique())
        state.set_total(len(tickers))
        tmp = Path(tempfile.mkdtemp(prefix="weekly_refresh_"))
        real_dir, adapter.cache_dir = adapter.cache_dir, tmp   # the adapter reads/writes weekly_ohlcv_* under cache_dir
        try:
            for i in range(0, len(tickers), chunk):
                batch = tickers[i:i + chunk]
                for attempt in range(4):
                    try:
                        adapter.weekly_ohlcv(batch, weeks)
                        break
                    except Exception:
                        if attempt == 3:
                            break   # this chunk is lost; the completeness check below decides if that matters
                        sleep(pause * (attempt + 1))
                state.progress(min(i + chunk, len(tickers)))
                if i + chunk < len(tickers):
                    sleep(pause)
        finally:
            adapter.cache_dir = real_dir
        new_parquet = tmp / parquet.name
        got = pd.read_parquet(new_parquet, columns=["ticker"])["ticker"].nunique() if new_parquet.exists() else 0
        if got < min_fraction * len(tickers):
            state.fail(f"only {got}/{len(tickers)} tickers came back (Yahoo may be rate limiting); the existing data was kept")
            return False
        for src, dst in ((parquet, cache_dir / f"{parquet.name}.bak"), (meta, cache_dir / f"{meta.name}.bak")):
            shutil.copy2(src, dst)
        os.replace(new_parquet, parquet)
        os.replace(tmp / meta.name, meta)
        state.finish()
        return True
    except Exception as exc:
        state.fail(f"{type(exc).__name__}: {exc}")
        return False
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
