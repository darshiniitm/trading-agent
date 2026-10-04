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
