"""
§3.8 v1 composite T1 candidate score (docs/forward-test-response-and-volume-plan.md).

Two things asserted: (1) edge_score reproduces build_trades()'s own `confidence`
exactly for the same inputs, so a Control trade and a T1 candidate are scored
on the same scale; (2) the guardrail multiplier actually discounts a candidate
sitting close to a hard limit, and leaves one with room to spare untouched —
that's the whole point of keeping §3.8.2 out of the additive blend.
"""
from __future__ import annotations

from src.screen.candidate_score import compute_candidate_score
from src.trade.builder import build_trades


RSI_BAND = (50.0, 65.0)


def _score(**overrides):
    base = dict(
        rsi=57.5, atr=5.0, close=100.0, sl=92.0, volume=1_000_000.0, avg_vol_8w=800_000.0,
        rs_primary=0.02, turnover_cr=30.0, mktcap_cr=30_000.0, r_pct_of_close=8.0,
        target_r_multiple=2.0, rsi_band=RSI_BAND, risk_cap_pct=0.15, liquidity_floor_cr=10.0,
    )
    base.update(overrides)
    return compute_candidate_score(**base)


def test_edge_score_matches_build_trades_confidence():
    import pandas as pd
    survivor = pd.DataFrame([{
        "ticker": "X.NS", "name": "X", "sector": "Test", "close": 100.0, "vstop_line": 92.0,
        "rsi": 57.5, "atr": 5.0, "volume": 1_000_000.0, "avg_vol_8w": 800_000.0,
        "median_weekly_turnover_cr": 30.0, "mktcap_cr": 30_000.0, "rs_4w": 0.02,
    }])
    rule_spec = {
        "trade": {"target_r_multiple": 2.0, "max_r_pct": 0.15,
                  "confidence": {"weights": {"rr": 0.25, "rsi_sweetspot": 0.15, "sector_rs": 0.20,
                                              "trend_quality": 0.15, "volume": 0.15, "liquidity": 0.10}}},
        "signals": [{"id": "rsi_band", "predicate": "value >= 50 and value <= 65"}],
    }
    trades = build_trades(survivor, rule_spec)
    confidence = float(trades.iloc[0]["confidence"])

    sc = _score()
    assert abs(sc["edge_score"] - confidence) < 1e-6


def test_guardrail_discounts_a_candidate_near_the_risk_cap():
    comfortable = _score(r_pct_of_close=5.0)   # 10pp of headroom below the 15% cap
    tight = _score(r_pct_of_close=14.5)        # 0.5pp of headroom
    assert comfortable["guardrail_multiplier"] == 1.0
    assert tight["guardrail_multiplier"] < 0.2
    assert tight["candidate_score"] < comfortable["candidate_score"]
    # same edge signal either way -- only the guardrail should move
    assert comfortable["edge_score"] == tight["edge_score"]


def test_guardrail_discounts_a_candidate_near_the_market_cap_band_edge():
    centred = _score(mktcap_cr=30_000.0)   # exact centre of the 10k-50k band
    at_edge = _score(mktcap_cr=49_500.0)   # 500cr from the top of the band
    assert centred["guardrail_multiplier"] == 1.0
    assert at_edge["guardrail_multiplier"] < centred["guardrail_multiplier"]
    assert at_edge["band_position"] < 0.05


def test_guardrail_discounts_thin_liquidity():
    liquid = _score(turnover_cr=30.0)   # 3x the 10cr floor
    thin = _score(turnover_cr=10.5)     # barely above the floor
    assert liquid["guardrail_multiplier"] == 1.0
    assert thin["guardrail_multiplier"] < 1.0


def test_candidate_score_is_never_negative_or_unbounded():
    for r_pct in (0.0, 7.5, 14.9, 15.0):
        sc = _score(r_pct_of_close=r_pct)
        assert 0.0 <= sc["candidate_score"] <= 100.0
        assert 0.0 <= sc["guardrail_multiplier"] <= 1.0


def test_no_risk_cap_gives_full_headroom_credit_instead_of_crashing():
    """Literal's spec (config/rules_literal.yaml, decided 26 Sep 2026) sets
    trade.max_r_pct: null -- 'a trade for every qualified stock', no risk-cap
    filter. score_row() passes that straight through as risk_cap_pct=None; there
    is then no cap to have headroom against, so guardrails() must skip that
    dimension (full credit) rather than crash on `None * 100`."""
    no_cap = _score(risk_cap_pct=None, r_pct_of_close=40.0)  # would be deep past a 15% cap
    assert no_cap["risk_cap_headroom_pct"] is None
    assert no_cap["guardrail_multiplier"] == 1.0
    capped = _score(risk_cap_pct=0.15, r_pct_of_close=14.5)  # tight against an actual cap
    assert no_cap["guardrail_multiplier"] > capped["guardrail_multiplier"]
