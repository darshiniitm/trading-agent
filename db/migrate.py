"""Apply db/migrations/NNNN_*.sql in order, recording checksums in data_pipeline_log.schema_migrations (ops.* before migration 0008).

    python -m db.migrate            # uses SUPABASE_DB_URL from env / .env
    python -m db.migrate --smoke    # just `select 1`
Re-runnable: applied versions are skipped; a changed file for an applied version is an error.
"""
from __future__ import annotations
import hashlib, sys
from pathlib import Path
import psycopg
from db.connect import db_url

MIGRATIONS = Path(__file__).parent / "migrations"


def _checksum(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _ledger(conn) -> str:
    """Version table: data_pipeline_log.* once 0008 has renamed it, legacy ops.* before that."""
    for name in ("data_pipeline_log.schema_migrations", "ops.schema_migrations"):
        if conn.execute("select to_regclass(%s)", (name,)).fetchone()[0]:
            return name
    conn.execute("create schema if not exists ops")
    conn.execute("""create table ops.schema_migrations (
        version text primary key, checksum text not null, applied_at timestamptz not null default now())""")
    return "ops.schema_migrations"


def migrate(url: str | None = None) -> list[str]:
    applied_now: list[str] = []
    with psycopg.connect(url or db_url(), autocommit=True) as conn:
        done = dict(conn.execute(f"select version, checksum from {_ledger(conn)}").fetchall())
        for path in sorted(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")):
            v, ck = path.stem, _checksum(path)
            if v in done:
                if done[v] != ck:
                    raise RuntimeError(f"migration {v} was modified after being applied")
                continue
            with conn.transaction():
                conn.execute(path.read_text())
                conn.execute(f"insert into {_ledger(conn)} (version, checksum) values (%s, %s)", (v, ck))
            applied_now.append(v)
    return applied_now


if __name__ == "__main__":
    if "--smoke" in sys.argv:
        with psycopg.connect(db_url()) as c:
            print("select 1 ->", c.execute("select 1").fetchone()[0])
    else:
        print("applied:", migrate() or "nothing (up to date)")
