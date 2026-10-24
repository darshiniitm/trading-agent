import psycopg
import pytest

pgserver = pytest.importorskip("pgserver")
from tests.pg_fixture import temp_pg
from db.migrate import migrate


@pytest.fixture(scope="module")
def uri():
    """Full migration chain minus 0009_auth: that file needs the citext extension, which the embedded pgserver does not ship
    (tests/test_db_migrations.py fails on it for the same reason). 0010 does not depend on 0009."""
    import pathlib, shutil, tempfile
    import db.migrate as m
    tmp = pathlib.Path(tempfile.mkdtemp())
    for f in sorted(m.MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        if not f.name.startswith("0009_"):
            shutil.copy(f, tmp / f.name)
    srv, uri = temp_pg()
    real, m.MIGRATIONS = m.MIGRATIONS, tmp
    try:
        migrate(uri)
        yield uri
    finally:
        m.MIGRATIONS = real
        srv.cleanup()


def _run(c, trace="t1"):
    return c.execute("insert into observability.runs (trace_id, kind) values (%s, 'prompt_run') returning run_id", (trace,)).fetchone()[0]


def test_migration_is_recorded_and_rerunnable(uri):
    import db.migrate as m
    assert m.MIGRATIONS.name != "migrations"  # the fixture's trimmed copy is still active
    assert migrate(uri) == []
    with psycopg.connect(uri) as c:
        names = {r[0] for r in c.execute("select table_name from information_schema.tables where table_schema='observability'")}
        assert names == {"runs", "run_tasks", "agent_calls", "tool_calls"}
        assert c.execute("select count(*) from data_pipeline_log.schema_migrations where version like '0010%'").fetchone()[0] == 1


def test_children_cascade_with_the_run_and_dedupe_on_trace_span(uri):
    with psycopg.connect(uri, autocommit=True) as c:
        rid = _run(c, "cascade")
        ins = ("insert into observability.tool_calls (run_id, trace_id, span_id, tool_name, status, started_at) "
               "values (%s, 'cascade', 'span-1', 'screen', 'ok', now()) on conflict (trace_id, span_id) do nothing")
        c.execute(ins, (rid,))
        c.execute(ins, (rid,))  # the writer may retry a batch: must not duplicate
        assert c.execute("select count(*) from observability.tool_calls where trace_id='cascade'").fetchone()[0] == 1
        c.execute("delete from observability.runs where run_id=%s", (rid,))
        assert c.execute("select count(*) from observability.tool_calls where trace_id='cascade'").fetchone()[0] == 0


def test_constraints(uri):
    with psycopg.connect(uri, autocommit=True) as c:
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("insert into observability.runs (trace_id, kind, status) values ('bad', 'prompt_run', 'weird')")
        with pytest.raises(psycopg.errors.UniqueViolation):
            _run(c, "dup"); _run(c, "dup")
        rid = _run(c, "chk")
        with pytest.raises(psycopg.errors.CheckViolation):
            c.execute("insert into observability.run_tasks (run_id, trace_id, span_id, task_id, task_name, seq, status, started_at) "
                      "values (%s, 'chk', 's', 'x', 'n', 1, 'nope', now())", (rid,))


def test_grafana_role_is_read_only_and_cannot_login_by_default(uri):
    with psycopg.connect(uri, autocommit=True) as c:
        assert c.execute("select rolcanlogin from pg_roles where rolname='grafana_ro'").fetchone()[0] is False
        c.execute("set role grafana_ro")
        assert c.execute("select count(*) from observability.runs").fetchone()[0] >= 0
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("insert into observability.runs (trace_id, kind) values ('x', 'prompt_run')")
        c.execute("reset role")
        c.execute("create table observability.later (a int)")  # default privileges cover future tables
        c.execute("set role grafana_ro")
        c.execute("select * from observability.later")
        c.execute("reset role")
        c.execute("drop table observability.later")
