"""Engine start-up: load market data once in the background, report progress, and answer 503 (not 500) until ready."""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import engine.app as app_mod
import engine.env as env_mod
from engine import watchdog
from engine.warmup import STATE, WarmState

ROOT = Path(__file__).resolve().parents[2]


class _Ctx:
    primed = 0

    def prime(self, progress=None):
        _Ctx.primed += 1
        return 0


@pytest.fixture(autouse=True)
def stub_context(monkeypatch):
    """The warm-up primes the DataContext built from the loaded environment; these tests stand in for both."""
    _Ctx.primed = 0
    monkeypatch.setattr(app_mod, "context_from_env", lambda env, offline=False: _Ctx())


@pytest.fixture(autouse=True)
def fresh_state():
    STATE.reset()
    STATE._thread = None
    yield
    STATE.reset()
    STATE._thread = None


def test_concurrent_first_requests_load_the_environment_once(monkeypatch):
    calls, gate = [], threading.Event()

    def slow_load(structure):
        calls.append(structure)
        gate.wait(5)
        return object()

    monkeypatch.setattr(env_mod, "_CACHE", {})
    monkeypatch.setattr(env_mod, "_LOCKS", {})
    monkeypatch.setattr(env_mod, "_load_live", slow_load)
    got = []
    ts = [threading.Thread(target=lambda: got.append(env_mod.load_environment("literal"))) for _ in range(16)]
    [t.start() for t in ts]
    time.sleep(0.3)
    gate.set()
    [t.join(5) for t in ts]
    assert len(calls) == 1                      # the race that corrupted the cache: 16 loaders -> 1
    assert len({id(e) for e in got}) == 1
    assert env_mod.load_environment("t1_literal") is got[0]   # same rule spec, same environment: no second load
    assert len(calls) == 1


def test_a_failed_load_is_not_cached_so_a_retry_can_succeed(monkeypatch):
    attempts = []

    def flaky(structure):
        attempts.append(1)
        if len(attempts) == 1:
            raise OSError("network blip")
        return object()

    monkeypatch.setattr(env_mod, "_CACHE", {})
    monkeypatch.setattr(env_mod, "_LOCKS", {})
    monkeypatch.setattr(env_mod, "_load_live", flaky)
    with pytest.raises(OSError):
        env_mod.load_environment("literal")
    assert env_mod.load_environment("literal") is not None
    assert len(attempts) == 2


def test_state_machine_reports_phases_then_ready():
    s, release = WarmState(), threading.Event()

    def load():
        s.progress("weekly_prices", 0, 2335)
        s.progress("shares", 100, 2300)
        release.wait(5)

    assert s.snapshot()["state"] == "starting"
    assert s.start(load) is True
    time.sleep(0.2)
    snap = s.snapshot()
    assert snap["state"] == "warming" and snap["phase"] == "shares" and (snap["done"], snap["total"]) == (100, 2300)
    assert snap["phase_index"] == 2 and snap["phases"][0] == "universe"
    assert s.start(load) is False               # already running
    release.set()
    for _ in range(50):
        if s.snapshot()["state"] == "ready":
            break
        time.sleep(0.05)
    assert s.snapshot()["state"] == "ready" and s.snapshot()["phase"] is None


def test_failure_is_reported_and_retryable():
    s = WarmState()

    def boom():
        raise OSError("Unexpected end of stream")

    s.start(boom)
    for _ in range(50):
        if s.snapshot()["state"] == "error":
            break
        time.sleep(0.05)
    snap = s.snapshot()
    assert snap["state"] == "error" and snap["retryable"] and "Unexpected end of stream" in snap["error"]
    assert s.start(lambda: None) is True        # a retry is allowed after an error
    for _ in range(50):
        if s.snapshot()["state"] == "ready":
            break
        time.sleep(0.05)
    assert s.snapshot()["state"] == "ready" and s.snapshot()["error"] is None


def test_requests_get_503_with_progress_while_warming_then_work(monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(app_mod, "load_environment", lambda *a, **k: gate.wait(5) or object())
    with TestClient(app_mod.create_app(offline=False)) as c:       # entering the client runs the lifespan -> warm-up starts
        for _ in range(50):
            if STATE.snapshot()["state"] == "warming":
                break
            time.sleep(0.05)
        r = c.post("/screen/v5", json={"program": {}, "as_of": "2026-09-04"})
        assert r.status_code == 503
        assert r.headers["retry-after"] == "3"
        assert r.json()["detail"]["engine"]["state"] == "warming"
        t0 = time.time()
        h = c.get("/health").json()                                  # must not block on the load
        assert time.time() - t0 < 1.0
        assert h["warm"]["state"] == "warming" and h["last_bar_date"] is None
        assert c.get("/conditions/v5").status_code == 200            # nothing that needs market data is gated
        gate.set()
        for _ in range(50):
            if STATE.snapshot()["state"] == "ready":
                break
            time.sleep(0.05)
        assert _Ctx.primed == 1                                       # indexes were built during the warm-up, before "ready"
        assert c.post("/screen/v5", json={"program": {}, "as_of": "2026-09-04"}).status_code == 422   # past the gate: program shape is checked


def test_error_state_answers_503_and_retry_restarts(monkeypatch):
    n = []

    def load(*a, **k):
        n.append(1)
        if len(n) == 1:
            raise OSError("boom")
        return object()

    monkeypatch.setattr(app_mod, "load_environment", load)
    with TestClient(app_mod.create_app(offline=False)) as c:
        for _ in range(50):
            if STATE.snapshot()["state"] == "error":
                break
            time.sleep(0.05)
        r = c.post("/screen/v5", json={"program": {}, "as_of": "2026-09-04"})
        assert r.status_code == 503 and r.json()["detail"]["engine"]["retryable"] is True
        assert c.post("/warmup/retry").json()["state"] in ("warming", "ready")
        for _ in range(50):
            if STATE.snapshot()["state"] == "ready":
                break
            time.sleep(0.05)
        assert STATE.snapshot()["state"] == "ready" and len(n) == 2


def test_offline_engine_is_always_ready(client):
    assert client.get("/health").json()["warm"]["state"] == "ready"
    assert client.post("/screen/v5", json={"program": {}, "as_of": "2026-09-04"}).status_code == 422


def test_pid_alive():
    assert watchdog.pid_alive(os.getpid())
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    assert not watchdog.pid_alive(p.pid)


def test_engine_exits_when_the_app_that_started_it_is_killed():
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    code = "import time; from engine import watchdog; assert watchdog.start_from_env(); time.sleep(60)"
    child = subprocess.Popen([sys.executable, "-c", code], cwd=ROOT,
                             env={**os.environ, "ENGINE_PARENT_PID": str(parent.pid), "ENGINE_WATCHDOG_INTERVAL": "0.2", "PYTHONPATH": str(ROOT)})
    try:
        time.sleep(1.0)
        assert child.poll() is None             # parent alive -> engine stays up
        parent.kill()                           # the web app dies (SIGKILL: no cleanup handler can run)
        child.wait(timeout=8)                   # the engine follows it
        assert child.returncode is not None
    finally:
        for p in (parent, child):
            if p.poll() is None:
                p.kill()


def test_no_parent_pid_means_no_watchdog():
    assert watchdog.start_from_env({}) is None
    assert watchdog.start_from_env({"ENGINE_PARENT_PID": "not-a-pid"}) is None


def test_prime_builds_every_series_up_front_and_matches_lazy_building():
    import pandas as pd
    from engine.v5.data import DataContext
    idx = pd.date_range("2025-01-01", periods=40, freq="B")
    daily = {t: pd.DataFrame({"date": idx, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 100.0}) for t in ("A.NS", "B.NS")}
    lazy, primed = DataContext(pd.DataFrame(), daily_panels=daily), DataContext(pd.DataFrame(), daily_panels=daily)
    seen = []
    assert primed.prime(progress=lambda d, t: seen.append((d, t))) == 4          # 2 tickers x (1D, 1W)
    assert set(primed._cache) == {("A.NS", "1D"), ("A.NS", "1W"), ("B.NS", "1D"), ("B.NS", "1W")}
    assert seen[-1] == (2, 2)
    assert primed.prime() == 0                                                    # idempotent
    as_of = pd.Timestamp("2025-02-14")
    for t in daily:
        for tf in ("1D", "1W"):
            pd.testing.assert_frame_equal(primed.bars(t, tf, as_of), lazy.bars(t, tf, as_of))


def test_warm_phases_end_with_building_indexes():
    assert STATE.snapshot()["phases"][-1] == "indexes"
