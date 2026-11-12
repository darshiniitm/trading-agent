"""
P2 infrastructure (docs/open-decisions-implementation-plan.md): daily->weekly resample,
data segments + holdout guard, experiment registry. Hermetic.
"""
from __future__ import annotations

import pandas as pd
import pytest

from src.data import segments
from src.data.resample import compare_to_weekly, daily_to_weekly
from src.experiments import registry


def _daily(dates, opens, closes, ticker="T.NS"):
    return pd.DataFrame({"ticker": ticker, "date": pd.to_datetime(dates), "open": opens,
                         "high": [max(o, c) + 1 for o, c in zip(opens, closes)],
                         "low": [min(o, c) - 1 for o, c in zip(opens, closes)],
                         "close": closes, "volume": [100.0] * len(dates)})


def test_resample_monday_dated_ohlcv():
    d = _daily(["2026-09-07", "2026-09-08", "2026-09-11"], [10, 11, 12], [10.5, 11.5, 12.5])
    w = daily_to_weekly(d)
    assert len(w) == 1
    r = w.iloc[0]
    assert r["date"] == pd.Timestamp("2026-09-07")
    assert (r["open"], r["close"], r["high"], r["low"], r["volume"]) == (10, 12.5, 13.5, 9, 300.0)


def test_resample_monday_holiday_week_uses_first_real_session_open():
    """Mon 14 Sep 2026 was an NSE holiday: the week opens on Tuesday's open, not Friday's close."""
    d = _daily(["2026-09-11", "2026-09-15", "2026-09-18"], [100, 104, 106], [101, 105, 107])
    w = daily_to_weekly(d).set_index("date")
    assert w.loc[pd.Timestamp("2026-09-14"), "open"] == 104
    assert w.loc[pd.Timestamp("2026-09-07"), "close"] == 101


def test_compare_to_weekly_flags_mismatch():
    d = _daily(["2026-09-07", "2026-09-08"], [10, 11], [10.5, 11.5])
    good = daily_to_weekly(d)
    bad = good.assign(open=good["open"] * 1.01)
    assert compare_to_weekly(good, good)["match_rate"] == 1.0
    assert compare_to_weekly(good, bad)["match_rate"] == 0.0


def test_segments_boundaries():
    assert segments.segment_of(pd.Timestamp("2020-03-23")) == "holdout_ext"
    assert segments.segment_of(pd.Timestamp("2021-07-05")) == "dev"
    assert segments.segment_of(pd.Timestamp("2026-09-14")) == "forward"


def test_holdout_needs_explicit_flag_and_finalist(monkeypatch, tmp_path):
    monkeypatch.setattr(segments, "READS", tmp_path / "reads.csv")
    with pytest.raises(PermissionError):
        segments.assert_allowed([pd.Timestamp("2020-06-01")])
    with pytest.raises(PermissionError):   # V2 is registered but not a finalist
        segments.assert_allowed([pd.Timestamp("2020-06-01")], allow_holdout=True, experiment_id="V2")
    assert segments.assert_allowed([pd.Timestamp("2023-01-02")]) == {"dev"}


def test_holdout_is_one_pass(monkeypatch, tmp_path):
    monkeypatch.setattr(segments, "READS", tmp_path / "reads.csv")
    import src.experiments.registry as reg
    monkeypatch.setattr(reg, "get_experiment", lambda eid, path=None: {"id": eid, "finalist": True})
    segments.assert_allowed([pd.Timestamp("2020-06-01")], allow_holdout=True, experiment_id="X")
    segments.record_read("X", "holdout_ext", "2019-12-02", "2021-06-28", 83)
    with pytest.raises(PermissionError):
        segments.assert_allowed([pd.Timestamp("2020-06-01")], allow_holdout=True, experiment_id="X")


def test_registry_loads_budget_and_dependencies():
    doc = registry.load()
    ids = {e["id"] for e in doc["experiments"]}
    assert {"V2", "V3", "V4", "V7a", "V7b", "G"} <= ids
    assert "V6" not in ids
    assert sum(e["counts_toward_budget"] for e in doc["experiments"]) <= doc["budget"]
    with pytest.raises(KeyError):
        registry.get_experiment("V99")


def test_registry_edit_after_lock_refused(tmp_path):
    p = tmp_path / "exp.yaml"
    p.write_text(registry.DEFAULT_PATH.read_text())
    registry.load(p)
    p.write_text(p.read_text().replace("N in {2, 4, 8}", "N in {2, 3, 8}"))
    with pytest.raises(ValueError):
        registry.load(p)
