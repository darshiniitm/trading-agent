"""Data refresh from the UI: rebuild the weekly cache in a temp dir, swap it in only when complete, reload the engine."""
from __future__ import annotations

import json
import time

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from engine import refresh as rf
from engine.app import create_app

WEEKS = 260


class FakeAdapter:
    """Writes weekly_ohlcv_{weeks}w.parquet under cache_dir like OpenSourceAdapter, merging chunks."""
    def __init__(self, drop=()):
        self.cache_dir = None
        self.drop, self.calls = set(drop), []

    def weekly_ohlcv(self, tickers, weeks):
        self.calls.append(list(tickers))
        path = self.cache_dir / f"weekly_ohlcv_{weeks}w.parquet"
        rows = [{"ticker": t, "date": pd.Timestamp("2026-10-12"), "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10}
                for t in tickers if t not in self.drop]
        new = pd.DataFrame(rows)
        panel = pd.concat([pd.read_parquet(path), new]) if path.exists() else new
        panel.to_parquet(path)
        (self.cache_dir / f"weekly_ohlcv_{weeks}w.meta.json").write_text(json.dumps({"fetched_at": time.time()}))


def seed_cache(cache_dir, tickers=("A.NS", "B.NS", "C.NS", "D.NS"), fetched_at=1_000.0, date="2026-10-05"):
    cache_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame([{"ticker": t, "date": pd.Timestamp(date), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1} for t in tickers]).to_parquet(cache_dir / f"weekly_ohlcv_{WEEKS}w.parquet")
    (cache_dir / f"weekly_ohlcv_{WEEKS}w.meta.json").write_text(json.dumps({"fetched_at": fetched_at}))


def test_last_refreshed_reads_the_cache_meta_and_latest_bar(tmp_path):
    seed_cache(tmp_path, fetched_at=1_791_949_017.6, date="2026-10-12")
    out = rf.last_refreshed(tmp_path, WEEKS)
    assert out["fetched_at"].startswith("2026-10-14") and out["latest_bar_date"] == "2026-10-12"
    assert rf.last_refreshed(tmp_path / "nope", WEEKS) == {"fetched_at": None, "latest_bar_date": None}


def test_run_refresh_swaps_in_new_data_keeps_backup_and_reports_progress(tmp_path):
    seed_cache(tmp_path)
    state, ad = rf.RefreshState(), FakeAdapter()
    rf.run_refresh(ad, tmp_path, WEEKS, state, chunk=2, pause=0, sleep=lambda s: None)
    assert [len(c) for c in ad.calls] == [2, 2]
    snap = state.snapshot()
    assert snap["state"] == "done" and snap["done"] == snap["total"] == 4 and snap["error"] is None
    assert pd.read_parquet(tmp_path / f"weekly_ohlcv_{WEEKS}w.parquet")["date"].max() == pd.Timestamp("2026-10-12")
    assert (tmp_path / f"weekly_ohlcv_{WEEKS}w.parquet.bak").exists()
    assert json.loads((tmp_path / f"weekly_ohlcv_{WEEKS}w.meta.json").read_text())["fetched_at"] > 1_000.0


def test_run_refresh_aborts_and_leaves_the_cache_untouched_when_too_few_tickers_return(tmp_path):
    seed_cache(tmp_path)
    before = pd.read_parquet(tmp_path / f"weekly_ohlcv_{WEEKS}w.parquet")
    state = rf.RefreshState()
    rf.run_refresh(FakeAdapter(drop={"A.NS", "B.NS", "C.NS"}), tmp_path, WEEKS, state, chunk=4, pause=0, sleep=lambda s: None)
    snap = state.snapshot()
    assert snap["state"] == "error" and "1/4" in snap["error"]
    pd.testing.assert_frame_equal(pd.read_parquet(tmp_path / f"weekly_ohlcv_{WEEKS}w.parquet"), before)
    assert not (tmp_path / f"weekly_ohlcv_{WEEKS}w.parquet.bak").exists()


def test_a_failing_chunk_is_retried_then_recorded(tmp_path):
    seed_cache(tmp_path)

    class Flaky(FakeAdapter):
        def weekly_ohlcv(self, tickers, weeks):
            if not self.calls:
                self.calls.append("boom")
                raise RuntimeError("rate limited")
            super().weekly_ohlcv(tickers, weeks)

    state = rf.RefreshState()
    rf.run_refresh(Flaky(), tmp_path, WEEKS, state, chunk=4, pause=0, sleep=lambda s: None)
    assert state.snapshot()["state"] == "done"


def test_only_one_refresh_runs_at_a_time():
    state = rf.RefreshState()
    assert state.try_begin(total=10) is True
    assert state.try_begin(total=10) is False
    state.finish()
    assert state.try_begin(total=10) is True


def test_endpoints_start_once_report_status_and_reload_after_success(tmp_path):
    seed_cache(tmp_path)
    reloads, gate = [], []

    def runner(state):                      # the endpoint has already claimed the slot
        gate.append(1)
        state.finish()
        reloads.append("reloaded")

    app = create_app(offline=True, refresh_cache_dir=tmp_path, refresh_weeks=WEEKS, refresh_runner=runner)
    c = TestClient(app)
    s = c.get("/data/refresh").json()
    assert s["state"] == "idle" and s["last_refreshed"]["latest_bar_date"] == "2026-10-05"
    r = c.post("/data/refresh")
    assert r.status_code == 200 and r.json()["started"] is True
    deadline = time.time() + 3
    while not reloads and time.time() < deadline:
        time.sleep(0.01)
    assert reloads == ["reloaded"]
    assert c.get("/data/refresh").json()["state"] == "done"


def test_post_while_running_does_not_start_a_second_refresh(tmp_path):
    seed_cache(tmp_path)
    started = []
    app = create_app(offline=True, refresh_cache_dir=tmp_path, refresh_weeks=WEEKS, refresh_runner=lambda state: started.append(1))
    from engine import refresh as r
    app.state.refresh_state = state = r.RefreshState()
    state.try_begin(total=5)
    resp = TestClient(app).post("/data/refresh").json()
    assert resp["started"] is False and resp["state"] == "running" and started == []
