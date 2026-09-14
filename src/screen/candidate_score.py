"""
§3.8 v1 composite T1 candidate score (docs/forward-test-response-and-volume-plan.md).

Resolves open decision #9 (§6): ship a v1 now from parameters already computed
today, rather than wait for §3.7 items 2-3 (window-offset split, days-since-flip)
to land. Per §3.8's "scoring-architecture principle", the score is two things
kept apart, not one blended number:

  edge_score        - §3.8.1 edge-signal parameters, weighted sum, 0-100.
                       Reuses build_trades()'s own confidence formula/weights
                       so the number means the same thing for a Control trade
                       and a T1 candidate.
  guardrail_multiplier - §3.8.2 risk-guardrail parameters (risk-cap headroom,
                       liquidity multiple, market-cap band position), turned
                       into a 0-1 discount, never added into the edge score.
  candidate_score   = edge_score * guardrail_multiplier

This is read off T1 candidates (and, for comparability, Control's own trades)
in shadow mode only. Per §3.8's "Control impact: none" — nothing here touches
config/rules.yaml, run_screen(), or build_trades()'s own selection/sizing;
it is a separate, later-computed column, not a change to what gets traded.

Days-since-flip, window-offset identity and per-ticker reversal frequency
(§3.8.1's "needs §3.7's T1 instrumentation done first" bucket) are NOT
included here — that instrumentation doesn't exist yet. Signal-week pop size
stays excluded per §3.8.1's explicit flag. Weights are unvalidated until
B6's rank-IC test runs against enough graded weeks — this score is logged
for that future test, not used to select or size anything today.
"""
from __future__ import annotations

import math

from src.trade.builder import clip01, triangular_kernel

# Same shape as config/rules.yaml's trade.confidence.weights, reused so a
# Control trade's edge_score and a T1 candidate's edge_score are the same
# number for the same inputs.
DEFAULT_EDGE_WEIGHTS = {
    "rr": 0.25,
    "rsi_sweetspot": 0.15,
    "sector_rs": 0.20,
    "trend_quality": 0.15,
    "volume": 0.15,
    "liquidity": 0.10,
}

MARKET_CAP_BAND_CR = (10_000.0, 50_000.0)

# Guardrail full-credit thresholds (v1, unvalidated — see module docstring).
HEADROOM_FULL_CREDIT_PCT = 5.0       # >=5pp of risk-cap headroom -> full credit
LIQUIDITY_FULL_CREDIT_MULTIPLE = 2.0  # >=2x the liquidity floor -> full credit
BAND_POSITION_FULL_CREDIT = 0.5       # >=50% of the way from either edge to centre


def edge_score(
    rsi: float | None,
    atr: float | None,
    close: float,
    sl: float,
    volume: float | None,
    avg_vol_8w: float | None,
    rs_primary: float | None,
    target_r_multiple: float,
    rsi_band: tuple[float, float],
    weights: dict | None = None,
) -> tuple[float, float]:
    """§3.8.1 edge-signal composite, 0-100 (minus the liquidity term, added by the
    caller). Identical formula to build_trades()'s `confidence`, so the two are
    directly comparable. Returns (partial_score, liquidity_weight)."""
    w = weights or DEFAULT_EDGE_WEIGHTS
    rsi_lo, rsi_hi = rsi_band

    rr_comp = clip01(min(target_r_multiple, 3.0) / 3.0)
    rsi_comp = triangular_kernel(rsi, rsi_lo, rsi_hi)
    sector_comp = clip01((rs_primary + 0.10) / 0.20) if rs_primary is not None and not math.isnan(rs_primary) else 0.5
    trend_quality = (close - sl) / atr if atr else 0.0
    trend_comp = clip01(trend_quality / 4.0)
    vol_comp = clip01((volume / avg_vol_8w) / 2.0) if avg_vol_8w else 0.5

    score = 100 * (
        w["rr"] * rr_comp
        + w["rsi_sweetspot"] * rsi_comp
        + w["sector_rs"] * sector_comp
        + w["trend_quality"] * trend_comp
        + w["volume"] * vol_comp
    )
    return score, w["liquidity"]  # liquidity weight returned so callers can add their own liq_comp * weight


def _band_position(mktcap_cr: float, band: tuple[float, float] = MARKET_CAP_BAND_CR) -> float:
    """0 at either edge, 1 at the exact centre of the market-cap band."""
    lo, hi = band
    half = (hi - lo) / 2
    if half <= 0:
        return 1.0
    return clip01(min(mktcap_cr - lo, hi - mktcap_cr) / half)


def guardrails(r_pct_of_close: float, turnover_cr: float, mktcap_cr: float,
               risk_cap_pct: float, liquidity_floor_cr: float) -> dict:
    """§3.8.2 risk-guardrail parameters: raw values plus a multiplicative discount.
    Never blended additively into edge_score — see module docstring."""
    headroom_pct = risk_cap_pct * 100 - r_pct_of_close  # e.g. 15.0 - 13.2 = 1.8pp
    liquidity_multiple = turnover_cr / liquidity_floor_cr if liquidity_floor_cr else float("inf")
    band_position = _band_position(mktcap_cr)

    headroom_factor = clip01(headroom_pct / HEADROOM_FULL_CREDIT_PCT)
    liquidity_factor = clip01((liquidity_multiple - 1.0) / (LIQUIDITY_FULL_CREDIT_MULTIPLE - 1.0))
    band_factor = clip01(band_position / BAND_POSITION_FULL_CREDIT)

    return {
        "risk_cap_headroom_pct": round(headroom_pct, 3),
        "liquidity_multiple": round(liquidity_multiple, 3),
        "band_position": round(band_position, 3),
        "guardrail_multiplier": round(headroom_factor * liquidity_factor * band_factor, 4),
    }


def compute_candidate_score(
    *, rsi, atr, close, sl, volume, avg_vol_8w, rs_primary, turnover_cr, mktcap_cr,
    r_pct_of_close, target_r_multiple, rsi_band, risk_cap_pct, liquidity_floor_cr,
    weights: dict | None = None,
) -> dict:
    """§3.8 v1: edge_score (0-100) x guardrail_multiplier (0-1) = candidate_score.
    Returns every intermediate field so the ledger can show edge vs. guardrail
    separately, per §3.8's gate-or-discount-never-blend rule."""
    w = weights or DEFAULT_EDGE_WEIGHTS
    raw_edge, liq_weight = edge_score(
        rsi=rsi, atr=atr, close=close, sl=sl, volume=volume, avg_vol_8w=avg_vol_8w,
        rs_primary=rs_primary, target_r_multiple=target_r_multiple, rsi_band=rsi_band, weights=w,
    )
    liq_comp = clip01(turnover_cr / 50.0)
    full_edge_score = raw_edge + 100 * liq_weight * liq_comp

    g = guardrails(
        r_pct_of_close=r_pct_of_close, turnover_cr=turnover_cr, mktcap_cr=mktcap_cr,
        risk_cap_pct=risk_cap_pct, liquidity_floor_cr=liquidity_floor_cr,
    )

    return {
        "edge_score": round(full_edge_score, 1),
        **g,
        "candidate_score": round(full_edge_score * g["guardrail_multiplier"], 1),
    }
