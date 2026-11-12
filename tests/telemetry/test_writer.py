import pathlib
import shutil
import tempfile
import time

import psycopg
import pytest

pytest.importorskip("pgserver")
from db.migrate import migrate
from src.telemetry.writer import RunWriter
from tests.pg_fixture import temp_pg

RUN = "22222222-2222-2222-2222-222222222222"


@pytest.fixture(scope="module")
def uri():
    """Migration chain minus 0009_auth (needs citext, which the embedded pgserver lacks); 0010 does not depend on it."""
    import db.migrate as m
    tmp = pathlib.Path(tempfile.mkdtemp())
    for f in sorted(m.MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        if not f.name.startswith("0009_"):
            shutil.copy(f, tmp / f.name)
    srv, u = temp_pg()
    real, m.MIGRATIONS = m.MIGRATIONS, tmp
    try:
        migrate(u)
        yield u
    finally:
        m.MIGRATIONS = real
        srv.cleanup()


def tool_row(span, **over):
    return {"run_id": RUN, "trace_id": "t" * 32, "span_id": span, "parent_span_id": None, "tool_name": "data.fetch", "tool_args": {"source": "yahoo"},
            "rows_in": 10, "rows_out": 8, "status": "ok", "started_at": "2026-10-23T00:00:00+00:00", "ended_at": "2026-10-23T00:00:01+00:00",
            "duration_ms": 1000, "input": None, "output": None, "truncated": False, **over}


def test_writes_idempotently_and_creates_the_run_placeholder(uri):
    w = RunWriter(uri, flush_s=0.05)
    w.add("tool_calls", tool_row("s1"))
    w.add("tool_calls", tool_row("s1"))            # a retried batch must not duplicate
    w.add("tool_calls", tool_row("s2", status="error", error_type="Timeout", error_msg="slow"))
    w.close()
    with psycopg.connect(uri) as c:
        assert c.execute("select count(*), min(tool_name) from observability.tool_calls where run_id=%s", (RUN,)).fetchone() == (2, "data.fetch")
        assert c.execute("select kind, status from observability.runs where run_id=%s", (RUN,)).fetchone() == ("prompt_run", "running")
        assert c.execute("select tool_args->>'source', rows_out from observability.tool_calls where span_id='s1'").fetchone() == ("yahoo", 8)
    assert w.dropped == 0 and w.written >= 3


def test_a_ts_upsert_after_the_engine_placeholder_fills_the_run_in_and_moves_started_at_earlier(uri):
    w = RunWriter(uri, flush_s=0.05)
    run2 = "33333333-3333-3333-3333-333333333333"
    w.add("tool_calls", tool_row("s9", run_id=run2, trace_id="u" * 32))
    w.close()
    with psycopg.connect(uri, autocommit=True) as c:
        # the statement shape the TS writer (pgStore.ts) issues for a late run upsert
        c.execute("insert into observability.runs (run_id, trace_id, kind, draft_id, status, prompt_id, started_at) values (%s, %s, 'prompt_run', 'd9', 'ok', 5, %s) "
                  "on conflict (trace_id) do update set prompt_id = coalesce(excluded.prompt_id, observability.runs.prompt_id), status = coalesce(excluded.status, observability.runs.status), "
                  "draft_id = coalesce(excluded.draft_id, observability.runs.draft_id), started_at = least(excluded.started_at, observability.runs.started_at)",
                  (run2, "u" * 32, "2020-01-01T00:00:00+00:00"))
        row = c.execute("select status, prompt_id, draft_id, started_at < now() - interval '1 year' from observability.runs where run_id=%s", (run2,)).fetchone()
        assert row == ("ok", 5, "d9", True)
        assert c.execute("select count(*) from observability.tool_calls where run_id=%s", (run2,)).fetchone()[0] == 1


def test_a_dead_database_never_raises_and_rows_are_dropped_and_counted():
    def boom():
        raise OSError("connection refused postgres://u:pw@h/db")
    w = RunWriter(None, connect=boom, flush_s=0.01, start=False)
    for i in range(5):
        w.add("tool_calls", tool_row(f"s{i}"))
    w.flush_once()
    assert w.dropped >= 5 and w._failures == 1


def test_circuit_opens_after_repeated_failures():
    calls = []

    def boom():
        calls.append(1)
        raise OSError("down")
    w = RunWriter(None, connect=boom, start=False)
    for i in range(6):
        w.add("tool_calls", tool_row(f"s{i}"))
        w.flush_once()
    assert len(calls) == 3                          # opened after the 3rd failure; later flushes do not touch the database


def test_queue_is_bounded_and_drops_oldest():
    w = RunWriter(None, queue_max=3, start=False, connect=lambda: None)
    for i in range(10):
        w.add("tool_calls", tool_row(f"s{i}"))
    assert w.dropped > 0
    assert [r["span_id"] for k, r in w._q if k == "tool_calls"][-1] == "s9"


def test_add_never_raises_on_garbage():
    w = RunWriter(None, start=False, connect=lambda: None)
    w.add("tool_calls", None)                      # type: ignore[arg-type]
    w.add("nope", {"run_id": object()})
