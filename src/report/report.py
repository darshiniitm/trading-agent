"""Console + CSV reporting (design doc §13, phase 8)."""
from __future__ import annotations

from pathlib import Path

import pandas as pd


def print_funnel(funnel_df: pd.DataFrame, title: str = "Screen funnel"):
    print(f"\n=== {title} ===")
    for _, row in funnel_df.iterrows():
        print(f"  {row['stage']:<32} {row['count']}")


def print_trade_table(trades_df: pd.DataFrame, title: str = "Survivors / trade plan"):
    print(f"\n=== {title} ({len(trades_df)} trades) ===")
    if trades_df.empty:
        print("  (none)")
        return
    cols = ["ticker", "sector", "mktcap_cr", "close", "rsi", "EP", "SL", "R", "target",
            "RR", "confidence", "outperforming"]
    cols = [c for c in cols if c in trades_df.columns]
    with pd.option_context("display.width", 160, "display.max_columns", 20):
        print(trades_df[cols].sort_values("confidence", ascending=False).to_string(index=False))


def print_sector_highlights(sector_rs_df: pd.DataFrame, title: str = "Sector RS (outperforming = highlighted)"):
    print(f"\n=== {title} ===")
    if sector_rs_df.empty:
        print("  (none)")
        return
    cols = [c for c in sector_rs_df.columns if c != "n_constituents"] + ["n_constituents"]
    with pd.option_context("display.width", 160, "display.max_columns", 20):
        print(sector_rs_df.sort_values(sector_rs_df.columns[sector_rs_df.columns.str.startswith("rs_")][0],
                                        ascending=False)[cols].to_string(index=False))


def print_backtest_summary(summary: dict, title: str = "Validation summary"):
    print(f"\n=== {title} ===")
    for k, v in summary.items():
        if isinstance(v, float):
            print(f"  {k:<28} {v:.4f}")
        else:
            print(f"  {k:<28} {v}")


def save_csvs(out_dir: str, **named_dfs: pd.DataFrame):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, df in named_dfs.items():
        if df is None:
            continue
        df.to_csv(out / f"{name}.csv", index=False)
    print(f"\nSaved: {', '.join(f'{n}.csv' for n in named_dfs)} -> {out}/")
