"""M5: market cap, sector, corporate-action chains."""
from __future__ import annotations

import json
import os
import time
from datetime import date

import pandas as pd

from engine.resolution.config import load_config
from engine.resolution.reference import (UNCLASSIFIED, annotate_corporate_actions, build_actions_resolver, build_mcap_resolver,
                                         build_sector_resolver, resolve_sectors, resolve_shares)
from engine.resolution.types import ResolvedData

D = date(2026, 10, 5)


def cfg(tmp_path):
    c = load_config()
    c["mcap"] = {**c["mcap"], "shares_cache": str(tmp_path / "shares.json")}
    c["sector"] = {**c["sector"], "map_file": str(tmp_path / "sector.parquet")}
    c["universe"] = {**c["universe"], "cache_dir": str(tmp_path / "idx")}
    c["providers"] = {**c["providers"], "retries": 0, "backoff_s": 0, "timeout_s": 2}
    return c


def age(path, days):
    t = time.time() - days * 86400
    os.utime(path, (t, t))


def test_shares_fresh_cache_is_ok(tmp_path):
    c = cfg(tmp_path); (tmp_path / "shares.json").write_text(json.dumps({"A.NS": 1e6}))
    sh, prov = resolve_shares(build_mcap_resolver(c, lambda s: 1 / 0), ["A.NS"], D)
    assert sh == {"A.NS": 1e6} and prov["A.NS"].quality == "ok"


def test_shares_computed_from_marketcap_when_no_shares_field_is_fallback(tmp_path):
    c = cfg(tmp_path)
    info = lambda s: {"marketCap": 5e9}
    sh, prov = resolve_shares(build_mcap_resolver(c, info), ["A.NS"], D, close={"A.NS": 50.0})
    assert sh["A.NS"] == 1e8 and prov["A.NS"].quality == "fallback"
    assert json.loads((tmp_path / "shares.json").read_text())["A.NS"] == 1e8          # remembered as the previous value


def test_shares_previous_value_stale_after_7_days(tmp_path):
    c = cfg(tmp_path); p = tmp_path / "shares.json"; p.write_text(json.dumps({"A.NS": 2e6})); age(p, 10)
    sh, prov = resolve_shares(build_mcap_resolver(c, lambda s: 1 / 0), ["A.NS", "Z.NS"], D)
    assert prov["A.NS"].quality == "stale" and prov["A.NS"].reason == "stale_data" and prov["Z.NS"].missing
    age(p, 3)
    assert resolve_shares(build_mcap_resolver(c, lambda s: 1 / 0), ["A.NS"], D)[1]["A.NS"].quality == "ok"


def test_sector_chain_nse_then_yahoo_mapped_then_unclassified(tmp_path):
    c = cfg(tmp_path)
    (tmp_path / "idx" / "nifty_100").mkdir(parents=True)
    (tmp_path / "idx" / "nifty_100" / "2026-10-01.csv").write_text("Company Name,Industry,Symbol\nA,Capital Goods,AAA\n")
    info = lambda s: {"sector": "Technology"} if s == "YYY.NS" else {}
    r = build_sector_resolver(c, info)
    secs, prov = resolve_sectors(r, ["AAA.NS", "YYY.NS", "ZZZ.NS"], D)
    assert secs == {"AAA.NS": "Capital Goods", "YYY.NS": "Information Technology", "ZZZ.NS": UNCLASSIFIED}
    assert prov["AAA.NS"].quality == "ok" and prov["YYY.NS"].quality == "fallback" and prov["ZZZ.NS"].missing


def test_sector_known_frame_values_count_as_nse_and_unknown_is_ignored(tmp_path):
    c = cfg(tmp_path)
    known = pd.Series({"A.NS": "Financial Services", "B.NS": "Unknown"})
    secs, _ = resolve_sectors(build_sector_resolver(c, lambda s: {}, known), ["A.NS", "B.NS"], D)
    assert secs == {"A.NS": "Financial Services", "B.NS": UNCLASSIFIED}


def panel(jump_day):
    d = pd.bdate_range("2026-09-01", periods=20)
    c = [100.0] * 20
    for i in range(d.get_loc(pd.Timestamp(jump_day)), 20): c[i] = 40.0
    return pd.DataFrame({"date": d, "close": c})


def test_unexplained_jump_is_flagged_and_matching_split_is_not(tmp_path):
    c = cfg(tmp_path)
    prov = {s: ResolvedData(None, "nse_bhavcopy", D, pd.Timestamp.now(), "fallback") for s in ("A.NS", "B.NS", "C.NS")}
    panels = {"A.NS": panel("2026-09-10"), "B.NS": panel("2026-09-10"), "C.NS": pd.DataFrame({"date": pd.bdate_range("2026-09-01", periods=5), "close": 5.0})}
    splits = lambda s: pd.Series({pd.Timestamp("2026-09-10"): 2.5}) if s == "B.NS" else pd.Series(dtype=float)
    gaps = []
    flagged = annotate_corporate_actions(panels, prov, build_actions_resolver(c, split_fetch=splits), D, c, gaps.append)
    assert flagged == ["A.NS"] and prov["A.NS"].reason == "unadjusted_prices" and prov["B.NS"].reason is None
    assert gaps[0]["reason"] == "possible_unadjusted_action"


def test_actions_unavailable_means_jumps_are_unexplained(tmp_path):
    c = cfg(tmp_path)
    prov = {"A.NS": ResolvedData(None, "yahoo", D, pd.Timestamp.now(), "ok")}
    flagged = annotate_corporate_actions({"A.NS": panel("2026-09-10")}, prov, build_actions_resolver(c, split_fetch=lambda s: 1 / 0), D, c)
    assert flagged == ["A.NS"]
