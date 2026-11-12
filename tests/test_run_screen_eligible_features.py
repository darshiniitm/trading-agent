"""T-04: run_screen(include_eligible_features=...) must not change any pre-existing
return key (G1/G2 — this is the guardrail that keeps Control byte-identical while
adding a new opt-in return value)."""
from __future__ import annotations

import pandas as pd

from src.screen.engine import run_screen
from tests.offline import all_dates, env

OFFSET = -3


def test_existing_keys_identical_flag_on_or_off():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]

    off = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    on = run_screen(as_of, rule_spec, adapter, uni, panels, shares, include_eligible_features=True)

    assert "eligible_features" not in off
    assert "eligible_features" in on

    shared_keys = set(off.keys())
    assert shared_keys <= set(on.keys())
    for k in shared_keys:
        if isinstance(off[k], pd.DataFrame):
            pd.testing.assert_frame_equal(off[k], on[k])
        elif isinstance(off[k], pd.Timestamp):
            assert off[k] == on[k]
        else:
            assert off[k] == on[k], f"key {k} differs between flag on/off"


def test_eligible_features_row_count_equals_liquidity_filter_stage():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares, include_eligible_features=True)
    funnel = dict(zip(res["funnel"]["stage"], res["funnel"]["count"]))
    assert len(res["eligible_features"]) == funnel["liquidity_filter"]


def test_eligible_features_is_superset_of_survivors():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares, include_eligible_features=True)
    survivor_tickers = set(res["survivors"]["ticker"]) if not res["survivors"].empty else set()
    eligible_tickers = set(res["eligible_features"]["ticker"])
    assert survivor_tickers <= eligible_tickers


def test_eligible_features_marks_insufficient_history_rows():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares, include_eligible_features=True)
    ef = res["eligible_features"]
    hist_rows = ef[ef["eligible_reason"] == "insufficient_history"]
    ok_rows = ef[ef["eligible_reason"].isna()]
    assert len(hist_rows) + len(ok_rows) == len(ef)
    if not ok_rows.empty:
        assert ok_rows["close"].notna().all()
