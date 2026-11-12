"""Per-user API keys for the plugin-facing engine API (Engine Production Plan, Phase 3).

A key looks like ``ek_<key_id>_<secret>``. Only HMAC-SHA256(pepper, key) is stored, so a database leak does not expose keys, and
each key can be revoked on its own. The pepper is the ``API_PEPPER`` secret. ``ENGINE_TOKEN`` (the web app's shared bearer) keeps
working beside these keys; see engine/app.py.

    python -m engine.apikeys issue --label alice      # prints the key once
    python -m engine.apikeys revoke <key_id>
    python -m engine.apikeys list
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from typing import Protocol

PREFIX = "ek_"


def hash_key(key: str, pepper: str) -> str:
    return hmac.new(pepper.encode(), key.encode(), hashlib.sha256).hexdigest()


def new_key() -> tuple[str, str]:
    """(key_id, full key). The id is public (it appears in listings and logs); the secret half never is."""
    key_id = secrets.token_hex(4)
    return key_id, f"{PREFIX}{key_id}_{secrets.token_urlsafe(32)}"


class KeyStore(Protocol):
    def add(self, key_id: str, label: str, key_hash: str) -> None: ...
    def find_active(self, key_hash: str) -> str | None: ...      # -> key_id, or None if unknown / revoked
    def revoke(self, key_id: str) -> bool: ...
    def list(self) -> list[dict]: ...


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}

    def add(self, key_id, label, key_hash):
        self.rows[key_id] = {"key_id": key_id, "label": label, "key_hash": key_hash, "revoked": False}

    def find_active(self, key_hash):
        for r in self.rows.values():
            if not r["revoked"] and hmac.compare_digest(r["key_hash"], key_hash):
                return r["key_id"]
        return None

    def revoke(self, key_id):
        if key_id not in self.rows or self.rows[key_id]["revoked"]:
            return False
        self.rows[key_id]["revoked"] = True
        return True

    def list(self):
        return [{k: v for k, v in r.items() if k != "key_hash"} for r in self.rows.values()]


class PgStore:
    """screener_app.engine_api_keys (db/migrations/0013), over SUPABASE_DB_URL. One short connection per call."""

    def __init__(self, url: str | None = None) -> None:
        self._url = url

    def _conn(self):
        import psycopg
        if self._url:
            return psycopg.connect(self._url, autocommit=True)
        from db.connect import db_url
        return psycopg.connect(db_url(), autocommit=True)

    def add(self, key_id, label, key_hash):
        with self._conn() as c:
            c.execute("insert into screener_app.engine_api_keys (key_id, label, key_hash) values (%s,%s,%s)", (key_id, label, key_hash))

    def find_active(self, key_hash):
        with self._conn() as c:
            row = c.execute(
                "update screener_app.engine_api_keys set last_used_at = now() where key_hash = %s and revoked_at is null returning key_id",
                (key_hash,)).fetchone()
        return row[0] if row else None

    def revoke(self, key_id):
        with self._conn() as c:
            return c.execute("update screener_app.engine_api_keys set revoked_at = now() where key_id = %s and revoked_at is null",
                             (key_id,)).rowcount > 0

    def list(self):
        with self._conn() as c:
            cur = c.execute("select key_id, label, created_at, revoked_at, last_used_at from screener_app.engine_api_keys order by created_at")
            cols = [d.name for d in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


class RateLimiter:
    """Sliding one-minute window per key. In-process, which is exact because the engine runs as exactly one replica."""

    def __init__(self, per_minute: int, clock=time.monotonic) -> None:
        self.per_minute, self._clock = per_minute, clock
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key_id: str) -> bool:
        if self.per_minute <= 0:
            return True
        now = self._clock()
        with self._lock:
            q = self._hits[key_id]
            while q and now - q[0] >= 60:
                q.popleft()
            if len(q) >= self.per_minute:
                return False
            q.append(now)
            return True


class KeyAuth:
    def __init__(self, store: KeyStore, pepper: str) -> None:
        self.store, self.pepper = store, pepper

    def authenticate(self, bearer: str) -> str | None:
        """key_id for a live key, else None. Looked up on every request, so a revoked key stops working at once."""
        if not bearer.startswith(PREFIX):
            return None
        return self.store.find_active(hash_key(bearer, self.pepper))

    def issue(self, label: str) -> tuple[str, str]:
        key_id, key = new_key()
        self.store.add(key_id, label, hash_key(key, self.pepper))
        return key_id, key


def from_env(store: KeyStore | None = None) -> KeyAuth | None:
    """None (per-user keys off) unless API_PEPPER is set, so local development is unchanged."""
    pepper = os.environ.get("API_PEPPER", "")
    return KeyAuth(store or PgStore(), pepper) if pepper else None


def _cli(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m engine.apikeys")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("issue"); s.add_argument("--label", required=True)
    s = sub.add_parser("revoke"); s.add_argument("key_id")
    sub.add_parser("list")
    a = p.parse_args(argv)
    auth = from_env()
    if auth is None:
        print("API_PEPPER is not set", flush=True)
        return 2
    if a.cmd == "issue":
        key_id, key = auth.issue(a.label)
        print(f"key_id: {key_id}\nkey (shown once, store it now): {key}")
    elif a.cmd == "revoke":
        print("revoked" if auth.store.revoke(a.key_id) else "no such active key")
    else:
        for r in auth.store.list():
            print(r)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
