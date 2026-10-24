"""What the engine is doing while it loads its market data, in a form the app can show.

Loading the live environment pulls ~2,300 tickers and takes minutes the first time. Instead of failing the first
requests (or loading twice in parallel), the engine loads once in the background and reports where it is:

    starting -> warming(phase, done/total) -> ready          (or -> error, retryable)

`progress()` is the hook the loaders call. It is a no-op unless a warm-up is running, so CLI scripts are unaffected.
"""
from __future__ import annotations

import threading
import time
from typing import Callable

PHASES = ("universe", "weekly_prices", "shares", "daily_bars", "reference_data", "indexes")


class WarmState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self.state = "starting"
            self.phase: str | None = None
            self.done: int | None = None
            self.total: int | None = None
            self.started_at: float | None = None
            self.phase_started_at: float | None = None
            self.finished_at: float | None = None
            self.error: str | None = None

    def begin(self) -> None:
        with self._lock:
            self.state, self.error = "warming", None
            self.started_at = self.phase_started_at = time.time()
            self.phase, self.done, self.total, self.finished_at = PHASES[0], None, None, None

    def progress(self, phase: str, done: int | None = None, total: int | None = None) -> None:
        with self._lock:
            if self.state != "warming":
                return
            if phase != self.phase:
                self.phase_started_at = time.time()
            self.phase, self.done, self.total = phase, done, total

    def ready(self) -> None:
        with self._lock:
            self.state, self.phase, self.done, self.total, self.finished_at = "ready", None, None, None, time.time()

    def fail(self, exc: BaseException) -> None:
        with self._lock:
            self.state, self.finished_at = "error", time.time()
            self.error = f"{type(exc).__name__}: {exc}"[:500]

    def snapshot(self) -> dict:
        with self._lock:
            now = time.time()
            return {
                "state": self.state,
                "phase": self.phase,
                "phase_index": PHASES.index(self.phase) if self.phase in PHASES else None,
                "phases": list(PHASES),
                "done": self.done,
                "total": self.total,
                "elapsed_s": round((self.finished_at or now) - self.started_at, 1) if self.started_at else 0.0,
                "phase_elapsed_s": round(now - self.phase_started_at, 1) if self.phase_started_at and self.state == "warming" else 0.0,
                "error": self.error,
                "retryable": self.state == "error",
            }

    # ---- background run ----------------------------------------------------
    def start(self, load: Callable[[], object]) -> bool:
        """Run `load` once in a daemon thread. Returns False if a warm-up is already running or finished OK."""
        with self._lock:
            if (self._thread and self._thread.is_alive()) or self.state == "ready":
                return False
        self.begin()

        def run() -> None:
            try:
                load()
                self.ready()
            except BaseException as exc:   # noqa: BLE001  (reported to the app, which offers a retry)
                self.fail(exc)

        t = threading.Thread(target=run, name="engine-warmup", daemon=True)
        with self._lock:
            self._thread = t
        t.start()
        return True


STATE = WarmState()


def progress(phase: str, done: int | None = None, total: int | None = None) -> None:
    STATE.progress(phase, done, total)
