import psycopg
import pytest

pgserver = pytest.importorskip("pgserver")
from tests.pg_fixture import temp_pg
from db.migrate import migrate


@pytest.fixture(scope="module")
def uri():
    srv, uri = temp_pg()
    yield uri
    srv.cleanup()


def test_migrations_apply_and_are_rerunnable(uri):
    first = migrate(uri)
    assert first and first[0] == "0001_schemas"
    assert migrate(uri) == []  # idempotent
    with psycopg.connect(uri) as c:
        n = c.execute("select count(*) from information_schema.tables where table_schema in "
                      "('stock_master','market_data','forward_testing','screener_app','indicator_knowledge','prompt_history','data_pipeline_log')").fetchone()[0]
        assert n >= 30


def test_upgrade_from_old_names_keeps_data():
    srv, old = temp_pg()
    try:
        import shutil, tempfile, pathlib, db.migrate as m
        tmp = pathlib.Path(tempfile.mkdtemp())
        for f in sorted(m.MIGRATIONS.glob("000[1-7]_*.sql")):
            shutil.copy(f, tmp / f.name)
        real, m.MIGRATIONS = m.MIGRATIONS, tmp
        try:
            assert migrate(old)[-1] == "0007_views"
        finally:
            m.MIGRATIONS = real
        with psycopg.connect(old, autocommit=True) as c:
            c.execute("insert into ref.instruments (symbol) values ('X.NS')")
        assert migrate(old) == ["0008_descriptive_names"]
        with psycopg.connect(old) as c:
            assert c.execute("select count(*) from stock_master.stocks").fetchone()[0] == 1
            c.execute("select * from forward_testing.v_weekly_report limit 1")
            assert c.execute("select count(*) from data_pipeline_log.schema_migrations").fetchone()[0] == 8
    finally:
        srv.cleanup()


def test_auth_migration_adds_identity_columns_and_append_only_audit(uri):
    migrate(uri)
    with psycopg.connect(uri, autocommit=True) as c:
        cols = {r[0] for r in c.execute("select column_name from information_schema.columns "
                                        "where table_schema='screener_app' and table_name='users'")}
        assert {"auth_user_id", "email", "role", "status", "last_login_at"} <= cols
        c.execute("insert into screener_app.auth_events (event, provider) values ('login', 'google')")
        with pytest.raises(psycopg.errors.RaiseException):
            c.execute("delete from screener_app.auth_events")
        c.execute("insert into screener_app.signup_allowlist (email) values ('A@Example.com')")
        with pytest.raises(psycopg.errors.UniqueViolation):
            c.execute("insert into screener_app.signup_allowlist (email) values ('a@example.com')")
