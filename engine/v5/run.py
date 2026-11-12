from __future__ import annotations

import dataclasses

import pandas as pd

from src import telemetry
from engine.resolution.coverage import compute_coverage, is_scored
from engine.resolution.feasibility import feasibility, unfeedable_ids

from engine.v5.actions import group_by, limit, rank, trade_plan, validate
from engine.v5.data import DataContext
from engine.v5.evaluator import CondResult, ProgramError, evaluate_condition, run_sets, validate_program, cond_value
from engine.v5.program import ScreenProgram, where_leaves
from engine.v5.universe import UniverseError, approx_mcap, resolve_universe


def sanitize(x):
    """NaN/inf/numpy scalars/Timestamps -> plain JSON values (a NaN is 'could not compute', i.e. null)."""
    import math
    import numpy as np
    if isinstance(x, dict):
        return {str(k): sanitize(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [sanitize(v) for v in x]
    if isinstance(x, np.generic):
        x = x.item()
    if isinstance(x, float):
        return None if (math.isnan(x) or math.isinf(x)) else x
    if isinstance(x, pd.Timestamp):
        return str(x.date())
    return x


def _jsonable(x):
    if isinstance(x, float) and pd.isna(x):
        return None
    return x


def run_program(program: ScreenProgram | dict, as_of, ctx: DataContext, skip_validate: bool = False, full_table: bool = False) -> dict:
    return run_program_full(program, as_of, ctx, skip_validate, full_table)[0]


@telemetry.tool("screen.filter", args_of=lambda program, as_of, *a, **k: {"as_of": str(as_of)},
                rows_of=lambda out: (out[0]["universe"]["count"], sum(s["count"] for s in out[0]["sets"].values())))
def run_program_full(program: ScreenProgram | dict, as_of, ctx: DataContext, skip_validate: bool = False, full_table: bool = False):
    """(result, run): the JSON-safe result plus the internal ProgramRun (per-ticker condition results)."""
    if isinstance(program, dict):
        program = ScreenProgram.model_validate(program)
    errors = validate_program(program)
    # unresolved needs_input blocks a screen: nothing is defaulted
    errors += [{"id": n.get("path"), "message": f"unanswered: {n.get('reason', 'missing')}"} for n in program.needs_input]
    errors += [{"id": u.get("clause_id"), "message": "a clause of the prompt was not understood"} for u in program.unrecognised]
    if errors:
        raise ProgramError(errors)
    as_of = pd.Timestamp(as_of)
    try:
        universe, meta = resolve_universe(program.universe.model_dump(by_alias=True), ctx.universe_df, as_of, ctx.index_snapshot_dir,
                                      resolver=ctx.universe_resolver, mcap=(lambda: approx_mcap(ctx, as_of)), upload=ctx.upload)
    except UniverseError as exc:
        raise ProgramError([{"id": "universe", "message": str(exc)}])
    if ctx.gap_log is not None and meta.get("quality") == "approx":
        ctx.gap_log.approx_used(meta.get("index", ""), meta.get("approximation"))
    ctx = dataclasses.replace(ctx, universe_quality=meta.get("quality", "ok"), universe_reason=meta.get("reason"),
                              unfeedable=set(ctx.unfeedable) | set(unfeedable_ids(program, ctx)))
    run = run_sets(program, as_of, ctx, universe, meta)

    sets = {}
    for s in program.sets:
        leaves = list(dict.fromkeys(where_leaves(s.where)))
        members = []
        for t in run.members[s.id]:
            row = universe[universe["ticker"] == t].iloc[0]
            members.append({"ticker": t, "name": row.get("name"), "sector": row.get("sector"), "data": _data_of(ctx, t),
                            "conditions": {cid: _vals(cond_value(run, t, cid, s.id)) for cid in leaves}})
        sets[s.id] = {"label": s.label, "from": s.from_, "count": len(members), "members": members,
                      # a prompt condition the engine cannot evaluate (no data source) means no stock is FULLY qualified:
                      # the members only passed the part that could be checked (spec: never show them as complete matches)
                      **({"partial": True, "fully_qualified": 0, "not_evaluated": program.unsupported} if program.unsupported else {}),
                      "near_misses": run.near_misses.get(s.id, []), "unevaluated": _unevaluated(run, ctx, s.id, leaves)}

    actions: dict = {}
    for a in program.actions:
        d = a.model_dump()
        if a.type == "group_by": actions[a.id] = group_by(d, run, ctx, program)
        elif a.type == "rank": actions[a.id] = rank(d, run, ctx, program)
        elif a.type == "limit": actions[a.id] = limit(d, run, ctx, program, actions)
        elif a.type == "trade_plan": actions[a.id] = trade_plan(d, run, ctx, program)
        elif a.type == "validate" and not skip_validate:
            actions[a.id] = validate(d, run, ctx, program, run_program)
    out = {"program_version": 5, "as_of": str(as_of.date()), "universe": {"count": len(universe), **meta},
           "funnel": run.funnel, "sets": sets, "actions": actions,
           "run_coverage": _coverage(run, ctx, len(universe), meta), "feasibility": feasibility(program, ctx, meta),
           "provenance": _provenance(ctx, run)}
    out["run_coverage"]["scored"] = is_scored(out["run_coverage"]["status"])
    if full_table:
        out["table"] = _full_table(program, run, ctx, universe, as_of)
    result = sanitize(out)
    return result, run


def _data_of(ctx: DataContext, t: str):
    r = (ctx.provenance or {}).get(t)
    return None if r is None else {"source": r.source, "as_of": str(r.as_of) if r.as_of else None, "quality": r.quality, "reason": r.reason}


def _entry_set(run) -> str | None:
    return next((s.id for s in run.program.sets if s.from_ == "universe"), None)


def _unevaluated(run, ctx, set_id: str, leaves: list[str]) -> list[dict]:
    rows = []
    for t, o in run.outcomes.get(set_id, {}).items():
        if o["outcome"] != "unevaluated":
            continue
        u = run.universe[run.universe["ticker"] == t].iloc[0]
        rows.append({"ticker": t, "name": u.get("name"), "sector": u.get("sector"), "reasons": o["reasons"],
                     "unknown_count": o["unknown_count"], "met_count": o["met_count"],
                     "conditions": {cid: _vals(cond_value(run, t, cid, set_id)) for cid in leaves}})
    return rows


def _coverage(run, ctx, universe_size: int, meta: dict) -> dict:
    sid = _entry_set(run)
    outcomes = run.outcomes.get(sid, {}) if sid else {}
    return compute_coverage(universe_size, outcomes, run.cond_counts, meta.get("quality", "ok"), run.unfeedable)


def _provenance(ctx, run) -> dict:
    """One summary row per data type; per-symbol rows only for inputs whose quality is not ok (spec §8)."""
    rows, counts = [], {}
    for t, r in (ctx.provenance or {}).items():
        counts[r.quality] = counts.get(r.quality, 0) + 1
        if r.quality != "ok":
            rows.append({"data_type": "OHLCV", "symbol": t, "source": r.source, "as_of": str(r.as_of) if r.as_of else None,
                         "quality": r.quality, "reason": r.reason})
    um = run.universe_meta
    return {"summary": [{"data_type": "UNIVERSE", "source": um.get("data_source", um.get("source")), "as_of": um.get("as_of_data"),
                         "quality": um.get("quality", "ok"), "reason": um.get("reason")},
                        {"data_type": "OHLCV", "counts": counts}],
            "rows": rows[:2000]}


def _full_table(program: ScreenProgram, run, ctx: DataContext, universe: pd.DataFrame, as_of) -> dict:
    """Opt-in primary list: every stock in the universe with every condition's value and pass/fail (nothing
    short-circuited), plus the sets it ended up selected in. Same evaluator and same as-of slicing as the sets."""
    cids = [c.id for c in program.conditions]
    conds = {c.id: c for c in program.conditions}
    chosen = {s.id: set(run.members.get(s.id, [])) for s in program.sets}
    rows = []
    for rec in universe.to_dict("records"):
        t = rec["ticker"]
        have = run.results.get(t, {})
        res = {cid: have.get(cid) or (CondResult(None, reason="condition_unfeedable") if cid in ctx.unfeedable
                                      else evaluate_condition(conds[cid], ctx, t, as_of, rec, None)) for cid in cids}
        rows.append({"ticker": t, "name": rec.get("name"), "sector": rec.get("sector"),
                     "conditions": {cid: _vals(r) for cid, r in res.items()},
                     "met_count": sum(1 for r in res.values() if r.passed is True),
                     "unknown_count": sum(1 for r in res.values() if r.passed is None), "data": _data_of(ctx, t),
                     "selected": [sid for sid, m in chosen.items() if t in m]})
    return {"conditions": cids, "rows": rows}


def _vals(r):
    if r is None:
        return None
    d = {k: _jsonable(v) for k, v in {"passed": r.passed, "value": r.value, "event_date": r.event_date,
                                      "direction": r.direction, "stop_line": r.stop_line}.items() if v is not None}
    d["state"] = r.state                                     # 1 / 0 / "?"
    if r.reason: d["reason"] = r.reason
    if r.warnings: d["warnings"] = list(r.warnings)
    if r.input_quality != "ok": d["input_quality"] = r.input_quality
    return d
