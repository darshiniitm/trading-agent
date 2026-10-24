"""The app's persistence layer (watchlists, runs, entries, validations) speaks in 'candidates', 'entered /
watching / no_point_data' and graded horizon rows. This adapts a v5 program's result to exactly those shapes,
so the app's confirm / weekly screen / selection / validation flows run on v5 programs unchanged in structure."""
from __future__ import annotations

import threading
from contextlib import contextmanager
from unittest import mock

import pandas as pd

from engine.selection import SelectionPoint  # noqa: F401  (re-export for callers)
from engine.v5.data import DataContext
from engine.v5.program import IndOperand, ScreenProgram
from engine.v5.run import run_program_full, sanitize
from src.indicators.vstop_tv import compute_vstop_tv

FIRST_LOOK_WEEKS = 13
REAL_READ_WEEKS = 26
_PATCH_LOCK = threading.Lock()


class ValidationSpecError(Exception):
    pass


@contextmanager
def tv_vstop_grading():
    """grade_horizons (the Literal arm's grader) imports compute_vstop at module level; swap in the
    TradingView-exact VStop for the duration of a grading call so its trailing stop matches the screen's."""
    with _PATCH_LOCK, mock.patch("src.backtest.horizons.compute_vstop", compute_vstop_tv):
        yield


def _program(p) -> ScreenProgram:
    return p if isinstance(p, ScreenProgram) else ScreenProgram.model_validate(p)


def structure_of(program) -> str:
    p = _program(program)
    return "t1_literal" if any(s.eval and s.eval.mode == "t1_literal" for s in p.sets) else "literal"


def entry_set_id(p: ScreenProgram) -> str:
    for a in p.actions:
        if a.type == "trade_plan" and getattr(a, "set", None):
            return a.set
    return p.sets[-1].id


def _chain(p: ScreenProgram, sid: str) -> list[str]:
    by = {s.id: s for s in p.sets}
    out = []
    while sid in by:
        out.append(sid); sid = by[sid].from_
    return out


def _data_of(ctx: DataContext, t: str) -> dict | None:
    """Hover provenance for a stock's price inputs: source and as-of date (spec §10.2)."""
    r = (ctx.provenance or {}).get(t)
    return None if r is None else {"source": r.source, "as_of": str(r.as_of) if r.as_of else None, "quality": r.quality, "reason": r.reason}


def candidates_of(program, as_of, ctx: DataContext) -> dict:
    p = _program(program)
    result, run = run_program_full(p, as_of, ctx, skip_validate=True)
    sid = entry_set_id(p)
    plans = {}
    for a in result["actions"].values():
        if a["type"] == "trade_plan" and a["set"] == sid:
            plans = {x["ticker"]: x for x in a["plans"]}
            break
    chain = _chain(p, sid)
    sectors = run.universe.set_index("ticker")[["name", "sector"]].to_dict("index")

    def last_close(t):
        for tf in ("1W", "1D"):
            b = ctx.bars(t, tf, run.as_of)
            if b is not None and len(b):
                return float(b["close"].iloc[-1])
        return None

    cands = []
    for t in run.members[sid]:
        values = {}
        for key, r in run.results.get(t, {}).items():
            if r.value is not None and (key.split(":")[0] in chain or ":" not in key):
                values[key.split(":")[-1]] = r.value
        plan = plans.get(t)
        ep = plan["signal_close"] if plan and plan.get("signal_close") is not None else last_close(t)
        sl = plan["sl"] if plan else None
        cands.append({
            "ticker": t, "name": sectors[t]["name"], "sector": sectors[t]["sector"],
            "membership": "rejected_risk_cap" if plan and plan["status"] == "rejected_risk_cap" else "full_match",
            "values": values, "failed_ids": [], "ep": ep, "sl": sl, "data": _data_of(ctx, t),
            "r": (ep - sl) if ep is not None and sl is not None else None,
            "entry_price": plan["ep"] if plan and plan["status"] == "ok" else None,
            "plan_status": plan["status"] if plan else "no_trade_plan",
        })
    for n in run.near_misses.get(sid, []):
        t = n["ticker"]
        cands.append({"ticker": t, "name": sectors[t]["name"], "sector": sectors[t]["sector"], "membership": "near_miss",
                      "values": {}, "failed_ids": n["failed"], "ep": last_close(t), "sl": None, "r": None, "data": _data_of(ctx, t),
                      "entry_price": None, "plan_status": "near_miss"})
    steps = [
        {"step": "evaluate_sets", "applied": True, "reason": None},
        {"step": "trade_plan", "applied": bool(plans) or any(a.type == "trade_plan" for a in p.actions),
         "reason": None if any(a.type == "trade_plan" for a in p.actions) else "no trade plan in program"},
        {"step": "group_by_sector", "applied": any(a.type == "group_by" for a in p.actions), "reason": None},
        {"step": "validate", "applied": any(a.type == "validate" for a in p.actions), "reason": None},
    ]
    sector_view = []
    for a in result["actions"].values():
        if a["type"] == "group_by" and (a.get("highlight") or {}).get("status") == "ok":
            sector_view = a["highlight"].get("sectors", [])
    unevaluated = [{**u, "set": x} for x in chain for u in result["sets"][x].get("unevaluated", [])]
    return {"funnel": result["funnel"], "applied_steps": steps, "candidates": cands, "sector_view": sector_view,
            "run_coverage": result["run_coverage"], "unevaluated": unevaluated, "provenance": result["provenance"],
            "universe": result["universe"], "feasibility": result["feasibility"]}


def screen_legacy(program, as_of, ctx) -> dict:
    out = candidates_of(program, as_of, ctx)
    for c in out["candidates"]:
        c.pop("entry_price", None); c.pop("plan_status", None)
    return sanitize(out)


def select_legacy(program, as_of, ctx) -> dict:
    """Never fabricates a price: a full match is 'entered' only when the trade plan resolved a real entry price."""
    out = {"entered": [], "not_confirmed": [], "no_point_data": [], "watching": []}
    cand = candidates_of(program, as_of, ctx)
    out["run_coverage"], out["unevaluated"], out["provenance"], out["universe"] = (
        cand["run_coverage"], cand["unevaluated"], cand["provenance"], cand["universe"])
    for c in cand["candidates"]:
        status = c.pop("plan_status")
        if c["membership"] != "full_match":
            out["watching"].append({**c, "ref_price": c["ep"]})
        elif c["entry_price"] is not None:
            out["entered"].append(c)
        else:
            out["no_point_data"].append({**c, "reason": "selection-point price unavailable" if status != "no_trade_plan" else "program has no trade plan"})
    return sanitize(out)


def _maturity(n: int) -> str:
    return "real_read" if n >= REAL_READ_WEEKS else "first_look" if n >= FIRST_LOOK_WEEKS else "not_first_look"


def _weekly_uptrend(panel, as_of, params) -> bool:
    if panel is None or panel.empty:
        return False
    sliced = panel[panel["date"] <= pd.Timestamp(as_of)].reset_index(drop=True)
    if len(sliced) < params.get("length", 10) + 1:
        return False
    return bool(compute_vstop_tv(sliced, **params).iloc[-1]["uptrend"])


def validate_legacy(program, ctx: DataContext, picks: list[dict], as_of, graded_weeks_so_far: int,
                    horizons=(1, 2, 3)) -> dict:
    from src.backtest.horizons import grade_horizons
    p = _program(program)
    maturity = _maturity(graded_weeks_so_far)
    if maturity == "not_first_look":
        return {"graded_weeks": graded_weeks_so_far, "maturity": maturity, "rows": []}
    tp = next((a for a in p.actions if a.type == "trade_plan"), None)
    stop_id = (getattr(tp, "stop", None) or {}).get("from") if tp else None
    cond = next((c for c in p.conditions if c.id == stop_id and isinstance(c.lhs, IndOperand) and c.lhs.ind == "vstop"), None)
    if cond is None:
        raise ValidationSpecError("cannot grade horizons without a trade plan whose stop comes from a VStop condition")
    params = {"length": int(cond.lhs.params["length"]), "mult": float(cond.lhs.params["mult"]), "source": cond.lhs.params["source"]}
    as_of = pd.Timestamp(as_of)
    horizons = list(horizons)
    gradable, extra = picks, []
    if structure_of(p) == "t1_literal":
        gradable = []
        for pk in picks:
            if _weekly_uptrend((ctx.weekly_panels or {}).get(pk["ticker"]), as_of, params):
                gradable.append(pk)
            else:
                extra += [{"ticker": pk["ticker"], "signal_week_start": str(as_of.date()), "horizon_weeks": h,
                           "status": "not_gradable_weekly_downtrend", "buy_price": pk.get("entry_price")} for h in horizons]
    # entry_price is the real fill; `ep` (screen-time close) is never graded against
    normalized = [{"ticker": x["ticker"], "EP": x["entry_price"], "SL": x["sl"]} for x in gradable]
    with tv_vstop_grading():
        rows = grade_horizons(normalized, ctx.weekly_panels or {}, as_of, horizons, bench=None,
                              rule_spec={"signals": [{"id": "vstop_flip", "params": params}]}, daily_panels=ctx.daily_panels)
    return sanitize({"graded_weeks": graded_weeks_so_far, "maturity": maturity, "rows": extra + rows})
