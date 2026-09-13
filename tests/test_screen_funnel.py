"""
Screen / funnel tests — test plan sections 5 and 8.

Boundary inclusivity, funnel conservation, determinism, and the design
decision that sector RS must never eliminate a stock.
"""
from __future__ import annotations

import copy

import numpy as np
import pandas as pd
import pytest

from src.screen.engine import run_screen, evaluate_predicate
from src.trade.builder import build_trades, triangular_kernel, _rsi_band_bounds
from tests.offline import env, all_dates

OFFSET = -3


# ------------------------------------------------------------ predicate layer

@pytest.mark.parametrize("rsi,expected", [
    (49.999, False), (50.0, True), (57.5, True), (65.0, True), (65.001, False),
])
def test_rsi_band_boundaries_are_inclusive(rsi, expected):
    """Spec says 50 <= value <= 65, inclusive at BOTH ends."""
    rule_spec, *_ = env()
    pred = next(s["predicate"] for s in rule_spec["signals"] if s["id"] == "rsi_band")
    assert evaluate_predicate(pred, {"value": rsi}) is expected


def test_predicate_with_none_value_is_false_not_crash():
    assert evaluate_predicate("value >= 50 and value <= 65", {"value": None}) is False


def test_rsi_band_bounds_parsed_from_spec():
    rule_spec, *_ = env()
    lo, hi = _rsi_band_bounds(rule_spec)
    assert (lo, hi) == (50.0, 65.0)


def test_triangular_kernel_peaks_at_band_centre():
    assert triangular_kernel(57.5, 50, 65) == pytest.approx(1.0)
    assert triangular_kernel(50, 50, 65) == pytest.approx(0.0)
    assert triangular_kernel(65, 50, 65) == pytest.approx(0.0)
    assert triangular_kernel(80, 50, 65) == 0.0
    assert triangular_kernel(None, 50, 65) == 0.0


def test_spec_change_alters_survivors_without_code_change():
    """The 'conditions are data, not code' claim, asserted."""
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    base = run_screen(as_of, rule_spec, adapter, uni, panels, shares)["survivors"]

    narrowed = copy.deepcopy(rule_spec)
    for s in narrowed["signals"]:
        if s["id"] == "rsi_band":
            s["predicate"] = "value >= 55 and value <= 60"
    tight = run_screen(as_of, narrowed, adapter, uni, panels, shares)["survivors"]

    assert len(tight) <= len(base), "narrowing the RSI band produced MORE survivors"
    if not tight.empty:
        assert tight["rsi"].between(55, 60).all()


# ------------------------------------------------------------------- funnel

def test_funnel_counts_are_monotonically_non_increasing():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    f = run_screen(as_of, rule_spec, adapter, uni, panels, shares)["funnel"]
    counts = f["count"].tolist()
    stages = f["stage"].tolist()
    # vstop_flip is a tally of flips among liquid names, then RSI narrows it
    assert counts[0] >= counts[1] >= counts[2], f"universe stages not shrinking: {list(zip(stages, counts))}"
    assert counts[-1] <= counts[-2], "survivors exceed flip count"


def test_survivors_are_a_subset_of_flips_and_satisfy_both_predicates():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    s = res["survivors"]
    if s.empty:
        pytest.skip("no survivors")
    assert s["flip_up"].all(), "a survivor did not have flip_up=True"
    assert s["rsi"].between(50, 65).all(), "a survivor's RSI is outside the band"
    cap = rule_spec["universe"]["market_cap_cr"]
    assert s["mktcap_cr"].between(cap["min"], cap["max"]).all()


def test_funnel_conservation_survivors_plus_drops():
    """Everything entering the signal stage is either a survivor or a logged drop."""
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    f = dict(zip(res["funnel"]["stage"], res["funnel"]["count"]))
    entered = f["liquidity_filter"]
    accounted = len(res["survivors"]) + len(res["drop_log"])
    assert entered == accounted, (
        f"{entered} stocks entered the signal stage but only {accounted} are accounted for "
        f"({len(res['survivors'])} survivors + {len(res['drop_log'])} drops) — stocks vanished"
    )


def test_every_drop_has_a_named_reason():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    for ticker, reason in res["drop_log"]:
        assert reason and isinstance(reason, str)
        assert reason.startswith("failed:") or reason == "insufficient_history"


def test_liquidity_filter_actually_filters_when_binding():
    """The configured 10cr floor is non-binding for this universe; prove the gate works."""
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    base = run_screen(as_of, rule_spec, adapter, uni, panels, shares)["funnel"]
    b = dict(zip(base["stage"], base["count"]))
    assert b["universe_market_cap_band"] == b["liquidity_filter"], (
        "expected the 10cr floor to be non-binding on this universe"
    )
    strict = copy.deepcopy(rule_spec)
    strict["universe"]["liquidity"]["min"] = 500.0     # 500 cr/week — very strict
    sf = run_screen(as_of, strict, adapter, uni, panels, shares)["funnel"]
    s = dict(zip(sf["stage"], sf["count"]))
    assert s["liquidity_filter"] < s["universe_market_cap_band"], "liquidity gate never fires"


def test_determinism_two_identical_runs_match():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    a = run_screen(as_of, rule_spec, adapter, uni, panels, shares)["survivors"]
    b = run_screen(as_of, rule_spec, adapter, uni, panels, shares)["survivors"]
    pd.testing.assert_frame_equal(a, b)


def test_sector_rs_is_soft_and_never_eliminates(monkeypatch):
    """Design decision (doc section 5): sector RS highlights, it must not filter."""
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    base = run_screen(as_of, rule_spec, adapter, uni, panels, shares)

    hostile = copy.deepcopy(rule_spec)
    hostile["sector"]["outperforming"]["top_k"] = 0     # nothing can be "outperforming"
    out = run_screen(as_of, hostile, adapter, uni, panels, shares)

    assert set(base["survivors"]["ticker"]) == set(out["survivors"]["ticker"]), (
        "changing the sector-outperformance setting changed WHICH stocks survived — "
        "sector RS has become a hard filter"
    )


def test_empty_result_is_clean_not_a_crash():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    impossible = copy.deepcopy(rule_spec)
    for s in impossible["signals"]:
        if s["id"] == "rsi_band":
            s["predicate"] = "value >= 99.9 and value <= 100"
    res = run_screen(as_of, impossible, adapter, uni, panels, shares)
    assert res["survivors"].empty
    trades = build_trades(res["survivors"], impossible)
    assert trades.empty


# ------------------------------------------------------------- trade builder

def test_trades_reject_non_positive_or_absurd_risk():
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[OFFSET]
    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    trades = build_trades(res["survivors"], rule_spec)
    if trades.empty:
        pytest.skip("no trades")
    assert (trades["R"] > 0).all(), "a trade has SL at or above entry"
    assert ((trades["R"] / trades["EP"]) <= rule_spec["trade"]["max_r_pct"]).all()
    assert (trades["SL"] < trades["EP"]).all()
    assert (trades["target"] > trades["EP"]).all()


def test_confidence_is_bounded_0_100():
    rule_spec, adapter, uni, panels, shares = env()
    for off in (-3, -30, -60):
        as_of = all_dates(panels)[off]
        res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
        trades = build_trades(res["survivors"], rule_spec)
        if trades.empty:
            continue
        assert trades["confidence"].between(0, 100).all(), "confidence escaped [0,100]"
