"""M2 acceptance (spec §12 #1-#3): the universe chain, hermetic (no network)."""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import pytest

from engine.resolution.config import load_registry
from engine.resolution.types import DataRequest, DataType
from engine.resolution.universe import build_universe_resolver, list_snapshots

CSV = "Company Name,Industry,Symbol,Series,ISIN Code\nA,x,AAA,EQ,i1\nB,x,BBB,EQ,i2\n"
TODAY = date(2026, 10, 7)
CFG = {"providers": {"timeout_s": 2, "retries": 0, "backoff_s": 0, "niftyindices": {"enabled": True}},
       "universe": {"snapshot_tolerance_days": 183, "cache_dir": "x", "upload_dir": "x"},
       "fallback": {"allow_approx_universe": True}}


def req(as_of=date(2026, 10, 5), **params):
    return DataRequest(DataType.UNIVERSE, as_of, key="Nifty 100", params=params)


def resolver(tmp_path, fetcher=None, network=True, cfg=None, **kw):
    cfg = cfg or {**CFG, "universe": {**CFG["universe"], "upload_dir": str(tmp_path / "up")}}
    return build_universe_resolver(cfg, load_registry(), tmp_path / "idx", network, fetcher, lambda: TODAY, sleep=lambda s: None, **kw)


def snap(tmp_path, d, body=CSV):
    p = tmp_path / "idx" / "nifty_100"; p.mkdir(parents=True, exist_ok=True)
    (p / f"{d}.csv").write_text(body)


def down(url, timeout): raise OSError("niftyindices down")


def test_registry_aliases_and_urls():
    r = load_registry()
    assert r.canonical("nifty100") == "NIFTY 100" == r.canonical("N100") == r.canonical("Nifty 100")
    assert r.url("NIFTY 100").endswith("ind_nifty100list.csv") and r.canonical("bogus") is None


def test_happy_path_fetches_saves_snapshot_quality_ok(tmp_path):
    calls = []
    def ok(url, timeout): calls.append(url); return CSV.encode()
    out = resolver(tmp_path, ok).resolve(req())
    assert out.quality == "ok" and out.source == "niftyindices" and out.value == ["AAA.NS", "BBB.NS"]
    assert [d for d, _ in list_snapshots(tmp_path / "idx", "nifty_100")] == [TODAY]
    # second run: the saved snapshot (dated today) is after as_of=10-05, so live again; as_of today uses the cache
    out2 = resolver(tmp_path, down).resolve(req(as_of=TODAY))
    assert out2.quality == "ok" and out2.source == "cache:niftyindices"


def test_offline_with_no_snapshot_falls_to_approx(tmp_path):
    mcap = pd.Series({f"S{i}.NS": 1000.0 - i for i in range(150)})
    out = resolver(tmp_path, down).resolve(req(mcap=mcap))
    assert out.quality == "approx" and out.reason == "approx_input" and len(out.value) == 100
    assert out.value[0] == "S0.NS" and "niftyindices:error" in " ".join(out.chain_trace)


def test_approx_respects_skip_for_band_indices(tmp_path):
    mcap = pd.Series({f"S{i}.NS": 1000.0 - i for i in range(400)})
    r = resolver(tmp_path, down)
    out = r.resolve(DataRequest(DataType.UNIVERSE, date(2026, 10, 5), key="NIFTY MIDCAP 150", params={"mcap": mcap}))
    assert out.value[0] == "S100.NS" and len(out.value) == 150


def test_approx_disabled_means_missing(tmp_path):
    cfg = {**CFG, "fallback": {"allow_approx_universe": False}, "universe": {**CFG["universe"], "upload_dir": str(tmp_path / "up")}}
    out = resolver(tmp_path, down, cfg=cfg).resolve(req(mcap=pd.Series({"S.NS": 1.0})))
    assert out.missing


def test_older_snapshot_fallback_then_stale(tmp_path):
    snap(tmp_path, TODAY - timedelta(days=100))
    out = resolver(tmp_path, down).resolve(req(as_of=TODAY))
    assert out.quality == "fallback" and out.meta["age_days"] == 100
    (tmp_path / "idx" / "nifty_100" / f"{TODAY - timedelta(days=100)}.csv").unlink()
    snap(tmp_path, TODAY - timedelta(days=200))
    out = resolver(tmp_path, down).resolve(req(as_of=TODAY))
    assert out.quality == "stale" and out.reason == "stale_data"


def test_fresh_snapshot_skips_network(tmp_path):
    snap(tmp_path, TODAY - timedelta(days=3))
    out = resolver(tmp_path, down).resolve(req(as_of=TODAY))
    assert out.quality == "ok" and out.chain_trace == ["user_upload:unavailable:no upload context", "local_snapshot:ok"]


def test_legacy_flat_snapshot_still_read(tmp_path):
    (tmp_path / "idx").mkdir(); (tmp_path / "idx" / "nifty_100_2026-10-01.csv").write_text(CSV)
    assert resolver(tmp_path, down).resolve(req()).quality == "ok"


def test_upload_wins_over_everything(tmp_path):
    d = tmp_path / "up" / "7" / "42"; d.mkdir(parents=True); (d / "u.csv").write_text("symbol,sector\nZZZ,x\n")
    snap(tmp_path, date(2026, 10, 4))
    out = resolver(tmp_path, down).resolve(req(user_id=7, prompt_id=42))
    assert out.source == "user_upload" and out.value == ["ZZZ.NS"] and out.quality == "ok"


def test_historical_run_on_live_list_carries_survivorship_risk(tmp_path):
    out = resolver(tmp_path, lambda u, t: CSV.encode()).resolve(req(as_of=date(2025, 1, 3)))
    assert out.reason == "survivorship_risk" and out.quality == "ok"


def test_bad_csv_is_not_saved(tmp_path):
    out = resolver(tmp_path, lambda u, t: b"<html>blocked</html>").resolve(req())
    assert not list_snapshots(tmp_path / "idx", "nifty_100") and out.quality == "missing"


def test_unknown_index_is_not_fetched(tmp_path):
    out = resolver(tmp_path, down).resolve(DataRequest(DataType.UNIVERSE, date(2026, 10, 5), key="NIFTY BOGUS"))
    assert out.missing
