"""
RSI band parameter-sensitivity study (design doc §9.3).

Sweeps a grid of RSI bands on a TRAIN window only (the 52 weeks before the
validation window), picks the band whose edge is robust across a plateau of
neighbours (not a lone spike -> overfit), then runs that ONE band, untouched,
on the VALIDATE window (the most recent 52 weeks -- the same window
scripts/run_backtest.py already reports on with the a-priori default [50,65]).

The validate window is never used to choose a band. If you re-run this after
looking at validate numbers and change the grid, you've broken the point of
the exercise (design doc §9's "data-snooping the confidence score" trap,
applied here to the band instead).

    python scripts/rsi_param_study.py [--limit N] [--out results/rsi_study]
"""
from __future__ import annotations

import argparse
import copy

import pandas as pd

from common import bootstrap, trading_fridays
from src.backtest.harness import portfolio_metrics, rolling_walk_forward, summarize_trades, weekly_portfolio_returns
from src.report.report import save_csvs

# Candidate bands (design doc §4.3): momentum-confirmation vs early-momentum stories,
# plus the a-priori default. Fixed BEFORE looking at any result -- this is the whole point.
CANDIDATE_BANDS = [
    (35, 50), (40, 55), (45, 60), (50, 65), (55, 70), (60, 75), (45, 65), (50, 70), (40, 60),
]


def band_rule_spec(rule_spec: dict, lo: float, hi: float) -> dict:
    spec = copy.deepcopy(rule_spec)
    for sig in spec["signals"]:
        if sig["id"] == "rsi_band":
            sig["predicate"] = f"value >= {lo} and value <= {hi}"
    return spec


def run_band(band, weeks, rule_spec, adapter, universe_df, weekly_panels, shares_map, label):
    lo, hi = band
    spec = band_rule_spec(rule_spec, lo, hi)
    print(f"  [{label}] band=[{lo},{hi}] over {len(weeks)} weeks ...")
    graded = rolling_walk_forward(weeks, spec, adapter, universe_df, weekly_panels, shares_map, progress_every=0)
    trade_summary = summarize_trades(graded)
    port_summary = portfolio_metrics(weekly_portfolio_returns(graded, calendar=weeks))
    return {
        "band_lo": lo, "band_hi": hi,
        "n_trades": trade_summary.get("n_trades", 0),
        "n_weeks_with_trades": trade_summary.get("n_weeks", 0),
        "hit_rate": trade_summary.get("hit_rate", float("nan")),
        "expectancy_pct": trade_summary.get("expectancy_pct", float("nan")),
        "mean_ret_pct": trade_summary.get("mean_ret_pct", float("nan")),
        "avg_r_multiple": trade_summary.get("avg_r_multiple", float("nan")),
        "sharpe": port_summary.get("sharpe", float("nan")),
        "max_drawdown": port_summary.get("max_drawdown", float("nan")),
    }, graded


def robustness_score(results: list[dict]) -> list[dict]:
    """Score each band by averaging its own expectancy with its immediate grid
    neighbours' expectancy -- a lone spike (good band, bad neighbours) scores low;
    a genuine plateau (good band, decent neighbours) scores high."""
    by_band = {(r["band_lo"], r["band_hi"]): r for r in results}
    ordered = sorted(by_band.keys())
    out = []
    for i, key in enumerate(ordered):
        vals = [by_band[key]["expectancy_pct"]]
        if i > 0:
            vals.append(by_band[ordered[i - 1]]["expectancy_pct"])
        if i < len(ordered) - 1:
            vals.append(by_band[ordered[i + 1]]["expectancy_pct"])
        vals = [v for v in vals if pd.notna(v)]
        score = sum(vals) / len(vals) if vals else float("nan")
        row = dict(by_band[key])
        row["robustness_score"] = score
        out.append(row)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default="results/rsi_study")
    ap.add_argument("--train-weeks", type=int, default=52)
    ap.add_argument("--validate-weeks", type=int, default=52)
    args = ap.parse_args()

    rule_spec, adapter, universe_df, weekly_panels, shares_map = bootstrap(ticker_limit=args.limit)
    fridays = trading_fridays(weekly_panels, min_history_weeks=rule_spec["data"]["min_bars_required"])
    gradeable = fridays[:-1] if len(fridays) > 1 else fridays

    validate_weeks = gradeable[-args.validate_weeks:]
    train_weeks = gradeable[-(args.validate_weeks + args.train_weeks):-args.validate_weeks]
    if not train_weeks:
        print("Not enough history for a separate train window; aborting.")
        return

    print(f"TRAIN window:    {train_weeks[0].date()} -> {train_weeks[-1].date()}  ({len(train_weeks)} weeks)")
    print(f"VALIDATE window: {validate_weeks[0].date()} -> {validate_weeks[-1].date()}  ({len(validate_weeks)} weeks)")

    # ---- sweep on TRAIN only -------------------------------------------------
    print("\n########## TRAIN SWEEP (band selection happens here, never on validate) ##########")
    train_results = []
    for band in CANDIDATE_BANDS:
        r, _ = run_band(band, train_weeks, rule_spec, adapter, universe_df, weekly_panels, shares_map, "train")
        train_results.append(r)

    train_df = pd.DataFrame(train_results).sort_values("expectancy_pct", ascending=False)
    print("\n=== Train sweep results (sorted by expectancy) ===")
    print(train_df.to_string(index=False))

    scored = robustness_score(train_results)
    scored_df = pd.DataFrame(scored).sort_values("robustness_score", ascending=False)
    print("\n=== Robustness score (band + immediate grid neighbours, avg expectancy) ===")
    print(scored_df.to_string(index=False))

    selected = scored_df.iloc[0]
    selected_band = (selected["band_lo"], selected["band_hi"])
    default_band = (50, 65)
    print(f"\n>>> Selected band from TRAIN robustness: [{selected_band[0]}, {selected_band[1]}] "
          f"(a-priori default was [{default_band[0]}, {default_band[1]}])")

    # ---- run selected band + default band on VALIDATE, untouched ------------
    print("\n########## VALIDATE (selected band run ONCE, no further tuning) ##########")
    sel_result, sel_graded = run_band(selected_band, validate_weeks, rule_spec, adapter, universe_df,
                                       weekly_panels, shares_map, "validate:selected")
    def_result, def_graded = run_band(default_band, validate_weeks, rule_spec, adapter, universe_df,
                                       weekly_panels, shares_map, "validate:default")

    compare_df = pd.DataFrame([{"which": "selected_from_train", **sel_result},
                                {"which": "a_priori_default", **def_result}])
    print("\n=== Validate comparison: train-selected band vs a-priori default ===")
    print(compare_df.to_string(index=False))

    save_csvs(
        args.out,
        train_sweep=train_df,
        train_robustness=scored_df,
        validate_comparison=compare_df,
        validate_selected_trades=sel_graded,
        validate_default_trades=def_graded,
    )

    print("\nInterpretation: if 'selected_from_train' beats 'a_priori_default' by a lot on")
    print("validate, be suspicious -- with 9 bands tested that's exactly the kind of result")
    print("multiple testing produces by chance (design doc §9, multiple-testing trap).")
    print("A modest, directionally consistent improvement is more believable than a big one.")


if __name__ == "__main__":
    main()
