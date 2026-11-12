"""Gap log + fetch log (spec §8, §9.3). Lives in the engine's own meta sqlite (spec §4: provenance.sqlite) —
the engine is the only writer; the web app reads it through /data/health."""
from __future__ import annotations

import sqlite3
import threading
from datetime import datetime
from pathlib import Path

from engine.resolution.config import load_config

SCHEMA = """
CREATE TABLE IF NOT EXISTS data_gap_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, logged_at TEXT NOT NULL, data_type TEXT NOT NULL, symbol TEXT,
  provider TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS fetch_log (
  provider TEXT NOT NULL, data_type TEXT NOT NULL, last_ok_at TEXT NOT NULL, PRIMARY KEY (provider, data_type)
);
CREATE TABLE IF NOT EXISTS approx_log (
  index_name TEXT PRIMARY KEY, last_used_at TEXT NOT NULL, rule TEXT
);
"""


class GapLog:
    def __init__(self, path: str | Path | None = None, config: dict | None = None):
        self.path = Path(path or (config or load_config())["ops"]["meta_db"])
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock, self._seen = threading.Lock(), set()
        with self._conn() as c:
            c.executescript(SCHEMA)

    def _conn(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        return c

    def begin_run(self) -> None:
        """Identical rows are written once per run (spec §9.3)."""
        with self._lock:
            self._seen = set()

    def __call__(self, row: dict) -> None:
        key = (row["data_type"], row.get("symbol"), row["provider"], row["reason"], row.get("detail"))
        with self._lock:
            if key in self._seen:
                return
            self._seen.add(key)
        with self._conn() as c:
            c.execute("INSERT INTO data_gap_log (logged_at, data_type, symbol, provider, reason, detail) VALUES (?,?,?,?,?,?)",
                      (datetime.now().isoformat(timespec="seconds"), row["data_type"], row.get("symbol"), row["provider"],
                       row["reason"], row.get("detail")))

    def success(self, provider: str, data_type: str) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO fetch_log (provider, data_type, last_ok_at) VALUES (?,?,?) "
                      "ON CONFLICT(provider, data_type) DO UPDATE SET last_ok_at = excluded.last_ok_at",
                      (provider, data_type, datetime.now().isoformat(timespec="seconds")))

    def approx_used(self, index_name: str, rule: str | None) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO approx_log (index_name, last_used_at, rule) VALUES (?,?,?) "
                      "ON CONFLICT(index_name) DO UPDATE SET last_used_at = excluded.last_used_at, rule = excluded.rule",
                      (index_name, datetime.now().isoformat(timespec="seconds"), rule))

    # ---- reads (health page)
    def recent(self, n: int = 50) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM data_gap_log ORDER BY id DESC LIMIT ?", (n,))]

    def failures_by_provider(self) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                "SELECT provider, data_type, reason, COUNT(*) AS n FROM data_gap_log GROUP BY provider, data_type, reason ORDER BY n DESC")]

    def last_success(self) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM fetch_log ORDER BY data_type, provider")]

    def approx_indices(self) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM approx_log ORDER BY last_used_at DESC")]

    def count(self) -> int:
        with self._conn() as c:
            return c.execute("SELECT COUNT(*) FROM data_gap_log").fetchone()[0]
