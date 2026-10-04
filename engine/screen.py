from __future__ import annotations

import pandas as pd

from engine.conditions.evaluate import evaluate_ticker
from engine.env import Environment
from engine.schemas import ScreenSpec
from engine.structures import applied_steps
from engine.validate_spec import validate_spec
from src.indicators.sector_rs import compute_sector_rs, flag_outperforming
from src.screen.engine import _slice_as_of


class ScreenSpecError(Exception):
    def __init__(self, errors):
        self.errors = errors
        super().__init__("; ".join(f"{e.condition_id}: {e.message}" for e in errors))


def _bars_per_week(spec: ScreenSpec) -> int:
    return 5 if spec.structure == "t1_literal" and spec.t1_window is not None else 1


def _t1_window_days(daily_panel: pd.DataFrame, as_of: pd.Timestamp, window) -> list[pd.Timestamp]:
    all_days = sorted(pd.Timestamp(d) for d in daily_panel["date"])
    in_week = [d for d in all_days if as_of <= d <= as_of + pd.Timedelta(days=6)]
    return [in_week[o] for o in window.offsets if o < len(in_week)]


def _evaluate_t1_ticker(ticker: str, daily_panel: pd.DataFrame, shares, spec: ScreenSpec,
                         as_of: pd.Timestamp):
    days = _t1_window_days(daily_panel, as_of, spec.t1_window)
    if len(days) < 2:
        return None

    event_conds = [c for c in spec.conditions if c.role == "event"]
    event_fired_on = None
    for d in days:
        r = evaluate_ticker(daily_panel, shares, event_conds, d, bars_per_week=5)
        if r is not None and all(r.passed.get(c.id, False) for c in event_conds):
            event_fired_on = d
            break
    if event_fired_on is None:
        return None

    last_day = days[-1]
    full_result = evaluate_ticker(daily_panel, shares, spec.conditions, last_day, bars_per_week=5)
    if full_result is None:
        return None
    # The event condition's own "still valid" check is re-run at window end, not just
    # whether it literally re-fires (flip_up is a one-bar event; see t1_scan.py comment).
    #
    # Deviation from the brief: evaluate_ticker() at `last_day` already scored C3 via the
    # raw flip_up flag (True only on the exact bar the flip happens) and, since flip_up is
    # almost always False by the window's last day, already appended C3 to failed_ids. The
    # brief's fixup only ever *appended* to failed_ids on a renewed failure and never
    # *removed* an earlier false-failure on a renewed pass -- so a window whose flip bar
    # wasn't literally the last day (the common case) was wrongly excluded from full_match
    # even though uptrend held through window end. Fixed by removing the id on a pass too.
    for c in event_conds:
        full_result.passed[c.id] = full_result.values[c.id]["uptrend"]
        if full_result.passed[c.id]:
            if c.id in full_result.failed_ids:
                full_result.failed_ids.remove(c.id)
        elif c.id not in full_result.failed_ids:
            full_result.failed_ids.append(c.id)
    full_result.all_passed = len(full_result.failed_ids) == 0
    return full_result


def run_screen_spec(spec: ScreenSpec, as_of: pd.Timestamp, env: Environment) -> dict:
    errors = validate_spec(spec)
    if errors:
        raise ScreenSpecError(errors)

    as_of = pd.Timestamp(as_of)
    bars_per_week = _bars_per_week(spec)
    panels = env.daily_panels if bars_per_week == 5 else env.panels

    funnel = [{"stage": "candidate_universe", "count": len(env.universe_df)}]
    candidates = []
    for _, row in env.universe_df.iterrows():
        ticker = row["ticker"]
        if bars_per_week == 5:
            panel = (env.daily_panels or {}).get(ticker)
            if panel is None or panel.empty:
                continue
            result = _evaluate_t1_ticker(ticker, panel, env.shares.get(ticker), spec, as_of)
        else:
            panel = panels.get(ticker) if panels else None
            if panel is None or panel.empty:
                continue
            result = evaluate_ticker(panel, env.shares.get(ticker), spec.conditions, as_of, bars_per_week)
        if result is None:
            continue

        stop_cond_id = spec.stop.from_ if spec.stop else None
        sl = result.values.get(stop_cond_id, {}).get("vstop_line") if stop_cond_id else None
        ep = result.last_bar["close"]  # refined with the real selection-point EP in Task 10
        r = (ep - sl) if sl is not None else None

        if result.all_passed:
            if spec.risk_cap_pct is not None and r is not None and ep and (r / ep * 100) > spec.risk_cap_pct:
                membership = "rejected_risk_cap"
            else:
                membership = "full_match"
        elif spec.near_miss is not None and len(result.failed_ids) <= spec.near_miss.max_failed:
            membership = "near_miss"
        else:
            continue

        candidates.append({
            "ticker": ticker, "name": row.get("name"), "sector": row.get("sector"),
            "membership": membership, "values": result.values, "failed_ids": result.failed_ids,
            "ep": ep, "sl": sl, "r": r,
        })

    funnel.append({"stage": "candidates", "count": len(candidates)})

    sector_view = []
    if not env.universe_df.empty and env.panels:
        sector_map = env.universe_df[["ticker", "sector"]]
        all_sliced = {t: _slice_as_of(p, as_of) for t, p in env.panels.items()}
        bench_ticker = env.rule_spec.get("sector", {}).get("benchmark_ticker", "")
        bench = env.adapter.benchmark_series(bench_ticker, env.rule_spec["data"]["history_weeks"]) if env.adapter else pd.DataFrame()
        bench_close = _slice_as_of(bench, as_of)["close"] if not bench.empty else pd.Series(dtype=float)
        lookbacks = env.rule_spec.get("sector", {}).get("rs_lookbacks_weeks", [4])
        sector_rs_df = compute_sector_rs(sector_map, all_sliced, bench_close, lookbacks)
        sector_rs_df = flag_outperforming(sector_rs_df, f"rs_{lookbacks[0]}w",
                                           env.rule_spec["sector"]["outperforming"]["rs_gt"],
                                           env.rule_spec["sector"]["outperforming"]["top_k"])
        sector_view = sector_rs_df.to_dict("records")

    return {
        "funnel": funnel,
        "applied_steps": applied_steps(spec),
        "candidates": candidates,
        "sector_view": sector_view,
    }
