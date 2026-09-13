"""
Live screen: run_screen() as of the most recent completed Friday.

    python scripts/run_screen.py [--as-of YYYY-MM-DD] [--limit N] [--out results/live]
"""
from __future__ import annotations

import argparse

import pandas as pd

from common import bootstrap, trading_fridays
from src.report.report import print_funnel, print_sector_highlights, print_trade_table, save_csvs
from src.screen.engine import run_screen
from src.trade.builder import build_trades


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--as-of", default=None, help="Signal Friday, YYYY-MM-DD (default: latest available)")
    ap.add_argument("--limit", type=int, default=None, help="Limit universe size (for a quick smoke test)")
    ap.add_argument("--out", default="results/live")
    args = ap.parse_args()

    rule_spec, adapter, universe_df, weekly_panels, shares_map = bootstrap(ticker_limit=args.limit)

    if args.as_of:
        as_of = pd.Timestamp(args.as_of)
    else:
        fridays = trading_fridays(weekly_panels, min_history_weeks=0)
        as_of = fridays[-1]

    print(f"\nRunning screen as-of {as_of.date()} ...")
    result = run_screen(as_of, rule_spec, adapter, universe_df, weekly_panels, shares_map)
    trades = build_trades(result["survivors"], rule_spec)

    print_funnel(result["funnel"], title=f"Screen funnel — as of {as_of.date()}")
    print_trade_table(trades, title=f"Live trade plan — as of {as_of.date()} (EP pending next week's open)")
    print_sector_highlights(result["sector_rs"])

    save_csvs(args.out, trades=trades, sector_rs=result["sector_rs"], funnel=result["funnel"])

    print("\nData-source caveats (open-source POC):")
    for c in adapter.caveats():
        print(f"  - {c}")


if __name__ == "__main__":
    main()
