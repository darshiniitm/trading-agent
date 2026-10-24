"""Actions over sets (plan §4 "Actions"). Nothing here invents a value: a metric, entry
point or confidence method the program didn't state is a ProgramError, a price that can't
be resolved from real bars is `no_point_data`, a benchmark that isn't loaded is reported as
unavailable — never defaulted."""
from __future__ import annotations

import pandas as pd

from engine.v5.data import DataContext
from engine.v5.evaluator import CondResult, ProgramError, ProgramRun, cond_value, run_sets
from engine.v5.program import IndOperand, ScreenProgram
from engine.v5.registry import INDICATORS


def _err(aid, msg):
    return ProgramError([{"id": aid, "message": msg}])


def _meta(run: ProgramRun, t: str) -> dict:
    row = run.universe[run.universe["ticker"] == t]
    r = row.iloc[0] if len(row) else {}
    return {"ticker": t, "name": r.get("name"), "sector": r.get("sector")}


def _clean(x):
    if isinstance(x, float) and pd.isna(x):
        return None
    return x


def _rowvals(res: CondResult | None) -> dict:
    if res is None:
        return {}
    return {k: _clean(v) for k, v in {"passed": res.passed, "value": res.value, "event_date": res.event_date,
                                      "direction": res.direction, "stop_line": res.stop_line}.items() if v is not None}


# ---------------------------------------------------------------- group_by

def _need(action, *keys):
    for k in keys:
        if action.get(k) in (None, {}):
            raise _err(action["id"], f"missing required value '{k}'")


def group_by(a: dict, run: ProgramRun, ctx: DataContext, program: ScreenProgram) -> dict:
    _need(a, "set", "key")
    if a["key"] != "sector":
        raise _err(a["id"], f"cannot group by {a['key']!r}")
    members = run.members[a["set"]]
    sec = {t: _meta(run, t)["sector"] for t in members}
    counts: dict[str, list[str]] = {}
    for t, s in sec.items():
        counts.setdefault(s if s and s != "Unknown" else "Unclassified", []).append(t)  # unclassified stocks still screen (spec §3.5)
    groups = [{"sector": s, "count": len(ts), "tickers": sorted(ts)} for s, ts in sorted(counts.items(), key=lambda kv: -len(kv[1]))]
    out = {"type": "group_by", "set": a["set"], "groups": groups, "highlight": None}
    hl = a.get("highlight") or {}
    if hl.get("metric") is None:
        out["highlight"] = {"status": "no_metric_given"}
        return out
    out["highlight"] = _highlight(a, hl, run, ctx, groups)
    return out


def _weekly_panels(run, ctx, tickers):
    return {t: b for t in tickers if (b := ctx.bars(t, "1W", run.as_of)) is not None}


def _highlight(a, hl, run, ctx, groups) -> dict:
    metric, rule = hl["metric"], hl.get("rule") or {}
    if metric in ("sector_return_vs_benchmark", "median_return_of_qualifiers") and not hl.get("lookback_weeks"):
        raise _err(a["id"], "missing required value 'highlight.lookback_weeks'")
    lb = int(hl.get("lookback_weeks") or 0)
    universe_secs = run.universe.set_index("ticker")["sector"].to_dict()
    if metric == "sector_return_vs_benchmark":
        from src.indicators.sector_rs import compute_sector_rs, flag_outperforming
        if ctx.benchmark is None or ctx.benchmark.empty:
            return {"metric": metric, "status": "benchmark_unavailable"}
        bench_close = ctx.benchmark[pd.to_datetime(ctx.benchmark["date"]) <= run.as_of]["close"].reset_index(drop=True)
        if "top_k" not in rule or "rs_gt" not in rule:
            raise _err(a["id"], "highlight rule needs both rs_gt and top_k for sector_return_vs_benchmark")
        panels = _weekly_panels(run, ctx, list(universe_secs))
        smap = run.universe[["ticker", "sector"]]
        df = compute_sector_rs(smap, panels, bench_close, [lb])
        df = flag_outperforming(df, f"rs_{lb}w", rule["rs_gt"], rule["top_k"])
        rows = [{k: _clean(v) for k, v in r.items()} for r in df.to_dict("records")]
        return {"metric": metric, "lookback_weeks": lb, "rule": rule, "status": "ok", "sectors": rows}
    if metric == "ew_sector_return_vs_universe":
        # equal-weight return of each sector's members over N daily sessions vs the equal-weight return of ALL members;
        # "Unclassified" is never highlighted. Optional top_n_per_group lists each sector's best members.
        n = hl.get("lookback_sessions")
        if not n:
            raise _err(a["id"], "missing required value 'highlight.lookback_sessions'")
        n = int(n)
        rets = {}
        for g in groups:
            for tk in g["tickers"]:
                b = ctx.bars(tk, "1D", run.as_of)
                if b is not None and len(b) > n:
                    rets[tk] = float(b["close"].iloc[-1] / b["close"].iloc[-1 - n] - 1) * 100
        bench = float(pd.Series(rets).mean()) if rets else None
        top_n = int(hl.get("top_n_per_group") or 0)
        rows = []
        for g in groups:
            rs = {tk: rets[tk] for tk in g["tickers"] if tk in rets}
            sec_ret = float(pd.Series(rs).mean()) if rs else None
            row = {"sector": g["sector"], "ew_return_pct": sec_ret, "stocks": len(rs),
                   "outperforming": bool(sec_ret is not None and bench is not None and sec_ret > bench and g["sector"] != "Unclassified")}
            if top_n:
                row["top"] = [{"ticker": tk, "return_pct": v} for tk, v in sorted(rs.items(), key=lambda kv: -kv[1])[:top_n]]
            rows.append(row)
        rows.sort(key=lambda r: (r["ew_return_pct"] is None, -(r["ew_return_pct"] or 0)))
        return {"metric": metric, "lookback_sessions": n, "benchmark_return_pct": bench, "rule": rule, "status": "ok", "sectors": rows}
    if metric == "share_of_qualifiers_vs_universe":
        base = run.members[a["set"]] if False else run.members["universe"]
        total_u, total_q = len(base), sum(g["count"] for g in groups)
        gt = rule.get("gt")
        if gt is None:
            raise _err(a["id"], "highlight rule needs 'gt' (share ratio) for share_of_qualifiers_vs_universe")
        rows = []
        for g in groups:
            u_share = sum(1 for t in base if universe_secs.get(t) == g["sector"]) / total_u if total_u else 0
            q_share = g["count"] / total_q if total_q else 0
            ratio = (q_share / u_share) if u_share else None
            rows.append({"sector": g["sector"], "qualifier_share": q_share, "universe_share": u_share,
                         "ratio": ratio, "outperforming": ratio is not None and ratio > gt})
        return {"metric": metric, "rule": rule, "status": "ok", "sectors": rows}
    if metric == "median_return_of_qualifiers":
        if "top_k" not in rule:
            raise _err(a["id"], "highlight rule needs 'top_k' for median_return_of_qualifiers")
        rows = []
        for g in groups:
            rets = []
            for t in g["tickers"]:
                b = ctx.bars(t, "1W", run.as_of)
                if b is not None and len(b) > lb:
                    rets.append(float(b["close"].iloc[-1] / b["close"].iloc[-1 - lb] - 1))
            rows.append({"sector": g["sector"], "median_return": float(pd.Series(rets).median()) if rets else None, "n": len(rets)})
        ranked = sorted([r for r in rows if r["median_return"] is not None], key=lambda r: -r["median_return"])
        top = {r["sector"] for r in ranked[: rule["top_k"]]}
        for r in rows:
            r["outperforming"] = r["sector"] in top
        return {"metric": metric, "lookback_weeks": lb, "rule": rule, "status": "ok", "sectors": rows}
    raise _err(a["id"], f"unknown outperformance metric {metric!r}")


# ---------------------------------------------------------------- rank / limit

def rank(a: dict, run: ProgramRun, ctx: DataContext, program: ScreenProgram) -> dict:
    _need(a, "set")
    keys = a.get("by") or []
    rows = []
    for t in run.members[a["set"]]:
        row = _meta(run, t)
        for k in keys:
            cid, _, attr = k["key"].partition(".")
            res = cond_value(run, t, cid, a["set"])
            row[k["key"]] = getattr(res, attr, None) if res else None
        rows.append(row)
    for k in reversed(keys):
        rows.sort(key=lambda r: (r[k["key"]] is None, r[k["key"]] or ""), reverse=False)
        if k.get("order", "asc") == "desc":
            have = [r for r in rows if r[k["key"]] is not None]
            none = [r for r in rows if r[k["key"]] is None]
            rows = sorted(have, key=lambda r: r[k["key"]], reverse=True) + none
    return {"type": "rank", "set": a["set"], "rows": rows}


def limit(a: dict, run: ProgramRun, ctx: DataContext, program: ScreenProgram, done: dict) -> dict:
    _need(a, "set", "n")
    src = next((v["rows"] for v in done.values() if v.get("type") == "rank" and v["set"] == a["set"]), None)
    rows = src if src is not None else [_meta(run, t) for t in run.members[a["set"]]]
    return {"type": "limit", "set": a["set"], "rows": rows[: int(a["n"])]}


# ---------------------------------------------------------------- trade plan

def _stop_cond(program: ScreenProgram, a: dict):
    cid = (a.get("stop") or {}).get("from")
    if not cid:
        raise _err(a["id"], "missing required value 'stop.from'")
    c = next((c for c in program.conditions if c.id == cid), None)
    if c is None or not isinstance(c.lhs, IndOperand) or not INDICATORS[c.lhs.ind].can_supply_stop:
        raise _err(a["id"], f"condition {cid!r} cannot supply a stop")
    return c


def _resolve_ep(t, entry, run, ctx, tf):
    bars = ctx.bars(t, tf, run.as_of)
    if bars is None or bars.empty:
        return None, "no_point_data"
    at = entry.get("at")
    if at == "signal_close":
        return float(bars["close"].iloc[-1]), "ok"
    if at in ("next_open", "session"):
        if ctx.weekly_panels and t in ctx.weekly_panels and tf == "1W":
            from engine.selection import SelectionPoint, resolve_ep
            sp = SelectionPoint(session_of_week=entry.get("session_of_week", 1), at=entry.get("session_at", "open"))
            return resolve_ep(t, ctx.weekly_panels, ctx.daily_panels, run.as_of, sp)
        full = ctx._full(t, tf)
        nxt = full[full["date"] > bars["date"].iloc[-1]] if full is not None else None
        return (float(nxt["open"].iloc[0]), "ok") if nxt is not None and len(nxt) else (None, "no_point_data")
    raise _err("trade_plan", f"unknown entry point {at!r}")


def forward_return(ctx: DataContext, t: str, ep: float, as_of: pd.Timestamp, h: int, tf: str = "1W"):
    """Close-to-close return from `ep` to the close of the bar h weeks after the signal bar.
    None = not yet gradable (bar not complete / not present) — never extrapolated."""
    target = pd.Timestamp(as_of) + pd.Timedelta(weeks=h)
    b = ctx.bars(t, tf, target)
    if b is None or b.empty:
        return None
    last = b.iloc[-1]
    target_monday = target.normalize() - pd.Timedelta(days=target.weekday())
    if pd.Timestamp(last["date"]).normalize() != target_monday:
        return None
    return float(last["close"] / ep - 1)


def _hit_rate(a, run, ctx, program, set_id, n) -> dict:
    hits = total = 0
    for k in range(1, n + 1):
        prev = run.as_of - pd.Timedelta(weeks=k)
        sub = run_sets(program, prev, ctx, run.universe, run.universe_meta)
        for t in sub.members.get(set_id, []):
            b = ctx.bars(t, "1W", prev)
            if b is None:
                continue
            r = forward_return(ctx, t, float(b["close"].iloc[-1]), prev, 1)
            if r is None:
                continue
            total += 1; hits += r > 0
    return {"hits": hits, "n": total, "rate_pct": round(100 * hits / total, 2) if total else None}


def _atr_trade_plan(a: dict, run: ProgramRun, ctx: DataContext) -> dict:
    """Entry at the next open, stop = EP - mult x ATR(length) read at the signal bar (SMA-seeded Wilder ATR, as on
    TradingView), target = EP + k x R. No confidence score: the prompt did not ask for one."""
    from src.indicators import tv
    spec = a["stop"]["from_atr"]
    n, mult = int(spec["length"]), float(spec["mult"])
    tf = spec.get("tf", "1D")
    k = ((a.get("target") or {}).get("r_multiple"))
    plans = []
    for t in run.members[a["set"]]:
        ep, status = _resolve_ep(t, a["entry"], run, ctx, tf)
        sb = ctx.bars(t, tf, run.as_of)
        row = {**_meta(run, t), "ep": ep, "status": status,
               "signal_close": float(sb["close"].iloc[-1]) if sb is not None and len(sb) else None}
        if ep is None or sb is None or len(sb) < n + 1:
            row["status"] = "no_point_data"; plans.append(row); continue
        atr = float(tv.atr(sb["high"], sb["low"], sb["close"], n)[-1])
        if atr != atr:
            row["status"] = "no_point_data"; plans.append(row); continue
        sl = ep - mult * atr
        r = ep - sl
        row.update(atr=atr, sl=sl, r=r, r_pct=round(r / ep * 100, 4))
        if k is not None:
            row["target"] = ep + float(k) * r
        plans.append(row)
    return {"type": "trade_plan", "set": a["set"], "entry": a["entry"], "stop_from": f"atr({n})x{mult:g}", "plans": plans}


def trade_plan(a: dict, run: ProgramRun, ctx: DataContext, program: ScreenProgram) -> dict:
    _need(a, "set", "entry")
    if (a.get("stop") or {}).get("from_atr"):
        if (a["entry"] or {}).get("at") is None:
            raise _err(a["id"], "missing required value 'entry.at'")
        return _atr_trade_plan(a, run, ctx)
    if (a["entry"] or {}).get("at") is None:
        raise _err(a["id"], "missing required value 'entry.at'")
    method = (a.get("confidence") or {}).get("method")
    if method is None:
        raise _err(a["id"], "missing required value 'confidence.method'")
    stop_c = _stop_cond(program, a)
    tf = stop_c.lhs.tf
    cap = a.get("risk_cap_pct")
    if method == "historical_hit_rate" and not a["confidence"].get("n_weeks"):
        raise _err(a["id"], "missing required value 'confidence.n_weeks'")
    hit = _hit_rate(a, run, ctx, program, a["set"], int(a["confidence"]["n_weeks"])) if method == "historical_hit_rate" else None
    all_ids = [c.id for c in program.conditions]
    rsi_c = next((c for c in program.conditions if isinstance(c.lhs, IndOperand) and c.lhs.ind == "rsi" and c.op == "between"), None)

    plans = []
    for t in run.members[a["set"]]:
        sres = cond_value(run, t, stop_c.id, a["set"])
        sl = sres.stop_line if sres else None
        ep, status = _resolve_ep(t, a["entry"], run, ctx, tf)
        sb = ctx.bars(t, tf, run.as_of)
        row = {**_meta(run, t), "ep": ep, "sl": sl, "status": status,
               "signal_close": float(sb["close"].iloc[-1]) if sb is not None and len(sb) else None}
        if ep is None or sl is None:
            row["status"] = "no_point_data" if ep is None else "no_stop"
            plans.append(row); continue
        r = ep - sl
        row["r"] = r; row["r_pct"] = round(r / ep * 100, 4)
        if cap is not None and r / ep * 100 > cap:
            row["status"] = "rejected_risk_cap"
        if method == "conditions_met_count":
            res = [run.results[t][k] for k in run.results[t] if k.split(":")[-1] in all_ids]
            row["confidence"] = {"method": method, "score": round(100 * sum(bool(x.passed) for x in res) / len(res), 2) if res else None,
                                 "met": sum(bool(x.passed) for x in res), "of": len(res)}
        elif method == "historical_hit_rate":
            row["confidence"] = {"method": method, "score": hit["rate_pct"], **hit}
        elif method == "rsi_band_and_stop_distance":
            rr = cond_value(run, t, rsi_c.id, a["set"]) if rsi_c else None
            if rr is None or rr.value is None:
                raise _err(a["id"], "rsi_band_and_stop_distance needs an RSI 'between' condition")
            lo, hi = rsi_c.value
            pos = (rr.value - lo) / (hi - lo) if hi > lo else None
            stopc = max(0.0, 1 - row["r_pct"] / 100)
            row["confidence"] = {"method": method, "band_position": pos, "stop_closeness": stopc,
                                 "score": round(100 * (pos + stopc) / 2, 2) if pos is not None else None,
                                 "formula": "mean(RSI position within band, 1 - R/EP)"}
        else:
            raise _err(a["id"], f"unknown confidence method {method!r}")
        plans.append(row)
    return {"type": "trade_plan", "set": a["set"], "entry": a["entry"], "stop_from": stop_c.id, "plans": plans}


# ---------------------------------------------------------------- validate

def validate(a: dict, run: ProgramRun, ctx: DataContext, program: ScreenProgram, run_program_fn) -> dict:
    shift = (a.get("shift") or {}).get("weeks")
    hs = a.get("horizons_w")
    if shift is None or not hs:
        raise _err(a["id"], "missing required value 'shift.weeks' / 'horizons_w'")
    prev_as_of = run.as_of + pd.Timedelta(weeks=int(shift))
    sub = run_program_fn(program, prev_as_of, ctx, skip_validate=True)
    out = {"type": "validate", "as_of_used": str(prev_as_of.date()), "horizons": {}, "trade_view": None}
    plan_actions = [v for v in sub["actions"].values() if v["type"] == "trade_plan"]
    plans = [p for pa in plan_actions for p in pa["plans"] if p.get("ep") is not None and p["status"] == "ok"]
    for h in hs:
        rows = []
        for p in plans:
            r = forward_return(ctx, p["ticker"], p["ep"], prev_as_of, int(h))
            rows.append({"ticker": p["ticker"], "ep": p["ep"], "return": r, "status": "graded" if r is not None else "pending"})
        graded = [r["return"] for r in rows if r["return"] is not None]
        s = pd.Series(graded, dtype=float)
        out["horizons"][str(h)] = {
            "n_plans": len(rows), "n_graded": len(graded), "n_pending": len(rows) - len(graded),
            "mean_return_pct": round(float(s.mean()) * 100, 4) if len(s) else None,
            "median_return_pct": round(float(s.median()) * 100, 4) if len(s) else None,
            "hit_rate_pct": round(float((s > 0).mean()) * 100, 2) if len(s) else None,
            "rows": rows,
        }
    vst = next((c for c in program.conditions if isinstance(c.lhs, IndOperand) and c.lhs.ind == "vstop"), None)
    if plans and vst is not None and ctx.weekly_panels:
        from src.backtest.horizons import grade_horizons
        picks = [{"ticker": p["ticker"], "EP": p["ep"], "SL": p["sl"]} for p in plans]
        rule_spec = {"signals": [{"id": "vstop_flip", "params": vst.lhs.params}]}
        from engine.v5.legacy import tv_vstop_grading
        with tv_vstop_grading():
            out["trade_view"] = grade_horizons(picks, ctx.weekly_panels, prev_as_of, [int(h) for h in hs], bench=None,
                                               rule_spec=rule_spec, daily_panels=ctx.daily_panels)
    return out
