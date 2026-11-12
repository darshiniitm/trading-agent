"""M8 engine side: gap log, nightly prefetch (idempotent), uploads, health, feasibility endpoint."""
from __future__ import annotations

import io
import zipfile
from datetime import date

import pandas as pd
import pytest

from engine.resolution.calendar import TradingCalendar
from engine.resolution.config import load_config
from engine.resolution.gaplog import GapLog
from engine.resolution.ops import data_health, run_prefetch, save_upload
from engine.resolution.universe import build_universe_resolver

TODAY = date(2026, 10, 7)          # a Wednesday
IDX = "Company Name,Industry,Symbol,Series,ISIN Code\nA,Capital Goods,AAA,EQ,i1\nB,Financial Services,BBB,EQ,i2\n"
MASTER = "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\nAAA,A Ltd, EQ,01-JAN-2000\nBBB,B Ltd, EQ,01-JAN-2000\nCCC,C Ltd, EQ,01-JAN-2000\n"


def bhav():
    csv = ("TradDt,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol\n"
           f"{TODAY},AAA,EQ,10,11,9,10.5,100\n{TODAY},BBB,EQ,20,21,19,20.5,100\n")
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z: z.writestr("x.csv", csv)
    return b.getvalue()


def fetcher(url, timeout):
    if "EQUITY_L" in url: return MASTER.encode()
    if "BhavCopy" in url: return bhav()
    if "ind_" in url: return IDX.encode()
    raise OSError("unexpected " + url)


@pytest.fixture
def cfg(tmp_path):
    c = load_config()
    c["ops"] = {**c["ops"], "meta_db": str(tmp_path / "meta.sqlite"), "equity_master_dir": str(tmp_path / "em")}
    c["universe"] = {**c["universe"], "cache_dir": str(tmp_path / "idx"), "upload_dir": str(tmp_path / "up")}
    c["ohlcv"] = {**c["ohlcv"], "cache_dir": str(tmp_path / "oh"), "bhavcopy_dir": str(tmp_path / "bh")}
    c["sector"] = {**c["sector"], "map_file": str(tmp_path / "sector.parquet")}
    c["providers"] = {**c["providers"], "retries": 0, "backoff_s": 0, "timeout_s": 2}
    return c


def test_gap_log_dedupes_within_a_run_and_aggregates(tmp_path):
    g = GapLog(tmp_path / "g.sqlite")
    row = {"data_type": "OHLCV", "symbol": "A.NS", "provider": "yahoo", "reason": "no_data", "detail": "x"}
    g.begin_run(); g(row); g(row); g({**row, "detail": "y"})
    assert g.count() == 2
    g.begin_run(); g(row)
    assert g.count() == 3 and g.failures_by_provider()[0]["n"] == 3
    g.success("yahoo", "OHLCV"); g.success("yahoo", "OHLCV")
    assert len(g.last_success()) == 1


def test_prefetch_runs_twice_without_duplicates(cfg):
    log = GapLog(cfg["ops"]["meta_db"])
    kw = dict(config=cfg, today=TODAY, fetcher=fetcher, calendar=TradingCalendar(), log=log)
    first = run_prefetch(**kw)
    assert first["steps"]["equity_master"] == 3 and first["steps"]["bhavcopy"] >= 1
    assert first["steps"]["index_snapshots"] == 9 and first["steps"]["sector_map"] == 2
    assert not any(str(v).startswith("failed") for v in first["steps"].values()), first
    from engine.resolution.ohlcv import OhlcvCache
    n = len(OhlcvCache(cfg["ohlcv"]["cache_dir"]).load("AAA.NS"))
    second = run_prefetch(**kw)
    assert second["steps"] == {**first["steps"], "bhavcopy": second["steps"]["bhavcopy"]}
    assert len(OhlcvCache(cfg["ohlcv"]["cache_dir"]).load("AAA.NS")) == n == 1
    assert len(list((__import__("pathlib").Path(cfg["universe"]["cache_dir"]) / "nifty_100").glob("*.csv"))) == 1
    assert log.count() == 0


def test_prefetch_skips_non_trading_days_unless_forced(cfg):
    sat = date(2026, 10, 10)
    out = run_prefetch(config=cfg, today=sat, fetcher=fetcher, calendar=TradingCalendar(), log=GapLog(cfg["ops"]["meta_db"]))
    assert out["skipped"] == "not a trading day" and not out["steps"]


def test_forced_provider_failure_shows_in_health(cfg):
    log = GapLog(cfg["ops"]["meta_db"])
    def broken(url, t):
        if "BhavCopy" in url: raise OSError("nse down")
        return fetcher(url, t)
    out = run_prefetch(config=cfg, today=TODAY, fetcher=broken, calendar=TradingCalendar(), log=log)
    assert out["steps"]["bhavcopy"].startswith("failed") and out["steps"]["equity_master"] == 3
    import engine.resolution.ops as ops
    ops._GAPLOG[cfg["ops"]["meta_db"]] = log
    h = data_health(None, cfg)
    assert h["gap_count"] >= 1 and h["recent_gaps"][0]["data_type"] == "bhavcopy"
    assert any(f["provider"] == "prefetch" for f in h["failures_by_provider"])
    assert {"provider": "nse_equity_master", "data_type": "MCAP"}.items() <= h["last_success"][0].items() or h["last_success"]


def test_save_upload_validates_and_feeds_tier_zero(cfg):
    p = save_upload(7, 42, "my list.csv", "symbol,sector\nZZZ,x\n", cfg)
    assert p.parent.name == "42" and p.name == "my_list.csv"
    with pytest.raises(ValueError): save_upload(7, 42, "bad.csv", "ticker\nZZZ\n", cfg)
    with pytest.raises(ValueError): save_upload("7", 42, "x.csv", "symbol\nA\n", cfg)         # numeric ids only
    r = build_universe_resolver(cfg, network=False)
    from engine.resolution.types import DataRequest, DataType
    out = r.resolve(DataRequest(DataType.UNIVERSE, TODAY, key="NIFTY 100", params={"user_id": 7, "prompt_id": 42}))
    assert out.source == "user_upload" and out.value == ["ZZZ.NS"]


def test_feasibility_endpoint_chips(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    import engine.app as app_mod
    from tests.engine.test_v5_engine import ind, prog
    from tests.engine.v5_fixtures import ctx_for, daily
    import numpy as np
    ctx = ctx_for({f"S{i}.NS": daily(np.linspace(100, 160, 80)) for i in range(5)})
    ctx.index_snapshot_dir = str(tmp_path)
    ctx.universe_resolver = build_universe_resolver(cache_dir=tmp_path, network=False)
    monkeypatch.setattr(app_mod, "context_from_env", lambda env, offline=False: ctx)
    c = TestClient(app_mod.create_app(offline=True))
    cond = {"id": "C1", "lhs": ind("sma", length=6, source="close"), "op": ">", "rhs": ind("sma", length=30, source="close")}
    r = c.post("/feasibility", json={"program": prog([cond], universe={"source": "index", "index": "NIFTY 100"}), "as_of": "2023-06-30"})
    f = r.json()["feasibility"]
    assert r.status_code == 200 and f["universe"]["status"] == "approx" and f["universe"]["can_upload"]
    assert f["universe"]["detail"] == "top 100 by mcap" and f["conditions"]["C1"]["status"] == "ready"
    ctx.shares.clear()                                       # no market-cap data either -> nothing to build a universe from
    f = c.post("/feasibility", json={"program": prog([cond], universe={"source": "index", "index": "NIFTY 100"}), "as_of": "2023-06-30"}).json()["feasibility"]
    assert f["universe"]["status"] == "unavailable" and f["universe"]["can_upload"]
    r = c.post("/feasibility", json={"program": prog([cond]), "as_of": "2023-06-30"})
    f = r.json()["feasibility"]
    assert f["universe"]["status"] == "ready" and f["conditions"]["C1"]["status"] == "ready"


def test_forward_record_marks_unscored_runs(tmp_path, monkeypatch):
    import json
    import engine.forward_record as fr
    monkeypatch.setattr(fr, "OUT_DIR", tmp_path)
    p = fr.write_record(5, pd.Timestamp("2026-10-02"), [], {"x": 1}, scored=False)
    assert json.loads(p.read_text())["scored"] is False
    assert json.loads(fr.write_record(6, pd.Timestamp("2026-10-02"), [], {"x": 1}).read_text())["scored"] is True


def test_select_carries_run_coverage_and_scored_flag():
    import numpy as np
    from engine.v5.legacy import select_legacy
    from tests.engine.test_v5_engine import ind, prog
    from tests.engine.v5_fixtures import ctx_for, daily
    ctx = ctx_for({"A.NS": daily(np.linspace(100, 160, 80)), "N.NS": daily(np.linspace(100, 160, 20))})
    cond = {"id": "C1", "lhs": ind("sma", length=6, source="close"), "op": ">", "rhs": ind("sma", length=30, source="close")}
    out = select_legacy(prog([cond]), "2023-06-30", ctx)
    assert out["run_coverage"]["status"] == "low_coverage" and out["run_coverage"]["scored"] is False
    assert [u["ticker"] for u in out["unevaluated"]] == ["N.NS"]
