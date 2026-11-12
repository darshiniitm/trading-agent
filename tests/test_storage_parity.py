"""P5 parity gate: FileStore vs PostgresStore on the recorded weeks, after a backfill into a throwaway Postgres."""
import pandas as pd
import pytest

pytest.importorskip("pgserver")
from tests.pg_fixture import temp_pg
from db.migrate import migrate
from db.load import backfill
from src.storage import FileStore
from src.storage.postgres_store import PostgresStore


@pytest.fixture(scope="module")
def stores():
    srv, uri = temp_pg()
    migrate(uri)
    for step in ("reference", "forward", "literal"):
        backfill.main([step, "--url", uri])
    yield FileStore(), PostgresStore(uri)
    srv.cleanup()


@pytest.mark.parametrize("arm,week", [("control", "2026-09-07"), ("control", "2026-09-21")])
def test_candidates_and_trades_match(stores, arm, week):
    f, p = stores
    pd.testing.assert_frame_equal(f.get_candidates(arm, week), p.get_candidates(arm, week), check_dtype=False)
    ft, pt = f.get_trades(arm, week), p.get_trades(arm, week)
    assert list(ft["ticker"]) == list(pt["ticker"])
    for col in ("stop_loss", "confidence", "r_pct", "ret_pct_net_1w"):
        a, b = pd.to_numeric(ft[col]).round(3), pd.to_numeric(pt[col]).round(3)
        assert a.fillna(-999).tolist() == b.fillna(-999).tolist(), col
