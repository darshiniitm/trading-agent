"""
Pure per-flag rule evaluators: (row: dict, ctx: dict, params: dict) -> 1 | 0 | None.

Deliberately NOT `eval()` of a free-form string (docs/feature-flag-matrix-plan.md
§3.4) — every `rule.type` in config/feature_flags.yaml maps to a named function
here. Missing an input returns None ("not evaluable"), never 0 — see G7 /
docs/feature-flag-matrix-plan.md §9.1. Downtrend rows are an explicit
exception: several rules are *defined* as 0 in a downtrend (not blank) per
§3.1's notes on A04/B05/C01.

`row` carries the fields compute_features_for_ticker() already produces, plus
whatever matrix.py has merged in (sector-RS columns, guardrail outputs from
candidate_score.guardrails()). `ctx` carries run-level constants: rsi band
bounds, Control's max_r_pct, the sector outperforming rs_gt threshold, and
the guardrail full-credit constants imported from candidate_score.py.
"""
from __future__ import annotations

import math

from src.trade.builder import triangular_kernel


def _num(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def bool_field(row: dict, ctx: dict, params: dict) -> int | None:
    v = row.get(params["field"])
    if v is None:
        return None
    return 1 if bool(v) else 0


def rsi_in_band(row: dict, ctx: dict, params: dict) -> int | None:
    rsi = _num(row.get("rsi"))
    if rsi is None:
        return None
    return 1 if ctx["rsi_lo"] <= rsi <= ctx["rsi_hi"] else 0


def rsi_above_band(row: dict, ctx: dict, params: dict) -> int | None:
    rsi = _num(row.get("rsi"))
    if rsi is None:
        return None
    return 1 if rsi > ctx["rsi_hi"] else 0


def rsi_below_band(row: dict, ctx: dict, params: dict) -> int | None:
    rsi = _num(row.get("rsi"))
    if rsi is None:
        return None
    return 1 if rsi < ctx["rsi_lo"] else 0


def risk_cap_ok(row: dict, ctx: dict, params: dict) -> int | None:
    if not row.get("uptrend"):
        return 0  # downtrend -> no valid long SL, defined as 0 (§3.1 A04 note)
    close, sl = _num(row.get("close")), _num(row.get("vstop_line"))
    if close is None or sl is None or close == 0:
        return None
    r_pct = (close - sl) / close
    return 1 if 0 < r_pct <= ctx["max_r_pct"] else 0


def sector_rs_gt(row: dict, ctx: dict, params: dict) -> int | None:
    field = f"rs_{params['lookback']}w"
    val = _num(row.get(field))
    if val is None:
        return None
    threshold = params.get("threshold", ctx.get("sector_outperforming_rs_gt", 0.0))
    return 1 if val > threshold else 0


def ratio_gte(row: dict, ctx: dict, params: dict) -> int | None:
    num, den = _num(row.get(params["num"])), _num(row.get(params["den"]))
    if num is None or den is None or den == 0:
        return None
    return 1 if (num / den) >= params["threshold"] else 0


def trend_quality_gte(row: dict, ctx: dict, params: dict) -> int | None:
    if not row.get("uptrend"):
        return 0  # downtrend -> 0 (§3.1 B05 note)
    close, sl, atr = _num(row.get("close")), _num(row.get("vstop_line")), _num(row.get("atr"))
    if close is None or sl is None or atr is None or atr == 0:
        return None
    return 1 if (close - sl) / atr >= params["threshold"] else 0


def rsi_sweetspot_gte(row: dict, ctx: dict, params: dict) -> int | None:
    rsi = _num(row.get("rsi"))
    if rsi is None:
        return None
    val = triangular_kernel(rsi, ctx["rsi_lo"], ctx["rsi_hi"])
    return 1 if val >= params["threshold"] else 0


def guardrail_gte(row: dict, ctx: dict, params: dict) -> int | None:
    if params.get("requires_uptrend") and not row.get("uptrend"):
        return 0  # downtrend -> 0 (§3.1 C01 note)
    val = _num(row.get(params["field"]))
    if val is None:
        return None
    threshold = ctx["guardrail_consts"][params["threshold_const"]]
    return 1 if val >= threshold else 0


HANDLERS = {
    "bool_field": bool_field,
    "rsi_in_band": rsi_in_band,
    "rsi_above_band": rsi_above_band,
    "rsi_below_band": rsi_below_band,
    "risk_cap_ok": risk_cap_ok,
    "sector_rs_gt": sector_rs_gt,
    "ratio_gte": ratio_gte,
    "trend_quality_gte": trend_quality_gte,
    "rsi_sweetspot_gte": rsi_sweetspot_gte,
    "guardrail_gte": guardrail_gte,
}


def evaluate_flag(flag_spec: dict, row: dict, ctx: dict) -> int | None:
    rule = flag_spec["rule"]
    handler = HANDLERS[rule["type"]]
    return handler(row, ctx, rule)
