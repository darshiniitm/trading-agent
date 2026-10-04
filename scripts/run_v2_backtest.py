"""
V2 dev backtest -- fixed N-week hold (config/experiments.yaml id V2).

Runs Control's own weekly selection (run_screen + build_trades, UNCHANGED) through
src/backtest/v2_horizon.py:simulate_fixed_hold for N in {2, 4, 8} over the unread part of dev
(2021-07-05 -> 2024-08-31; 2024-08 onward has already been read by four studies -- see
docs/evidence-ledger.md). Weekly bars come from tests/offline.py:env_extended() (resampled from
daily bars via src/data/resample.py -- D7-free either way, since D7 only ever affected
yfinance's own weekly bars).

V3's pullback-limit entry depends on this run picking the best N (config/experiments.yaml).

    .venv/bin/python scripts/run_v2_backtest.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.backtest.harness import bootstrap_ci
from src.backtest.v2_horizon import simulate_fixed_hold
from src.data.segments import assert_allowed, record_read
from src.experiments.registry import get_experiment
from src.screen.engine import run_screen
from src.trade.builder import build_trades
from tests.offline import env_extended

DEV_START = pd.Timestamp("2021-07-05")
DEV_END = pd.Timestamp("2024-08-31")
N_VALUES = (2, 4, 8)
COST_PCT = 0.005
OUT = Path("results/experiments")


def _fold_dates(panels: dict, start: pd.Timestamp, end: pd.Timestamp) -> list[pd.Timestamp]:
    all_dates = sorted({pd.Timestamp(d) for p in panels.values() for d in p["date"]})
    return [d for d in all_dates if start <= d <= end]


def main():
    get_experiment("V2")  # KeyError if unregistered -- fail fast rather than run silently

    rule_spec, adapter, universe_df, panels, shares = env_extended()
    fold_dates = _fold_dates(panels, DEV_START, DEV_END)
    max_n = max(N_VALUES)
    gradeable = fold_dates[:-max_n] if len(fold_dates) > max_n else []
    if not gradeable:
        print("Not enough history in this window to run any gradeable V2 fold.")
        return

    segs = assert_allowed([gradeable[0], gradeable[-1]])
    print(f"segment(s) touched: {segs}")
    print(f"\n########## V2 fixed N-week hold  ({len(gradeable)} folds: "
          f"{gradeable[0].date()} -> {gradeable[-1].date()}) ##########")

    trades_by_fold = {}
    for as_of in gradeable:
        res = run_screen(as_of, rule_spec, adapter, universe_df, panels, shares)
        trades_by_fold[as_of] = build_trades(res["survivors"], rule_spec)
    n_signal_trades = sum(len(t) for t in trades_by_fold.values())
    print(f"  Control signals in window: {n_signal_trades} across {len(gradeable)} weeks")

    OUT.mkdir(parents=True, exist_ok=True)
    results = {}
    for n in N_VALUES:
        graded_parts = [simulate_fixed_hold(trades, panels, as_of, COST_PCT, n)
                        for as_of, trades in trades_by_fold.items()]
        graded_parts = [g for g in graded_parts if not g.empty]
        graded_df = pd.concat(graded_parts, ignore_index=True) if graded_parts else pd.DataFrame()

        if graded_df.empty:
            print(f"  N={n}: no gradeable trades (not enough forward data in this window)")
            results[n] = {"n_trades": 0}
            continue

        # ret_pct/ret_pct_net are fractions (harness.py convention, e.g. simulate_week_forward);
        # "_pct" fields below are the *100 actual-percentage values, to avoid the ambiguity of
        # printing a fraction with a literal "%" suffix.
        rets = graded_df["ret_pct_net"].to_numpy()
        mean, lo, hi = bootstrap_ci(rets)
        hit_rate = float((rets > 0).mean())
        results[n] = {
            "n_trades": int(len(graded_df)), "n_weeks": int(graded_df["week_start"].nunique()),
            "hit_rate": hit_rate, "expectancy_pct": round(float(mean) * 100, 4),
            "expectancy_ci95_lo_pct": round(float(lo) * 100, 4), "expectancy_ci95_hi_pct": round(float(hi) * 100, 4),
            "avg_hold_weeks": round(float(graded_df["hold_weeks"].mean()), 2),
            "exit_reasons": graded_df["exit_reason"].value_counts().to_dict(),
        }
        print(f"  N={n:>2}: n_trades={len(graded_df):<4} hit_rate={hit_rate:.1%}  "
              f"expectancy/trade={results[n]['expectancy_pct']:.3f}% "
              f"CI95=[{results[n]['expectancy_ci95_lo_pct']:.3f}%, {results[n]['expectancy_ci95_hi_pct']:.3f}%]  "
              f"avg_hold={graded_df['hold_weeks'].mean():.2f}wk  exits={results[n]['exit_reasons']}")
        graded_df.to_csv(OUT / f"V2_N{n}_trades.csv", index=False)

    graded_ns = [n for n in N_VALUES if results[n].get("n_trades")]
    kill = bool(graded_ns) and all(results[n]["expectancy_pct"] <= 0 for n in graded_ns)
    print(f"\nKill criterion (\"no N with net expectancy per trade > 0 on dev\"): "
          f"{'TRIGGERED -- V2 dead' if kill else 'not triggered' if graded_ns else 'no data to evaluate'}")

    record_read("V2", "dev", gradeable[0], gradeable[-1], len(gradeable),
                note="V2 fixed-N-week-hold dev backtest, N in {2,4,8}, unread part of dev")

    summary = {"window": [str(gradeable[0].date()), str(gradeable[-1].date())],
               "n_folds": len(gradeable), "n_signal_trades": n_signal_trades,
               "results_by_N": results, "kill_triggered": kill}
    (OUT / "V2_summary.json").write_text(json.dumps(summary, indent=2))
    print(f"\nWritten -> {OUT / 'V2_summary.json'}")


if __name__ == "__main__":
    main()
