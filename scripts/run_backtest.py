"""
Validation harness runner (design doc §8):
  1. Single-week check: freeze the strategy at last Friday's close, grade on the week that followed.
  2. Rolling walk-forward over the prior N weeks (default from rule spec: 104).

    python scripts/run_backtest.py [--weeks N] [--limit N] [--out results/backtest]
"""
from __future__ import annotations

import argparse

import pandas as pd

from common import bootstrap, trading_fridays
from src.backtest.harness import (
    confidence_calibration,
    portfolio_metrics,
    rolling_walk_forward,
    rolling_walk_forward_trend_hold,
    simulate_week_forward,
    single_week_check,
    summarize_trades,
    trend_hold_return_stats,
    weekly_portfolio_returns,
)
from src.report.report import print_backtest_summary, print_funnel, print_trade_table, save_csvs
from src.trade.builder import build_trades


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weeks", type=int, default=None, help="Rolling walk-forward window (default: rule_spec.validation.walk_forward_weeks)")
    ap.add_argument("--limit", type=int, default=None, help="Limit universe size (for a quick smoke test)")
    ap.add_argument("--out", default="results/backtest")
    ap.add_argument("--trend-hold", action="store_true",
                     help="Also run the secondary trend-hold exit horizon (design doc §8.5 'B') over the same folds")
    args = ap.parse_args()

    rule_spec, adapter, universe_df, weekly_panels, shares_map = bootstrap(ticker_limit=args.limit)
    walk_forward_weeks = args.weeks or rule_spec["validation"]["walk_forward_weeks"]

    fridays = trading_fridays(weekly_panels, min_history_weeks=rule_spec["data"]["min_bars_required"])
    # need at least 1 forward week of data to grade a fold -> drop the very last Friday
    gradeable_fridays = fridays[:-1] if len(fridays) > 1 else fridays
    if not gradeable_fridays:
        print("Not enough history to run any gradeable fold.")
        return

    # ---- 1. single-week check: the most recent gradeable Friday -----------------
    last_signal_friday = gradeable_fridays[-1]
    print(f"\n########## SINGLE-WEEK CHECK  (signal Friday: {last_signal_friday.date()}) ##########")
    sw = single_week_check(last_signal_friday, rule_spec, adapter, universe_df, weekly_panels, shares_map)
    print_funnel(sw["screen"]["funnel"], title="Single-week funnel")
    print_trade_table(sw["graded"], title="Single-week graded trades (this week's actual outcome)")
    single_week_summary = summarize_trades(sw["graded"])
    print_backtest_summary(single_week_summary, title="Single-week summary")

    # ---- 2. rolling walk-forward --------------------------------------------
    fold_dates = gradeable_fridays[-walk_forward_weeks:]
    print(f"\n########## ROLLING WALK-FORWARD  ({len(fold_dates)} weeks: "
          f"{fold_dates[0].date()} -> {fold_dates[-1].date()}) ##########")
    rejections = []
    graded_all = rolling_walk_forward(fold_dates, rule_spec, adapter, universe_df, weekly_panels, shares_map,
                                      rejections_out=rejections)
    rejections_df = pd.concat(rejections, ignore_index=True) if rejections else pd.DataFrame()
    print(f"  trade-builder rejections (D5): {len(rejections_df)}"
          + (f" — by reason: {rejections_df['reason'].value_counts().to_dict()}" if not rejections_df.empty else ""))
    rw_summary = summarize_trades(graded_all)
    print_backtest_summary(rw_summary, title="Rolling walk-forward — trade-level summary")

    weekly_rets = weekly_portfolio_returns(graded_all, calendar=fold_dates)  # D2: flat weeks = 0.0
    port_summary = portfolio_metrics(weekly_rets)
    print_backtest_summary(port_summary, title="Rolling walk-forward — portfolio-level summary")

    calib = confidence_calibration(graded_all)
    print("\n=== Confidence calibration (bucketed) ===")
    if not calib.empty:
        print(calib.to_string(index=False))
    else:
        print("  (not enough graded trades to calibrate)")

    csvs_to_save = dict(
        single_week_trades=sw["graded"],
        walk_forward_trades=graded_all,
        weekly_portfolio_returns=weekly_rets,
        trade_builder_rejections=rejections_df,
        confidence_calibration=calib,
    )

    # ---- 3. secondary report: trend-hold exit horizon (design doc §8.5 "B") --
    if args.trend_hold:
        print(f"\n########## TREND-HOLD SECONDARY REPORT  (same {len(fold_dates)} folds, "
              f"trailing-VStop exit) ##########")
        th_graded = rolling_walk_forward_trend_hold(fold_dates, rule_spec, adapter, universe_df, weekly_panels, shares_map)
        th_summary = summarize_trades(th_graded)
        print_backtest_summary(th_summary, title="Trend-hold — trade-level summary")
        if not th_graded.empty:
            print(f"  avg_hold_weeks              {th_graded['hold_weeks'].mean():.2f}")
            print(f"  median_hold_weeks           {th_graded['hold_weeks'].median():.1f}")
            print(f"  avg_mae_pct                 {th_graded['mae_pct'].mean():.4f}")
            print("  exit_reason breakdown:")
            for reason, cnt in th_graded["exit_reason"].value_counts().items():
                print(f"    {reason:<20} {cnt} ({cnt / len(th_graded):.1%})")
        th_ann_stats = trend_hold_return_stats(th_graded)
        print_backtest_summary(
            th_ann_stats,
            title="Trend-hold — per-trade annualized return (NOT a portfolio Sharpe/CAGR — see harness.trend_hold_return_stats docstring)",
        )
        csvs_to_save["trend_hold_trades"] = th_graded

    save_csvs(args.out, **csvs_to_save)

    print("\nData-source caveats (open-source POC) — read before trusting these numbers:")
    for c in adapter.caveats():
        print(f"  - {c}")
    print("\nNote: no delisted/merged tickers are included -> survivorship bias -> "
          "these returns are likely biased upward (design doc §3.3, §9).")


if __name__ == "__main__":
    main()
