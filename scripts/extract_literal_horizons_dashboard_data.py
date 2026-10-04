"""One-off: aggregate results/literal_test/replay/horizons_replay_*.jsonl (Literal's
1-/2-/3-week horizon-grading replay, src/backtest/horizons.py:grade_horizons()) into the
per-horizon/per-view headline numbers docs/dashboards/test-vs-control-ledger.html's new
step 05 shows -- mean return, hit rate, mean alpha, and both CIs
(src/backtest/stats.py:block_bootstrap_ci / nonoverlapping_sanity) side by side. Not part
of the horizon-grading feature itself (that stays read-only over already-graded rows) --
this is purely a dashboard-authoring tool, rerun by hand after `tests.track_literal
replay_horizons` whenever the dashboard needs a data refresh (same pattern as
scripts/extract_wow_dashboard_data.py). Prints the numbers; the HTML edit is manual.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]

from src.backtest.stats import block_bootstrap_ci, nonoverlapping_sanity


def main(jsonl_path: str):
    rows = [json.loads(line) for line in Path(jsonl_path).read_text().splitlines() if line.strip()]
    df = pd.DataFrame(rows)
    df = df[df["status"] == "graded"]

    per_week = (
        df.groupby(["horizon_weeks", "view", "signal_week_start"])
        .agg(mean_r=("r_Nw", "mean"), n=("r_Nw", "size"),
             winners=("r_Nw", lambda s: int((s > 0).sum())),
             mean_bench=("bench_Nw", "mean"), mean_excess=("excess_Nw", "mean"))
        .reset_index()
    )

    out = {}
    for (h, view), g in per_week.groupby(["horizon_weeks", "view"]):
        g = g.rename(columns={"mean_r": "v"}).sort_values("signal_week_start")
        n_weeks = len(g)
        n_picks = int(df[(df["horizon_weeks"] == h) & (df["view"] == view)].shape[0])
        hit_rate = round(float((g["winners"].sum() / g["n"].sum()) * 100), 1)
        mean_r = round(float(g["v"].mean()), 3)
        mean_alpha = round(float(g["mean_excess"].mean()), 3)
        mean_bench = round(float(g["mean_bench"].mean()), 3)
        block_mean, block_lo, block_hi = block_bootstrap_ci(g, "v", week_col="signal_week_start",
                                                              block_weeks=3, n_boot=5000, seed=42)
        sanity = nonoverlapping_sanity(g, "v", week_col="signal_week_start", stride_weeks=3,
                                        n_boot=5000, seed=42)
        out[f"{h}w_{view}"] = {
            "n_weeks": n_weeks, "n_picks": n_picks, "mean_return_pct": mean_r,
            "hit_rate_pct": hit_rate, "mean_benchmark_pct": mean_bench, "mean_alpha_pct": mean_alpha,
            "block_ci_lo": round(block_lo, 3), "block_ci_hi": round(block_hi, 3),
            "sanity_n_weeks": sanity["n_weeks_used"],
            "sanity_ci_lo": round(sanity["ci_low"], 3), "sanity_ci_hi": round(sanity["ci_high"], 3),
        }

    print(json.dumps(out, indent=2))
    return out


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "results" / "literal_test" / "replay" /
                                                     "horizons_replay_2024-01-01_2026-09-21.jsonl"))
