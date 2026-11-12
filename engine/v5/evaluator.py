"""Generic condition/set evaluator for ScreenProgram v5 (plan §4 "Evaluator").

Walks `sets` in order; each condition is evaluated at most once per (ticker, eval window)
and cached. A condition with no data (warm-up, missing history) is `passed=None` — it never
passes and is reported separately from a real failure, same as VStop/RSI during warm-up.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from engine.resolution.capabilities import required_ohlcv_fields
from engine.resolution.types import Reason, worst_quality
from engine.v5.data import CR, DataContext
from engine.v5.program import EVENT_OPS, Condition, FieldOperand, IndOperand, ScreenProgram, SetDef, where_leaves
from engine.v5.registry import INDICATORS, check_params


class ProgramError(Exception):
    def __init__(self, errors: list[dict]):
        self.errors = errors
        super().__init__("; ".join(f"{e.get('id')}: {e['message']}" for e in errors))


@dataclass
class CondResult:
    passed: bool | None
    value: Any = None
    event_date: str | None = None
    direction: str | None = None
    stop_line: float | None = None
    reason: str | None = None            # reason code when passed is None (spec §5.2)
    input_quality: str = "ok"            # worst quality among the inputs used
    warnings: tuple = ()                 # reason codes that still produce 1/0 (stale_data, approx_input, ...)

    @property
    def state(self):                     # tri-state: 1 / 0 / "?"
        return "?" if self.passed is None else (1 if self.passed else 0)


def validate_program(p: ScreenProgram) -> list[dict]:
    errs: list[dict] = []
    for c in p.conditions:
        ops = [c.lhs] + ([c.rhs] if c.rhs else [])
        for o in ops:
            if isinstance(o, IndOperand):
                ind = INDICATORS.get(o.ind)
                if ind is None:
                    errs.append({"id": c.id, "message": f"unknown indicator {o.ind!r}"}); continue
                errs += [{"id": c.id, "message": m} for m in check_params(ind, o.params)]
                if o.output and o.output not in ind.outputs:
                    errs.append({"id": c.id, "message": f"{o.ind} has no output {o.output!r}"})
            elif o.field == "traded_value_cr" and not o.params.get("window"):
                errs.append({"id": c.id, "message": "missing required param 'window'"})
        if c.op in EVENT_OPS:
            if not isinstance(c.lhs, IndOperand):
                errs.append({"id": c.id, "message": f"op {c.op!r} needs an indicator on the left"}); continue
            ind = INDICATORS.get(c.lhs.ind)
            if ind and c.op not in ind.events:
                errs.append({"id": c.id, "message": f"{c.lhs.ind} does not support {c.op!r}"})
            if c.op.startswith("cross"):
                if c.rhs is None and c.value is None:
                    errs.append({"id": c.id, "message": f"{c.op!r} needs a right-hand indicator or a level"})
                elif c.rhs is not None and c.rhs.tf != c.lhs.tf:
                    errs.append({"id": c.id, "message": "both sides of a cross must use the same timeframe"})
            if c.op == "flip" and c.dir is None:
                errs.append({"id": c.id, "message": "flip needs a direction"})
        elif c.op in ("between", "outside"):
            if not (isinstance(c.value, list) and len(c.value) == 2 and all(isinstance(x, (int, float)) for x in c.value)):
                errs.append({"id": c.id, "message": f"{c.op!r} needs a [lo, hi] value"})
        elif c.op in (">", ">=", "<", "<=") and c.value is None and c.rhs is None:
            errs.append({"id": c.id, "message": f"{c.op!r} needs a value or a right-hand indicator"})
        elif c.op in ("rising", "falling", "up_over", "down_over") and c.bars is None:
            errs.append({"id": c.id, "message": f"{c.op!r} needs bars"})
    return errs


def _series(ctx: DataContext, ticker: str, o: IndOperand, as_of, tf: str | None = None):
    ind = INDICATORS[o.ind]
    bars = ctx.bars(ticker, tf or o.tf, as_of)
    if bars is None or len(bars) < ind.min_bars(o.params):
        return None, None
    frame = ind.compute(bars, o.params)
    return frame, bars


def _window_hit(flags: pd.Series, dates: pd.Series, k: int | None):
    tail = flags.iloc[-k:] if k else flags
    hits = tail[tail.fillna(False).astype(bool)]
    return (str(pd.Timestamp(dates.loc[hits.index[-1]]).date()) if len(hits) else None)


def _eval_event(c: Condition, ctx: DataContext, ticker: str, as_of, tf=None) -> CondResult:
    frame, bars = _series(ctx, ticker, c.lhs, as_of, tf)
    if frame is None:
        return CondResult(None)
    k = c.within_bars if c.within_bars is not None else (1 if c.op == "flip" else None)
    if c.op == "flip":
        col = "flip_up" if c.dir == "long" else "flip_down"
        d = _window_hit(frame[col], bars["date"], k)
        return CondResult(d is not None, {"uptrend": bool(frame["uptrend"].iloc[-1]),
                                          "vstop_line": _f(frame["stop_line"].iloc[-1]) if "stop_line" in frame else None},
                          d, c.dir if d else None,
                          _f(frame["stop_line"].iloc[-1]) if "stop_line" in frame else None)
    lhs = frame[c.lhs.output or "value"]
    if c.rhs is None:                                   # crossing a fixed level ("RSI crosses above 30")
        rhs = pd.Series(float(c.value), index=lhs.index)
    else:
        rframe, _ = _series(ctx, ticker, c.rhs, as_of, tf)
        if rframe is None:
            return CondResult(None)
        rhs = rframe[c.rhs.output or "value"]
    if c.rhs_mult is not None:
        rhs = rhs * c.rhs_mult
    diff = lhs - rhs
    prev = diff.shift(1)
    up = (prev <= 0) & (diff > 0)
    down = (prev >= 0) & (diff < 0)
    flags = {"cross_above": up, "cross_below": down, "cross_any": up | down}[c.op]
    d = _window_hit(flags, bars["date"], k)
    direction = None
    if d is not None:
        idx = flags.iloc[-k:] if k else flags
        idx = idx[idx.fillna(False).astype(bool)].index[-1]
        direction = "up" if bool(up.loc[idx]) else "down"
    return CondResult(d is not None, {"lhs": _f(lhs.iloc[-1]), "rhs": _f(rhs.iloc[-1])}, d, direction)


def _f(x):
    return None if x is None or pd.isna(x) else float(x)


def _field_value(o: FieldOperand, ctx: DataContext, ticker: str, as_of, srow) -> Any:
    if o.field == "sector":
        return srow.get("sector")
    if o.field == "rs_rating":                       # cross-sectional: filled per run by _attach_rs_rating
        return srow.get(f"rs_rating:{int(o.params['lookback'])}")
    bars = ctx.bars(ticker, "1W", as_of) if (ctx.weekly_panels or ctx.daily_panels) else None
    ref = bars if bars is not None else ctx.bars(ticker, "1D", as_of)
    # "latest available": a week still in progress has no close yet (NaN), and NaN compares False with
    # everything — it must not silently drop the stock. Read the most recent bar that has a close.
    if ref is not None:
        ref = ref[ref["close"].notna()]
    if ref is None or ref.empty:
        return None
    last = ref.iloc[-1]
    if o.field == "price":
        return float(last["close"])
    if o.field == "volume":
        return float(last["volume"])
    if o.field == "mcap_cr":
        sh = ctx.shares.get(ticker)
        return round(float(last["close"]) * sh / CR, 4) if sh else None
    weeks = int(str(o.params["window"]).rstrip("Ww"))
    use = ref
    n = weeks if bars is not None else weeks * 5
    t = (use["close"] * use["volume"]).tail(n) / CR
    return round(float(t.median()), 4) if len(t) else None


def _compare(op: str, lhs, rhs) -> bool:
    return {">": lhs > rhs, ">=": lhs >= rhs, "<": lhs < rhs, "<=": lhs <= rhs, "==": lhs == rhs}[op]


def _evaluate_core(c: Condition, ctx: DataContext, ticker: str, as_of, srow: dict,
                   t1_days: list | None = None) -> CondResult:
    if c.op in EVENT_OPS:
        if t1_days:  # t1_literal: the event may fire on any day of the window (daily bars), then must still hold at window end
            fired = None
            for d in t1_days:
                r = _eval_event(c, ctx, ticker, d, "1D")
                if r.passed:
                    fired = r; break
            if fired is None:
                return CondResult(False if _eval_event(c, ctx, ticker, t1_days[-1], "1D").passed is not None else None)
            end = _eval_event(c, ctx, ticker, t1_days[-1], "1D")
            still = bool(end.value.get("uptrend", True)) if isinstance(end.value, dict) else True
            return CondResult(still, end.value, fired.event_date, fired.direction, end.stop_line)
        return _eval_event(c, ctx, ticker, as_of)

    if isinstance(c.lhs, FieldOperand):
        v = _field_value(c.lhs, ctx, ticker, as_of, srow)
        if v is None:
            return CondResult(None)
        return CondResult(_apply(c, v, ctx, ticker, as_of), v)

    frame, bars = _series(ctx, ticker, c.lhs, as_of)
    if frame is None:
        return CondResult(None)
    col = c.lhs.output or "value"
    s = frame[col]
    v = _f(s.iloc[-1])
    if v is None:
        return CondResult(None)
    stop = _f(frame["stop_line"].iloc[-1]) if "stop_line" in frame else None
    if c.op in ("up_over", "down_over"):                 # value now vs the value `bars` bars ago
        if len(s) <= c.bars or pd.isna(s.iloc[-1 - c.bars]):
            return CondResult(None)
        past = float(s.iloc[-1 - c.bars])
        return CondResult(bool(v > past) if c.op == "up_over" else bool(v < past), v, stop_line=stop)
    if c.op in ("rising", "falling"):
        diffs = s.diff().iloc[-c.bars:]
        ok = len(diffs) == c.bars and (diffs > 0).all() if c.op == "rising" else len(diffs) == c.bars and (diffs < 0).all()
        return CondResult(bool(ok), v, stop_line=stop)
    return CondResult(_apply(c, v, ctx, ticker, as_of), v, stop_line=stop)


def _ind_operands(c: Condition):
    return [o for o in ([c.lhs] + ([c.rhs] if c.rhs else [])) if isinstance(o, IndOperand)]


def _precheck(c: Condition, ctx: DataContext, ticker: str) -> str | None:
    """Inputs known to be missing a required field (e.g. a close-only fallback source) -> `?`, never a guess."""
    prov = (ctx.provenance or {}).get(ticker)
    fields = prov.meta.get("fields") if prov is not None else None
    if fields and required_ohlcv_fields(c) - set(fields):
        return Reason.PARTIAL_FIELDS.value
    return None


def why_unknown(c: Condition, ctx: DataContext, ticker: str, as_of, srow: dict) -> str:
    has_panel = bool((ctx.daily_panels or {}).get(ticker) is not None or (ctx.weekly_panels or {}).get(ticker) is not None)
    if isinstance(c.lhs, FieldOperand):
        if c.lhs.field == "sector" or c.lhs.field == "mcap_cr":
            return Reason.NO_DATA.value
        return Reason.NO_DATA.value if not has_panel else Reason.INSUFFICIENT_HISTORY.value
    for o in _ind_operands(c):
        bars = ctx.bars(ticker, o.tf, as_of)
        if bars is None:
            return Reason.NO_DATA.value if not has_panel else Reason.INSUFFICIENT_HISTORY.value
        if len(bars) < INDICATORS[o.ind].min_bars(o.params):
            return Reason.INSUFFICIENT_HISTORY.value
    return Reason.INSUFFICIENT_HISTORY.value


def input_quality(ctx: DataContext, ticker: str) -> tuple[str, tuple]:
    q, warns = "ok", []
    prov = (ctx.provenance or {}).get(ticker)
    if prov is not None:
        q = prov.quality
        if prov.quality == "stale":
            warns.append(Reason.STALE_DATA.value)
        if prov.reason in (Reason.PRICE_MISMATCH.value, Reason.UNADJUSTED_PRICES.value):
            warns.append(prov.reason)
    if ctx.universe_quality == "approx":
        warns.append(Reason.APPROX_INPUT.value); q = worst_quality(q, "approx")
    if ctx.universe_reason == Reason.SURVIVORSHIP_RISK.value:
        warns.append(Reason.SURVIVORSHIP_RISK.value)
    return q, tuple(dict.fromkeys(warns))


def evaluate_condition(c: Condition, ctx: DataContext, ticker: str, as_of, srow: dict,
                       t1_days: list | None = None) -> CondResult:
    pre = _precheck(c, ctx, ticker)
    r = CondResult(None, reason=pre) if pre else _evaluate_core(c, ctx, ticker, as_of, srow, t1_days)
    if r.passed is None and r.reason is None:
        r.reason = why_unknown(c, ctx, ticker, as_of, srow)
    r.input_quality, r.warnings = input_quality(ctx, ticker)
    return r


def _apply(c: Condition, v, ctx, ticker, as_of) -> bool | None:
    if c.op in ("between", "outside"):
        lo, hi = c.value
        inside = lo <= v <= hi
        return inside if c.op == "between" else not inside
    rhs = c.value
    if c.rhs is not None:
        rframe, _ = _series(ctx, ticker, c.rhs, as_of)
        if rframe is None:
            return None
        rhs = _f(rframe[c.rhs.output or "value"].iloc[-1])
        if rhs is None:
            return None
    if c.rhs_mult is not None:
        rhs = rhs * c.rhs_mult
    return bool(_compare(c.op, v, rhs))


def _eval_where(node, results):
    """Kleene three-valued logic over the where tree: True / False / None (unknown). A False beats an unknown
    (spec §5.3: "a 0 beats a ?"); a node is unknown only if no child settles it. Lazy: a settling child stops the walk,
    so cheap early conditions still short-circuit the expensive ones."""
    if isinstance(node, str):
        return results[node].passed
    if "any" in node:
        unknown = False
        for n in node["any"]:
            v = _eval_where(n, results)
            if v is True:
                return True
            unknown |= v is None
        return None if unknown else False
    kids = node["all"] if "all" in node else (node["not"] if isinstance(node.get("not"), list) else [node.get("not")])
    if "all" not in node and "not" not in node:
        raise ProgramError([{"id": None, "message": f"bad where node {node!r}"}])
    unknown = False
    for n in kids:
        v = _eval_where(n, results)
        if v is False:
            return False if "all" in node else True        # all: a 0 settles it; not(all(..)): inner False -> True
        unknown |= v is None
    if unknown:
        return None
    return True if "all" in node else False


def _prune(node, skip: set):
    """Drop unfeedable conditions from a where tree (spec §6.3: run without them, never substitute). None = nothing left."""
    if isinstance(node, str):
        return None if node in skip else node
    key = next(k for k in ("all", "any", "not") if k in node)
    kids = node[key] if isinstance(node[key], list) else [node[key]]
    kept = [k for k in (_prune(n, skip) for n in kids) if k is not None]
    if not kept:
        return None
    return {key: kept if isinstance(node[key], list) else kept[0]}


def _t1_days(ctx: DataContext, ticker: str, as_of, window) -> list:
    daily = (ctx.daily_panels or {}).get(ticker)
    if daily is None or daily.empty:
        return []
    as_of = pd.Timestamp(as_of)
    days = sorted(pd.Timestamp(d) for d in pd.to_datetime(daily["date"]) if as_of <= d <= as_of + pd.Timedelta(days=6))
    return [days[o] for o in window.offsets if o < len(days)]


@dataclass
class ProgramRun:
    program: ScreenProgram
    as_of: pd.Timestamp
    universe_meta: dict
    universe: pd.DataFrame
    members: dict[str, list[str]] = field(default_factory=dict)
    results: dict[str, dict[str, CondResult]] = field(default_factory=dict)   # ticker -> cond id -> result
    near_misses: dict[str, list[dict]] = field(default_factory=dict)
    funnel: list[dict] = field(default_factory=list)
    outcomes: dict[str, dict[str, dict]] = field(default_factory=dict)        # set id -> ticker -> {outcome, met_count, unknown_count, reasons}
    cond_counts: dict[str, list[int]] = field(default_factory=dict)           # cond id -> [evaluated, attempted]
    unfeedable: list[str] = field(default_factory=list)


def _outcome(ok, res: dict) -> dict:
    unknown = [r for r in res.values() if r.passed is None]
    return {"outcome": "qualified" if ok is True else ("rejected" if ok is False else "unevaluated"),
            "met_count": sum(1 for r in res.values() if r.passed is True), "unknown_count": len(unknown),
            "reasons": sorted({r.reason for r in unknown if r.reason}) if ok is None else []}


def _attach_rs_rating(program: ScreenProgram, ctx: DataContext, as_of, srows: dict) -> None:
    """RS rating = percentile rank (0-100, ties averaged) of the N-bar daily return among the run's universe.
    A stock with no N+1 bars of history gets no rating (condition unknown), never a guessed one."""
    for n in {int(c.lhs.params["lookback"]) for c in program.conditions
              if isinstance(c.lhs, FieldOperand) and c.lhs.field == "rs_rating"}:
        ret = {}
        for t in srows:
            b = ctx.bars(t, "1D", as_of)
            if b is not None and len(b) > n:
                ret[t] = float(b["close"].iloc[-1] / b["close"].iloc[-1 - n] - 1)
        rank = pd.Series(ret, dtype=float).rank(pct=True) * 100
        for t, v in rank.items():
            srows[t][f"rs_rating:{n}"] = round(float(v), 6)


def run_sets(program: ScreenProgram, as_of, ctx: DataContext, universe_df: pd.DataFrame, meta: dict) -> ProgramRun:
    as_of = pd.Timestamp(as_of)
    run = ProgramRun(program, as_of, meta, universe_df)
    conds = {c.id: c for c in program.conditions}
    srows = {r["ticker"]: r for r in universe_df.to_dict("records")}
    _attach_rs_rating(program, ctx, as_of, srows)
    skip = set(ctx.unfeedable or ())
    run.unfeedable = sorted(skip & set(conds))
    run.members["universe"] = list(universe_df["ticker"])
    run.funnel.append({"stage": "universe", "count": len(run.members["universe"])})

    for s in program.sets:
        where = _prune(s.where, skip)                      # unfeedable conditions are "not applied", never substituted
        leaves = list(dict.fromkeys(where_leaves(where))) if where is not None else []
        t1 = s.eval.t1_window if (s.eval and s.eval.mode == "t1_literal") else None
        out, near, oc = [], [], {}
        for t in run.members[s.from_]:
            days = _t1_days(ctx, t, as_of, t1) if t1 else None
            if t1 and (not days or len(days) < 2):
                oc[t] = {"outcome": "unevaluated", "met_count": 0, "unknown_count": 0, "reasons": [Reason.INSUFFICIENT_HISTORY.value]}
                continue
            if where is None:                              # every condition of this set is unfeedable
                oc[t] = {"outcome": "unevaluated", "met_count": 0, "unknown_count": 0, "reasons": [Reason.CONDITION_UNFEEDABLE.value]}
                continue
            cache = run.results.setdefault(t, {})
            need_all = s.near_miss is not None

            class Lazy(dict):
                # leaves are evaluated on first use, so a failing early condition short-circuits
                # the rest (cheap conditions first = fast screens); near-miss sets force every leaf.
                def __missing__(self, cid):
                    key = f"{s.id}:{cid}" if t1 else cid
                    if key not in cache:
                        cache[key] = evaluate_condition(conds[cid], ctx, t, as_of, srows[t], days)
                    self[cid] = cache[key]
                    return self[cid]
            res = Lazy()
            if need_all:
                for cid in leaves:
                    res[cid]
            ok = _eval_where(where, res)
            for cid, r in res.items():
                cnt = run.cond_counts.setdefault(cid, [0, 0])
                cnt[1] += 1
                cnt[0] += r.passed is not None
            oc[t] = _outcome(ok, res)
            if res and all(r.passed is None for r in res.values()):
                continue
            if ok is True:
                for cid in leaves:  # a member's full condition record is reported, not just the ones that short-circuited
                    res[cid]
                out.append(t)
            elif ok is False and need_all and isinstance(where, dict) and "all" in where:
                failed = [i for i in where["all"] if isinstance(i, str) and res[i].passed is False]
                if 0 < len(failed) <= s.near_miss.max_failed:
                    near.append({"ticker": t, "failed": failed})
        run.members[s.id] = out
        run.near_misses[s.id] = near
        run.outcomes[s.id] = oc
        run.funnel.append({"stage": s.id, "label": s.label, "count": len(out)})
    return run


def cond_value(run: ProgramRun, ticker: str, cid: str, set_id: str | None = None) -> CondResult | None:
    r = run.results.get(ticker, {})
    return r.get(f"{set_id}:{cid}") or r.get(cid)
