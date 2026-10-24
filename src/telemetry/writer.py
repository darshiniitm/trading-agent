"""Background writer for observability.* run records (the Python half of web/src/server/telemetry/pgStore.ts).

The engine writes its own tool_calls (data.fetch, screen.filter) so engine-side detail is not lost. Rows are queued in a
bounded deque (drop-oldest) and written by a daemon thread, so a slow or dead database can never slow or fail a request.
Writes are idempotent on (trace_id, span_id). A run row may not exist yet when the engine writes first (the TS side upserts
asynchronously), so the writer inserts a minimal placeholder `on conflict do nothing`; the TS upsert later fills it in and
moves started_at earlier.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from typing import Any, Callable

log = logging.getLogger("telemetry")

_COLS = {
    "tool_calls": ["run_id", "trace_id", "span_id", "parent_span_id", "agent_span_id", "tool_name", "tool_args", "rows_in", "rows_out",
                   "model", "provider", "input_tokens", "output_tokens", "gpu_ms", "status", "started_at", "ended_at", "duration_ms",
                   "input", "output", "truncated", "error_type", "error_msg"],
    "agent_calls": ["run_id", "trace_id", "span_id", "parent_span_id", "task_span_id", "agent_name", "agent_version", "model", "provider",
                    "input_tokens", "output_tokens", "gpu_ms", "status", "started_at", "ended_at", "duration_ms", "input", "output",
                    "truncated", "error_type", "error_msg"],
    "run_tasks": ["run_id", "trace_id", "span_id", "parent_span_id", "task_id", "task_name", "seq", "status", "started_at", "ended_at",
                  "duration_ms", "rows_in", "rows_out", "input", "output", "truncated", "error_type", "error_msg"],
}
_JSONB = {"input", "output", "tool_args"}
_ORDER = ["run_tasks", "agent_calls", "tool_calls"]


def _insert(table: str, rows: list[dict]) -> tuple[str, list]:
    cols = _COLS[table]
    params: list = []
    tuples = []
    for r in rows:
        ph = []
        for c in cols:
            v = r.get(c)
            if c in _JSONB and v is not None:
                v = json.dumps(v, default=str)
            params.append(v)
            ph.append("%s::jsonb" if c in _JSONB else "%s")
        tuples.append("(" + ", ".join(ph) + ")")
    sql = (f"insert into observability.{table} ({', '.join(cols)}) values {', '.join(tuples)} "
           "on conflict (trace_id, span_id) do nothing")
    return sql, params


class RunWriter:
    def __init__(self, dsn: str | None = None, *, queue_max: int = 5000, batch: int = 100, flush_s: float = 1.0,
                 connect: Callable[[], Any] | None = None, start: bool = True):
        self._dsn, self._batch, self._flush_s = dsn, batch, flush_s
        self._connect = connect
        self._q: deque = deque(maxlen=queue_max)
        self._cv = threading.Condition()
        self._known_runs: set[str] = set()
        self._conn = None
        self._stop = False
        self._failures = 0
        self._open_until = 0.0
        self.dropped = 0
        self.written = 0
        self._thread = threading.Thread(target=self._loop, name="telemetry-writer", daemon=True)
        if start:
            self._thread.start()

    # ---- producer side (never blocks, never raises) ----
    def add(self, table: str, row: dict) -> None:
        try:
            with self._cv:
                run_id = row.get("run_id")
                if run_id and run_id not in self._known_runs:
                    self._known_runs.add(run_id)
                    if len(self._known_runs) > 2000:
                        self._known_runs = {run_id}
                    self._push(("run", {"run_id": run_id, "trace_id": row.get("trace_id")}))
                self._push((table, row))
                if len(self._q) >= self._batch:
                    self._cv.notify()
        except Exception:                                               # noqa: BLE001
            pass

    def _push(self, item) -> None:
        if len(self._q) == self._q.maxlen:
            self.dropped += 1
        self._q.append(item)

    # ---- consumer side ----
    def _loop(self) -> None:
        while True:
            with self._cv:
                if not self._q and not self._stop:
                    self._cv.wait(self._flush_s)
                stop = self._stop
            self.flush_once()
            if stop and not self._q:
                return

    def flush_once(self) -> None:
        if time.monotonic() < self._open_until:
            return
        with self._cv:
            items = [self._q.popleft() for _ in range(min(len(self._q), self._batch * 4))]
        if not items:
            return
        try:
            self._write(items)
            self._failures = 0
        except Exception as exc:                                        # noqa: BLE001
            self._failures += 1
            self.dropped += len(items)
            self._conn = None
            if self._failures in (1, 3):
                log.warning("run-store write failed (%s); %d rows dropped", type(exc).__name__, len(items))
            if self._failures >= 3:
                self._open_until = time.monotonic() + min(30.0 * 2 ** (self._failures - 3), 300.0)

    def _get_conn(self):
        if self._conn is None:
            if self._connect is not None:
                self._conn = self._connect()
            else:
                import psycopg
                self._conn = psycopg.connect(self._dsn, autocommit=True, connect_timeout=3)
        return self._conn

    def _write(self, items: list) -> None:
        conn = self._get_conn()
        runs = {}
        for kind, row in items:
            if kind == "run":
                runs[row["trace_id"]] = row
        for row in runs.values():
            conn.execute("insert into observability.runs (run_id, trace_id, kind, status, started_at) values (%s, %s, 'prompt_run', 'running', now()) "
                         "on conflict (trace_id) do nothing", (row["run_id"], row["trace_id"]))
        for table in _ORDER:
            rows = [r for k, r in items if k == table]
            if rows:
                sql, params = _insert(table, rows)
                conn.execute(sql, params)
        self.written += len(items)

    def flush(self, timeout: float = 5.0) -> None:
        end = time.monotonic() + timeout
        while self._q and time.monotonic() < end:
            if self._thread.is_alive():
                with self._cv:
                    self._cv.notify()
                time.sleep(0.02)
            else:
                self.flush_once()

    def close(self, timeout: float = 5.0) -> None:
        self.flush(timeout)
        with self._cv:
            self._stop = True
            self._cv.notify()
        if self._thread.is_alive():
            self._thread.join(timeout)
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:                                               # noqa: BLE001
            pass
