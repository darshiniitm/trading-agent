"""
V3 (pullback limit entry) / V4 (same-week confirmation) dev backtest (config/experiments.yaml).

Both re-time the entry for tickers that are ALREADY Control's own weekly survivors (run_screen +
build_trades, unchanged selection) -- neither adds a ticker the weekly funnel didn't pick. Both
are graded at two horizons: holding week 1 (Control's own horizon) and holding week N* = 8 (the
best N from scripts/run_v2_backtest.py's dev run). Same window as V2: 2021-07-05 -> 2024-07-01
(unread part of dev at the time V2 ran -- see docs/evidence-ledger.md).

    .venv/bin/python scripts/run_v3_v4_backtest.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.backtest.daily_exit import horizon_end_date, simulate_daily_exit
from src.backtest.entry import pullback_limit_fill, same_week_entry
from src.backtest.harness import bootstrap_ci, simulate_week_forward
from src.data.segments import assert_allowed, record_read
from src.experiments.registry import get_experiment
from src.screen.engine import run_screen
from src.trade.builder import build_trades
from tests.offline import env_extended

DEV_START = pd.Timestamp("2021-07-05")
DEV_END = pd.Timestamp("2024-07-01")  # same window V2 graded (leaves room for the N*=8 horizon)
N_STAR = 8  # best N from run_v2_backtest.py's dev run (2026-09-16)
COST_PCT = 0.005
OUT = Path("results/experiments")


def _fold_dates(panels: dict, start: pd.Timestamp, end: pd.Timestamp) -> list[pd.Timestamp]:
    all_dates = sorted({pd.Timestamp(d) for p in panels.values() for d in p["date"]})
    return [d for d in all_dates if start <= d <= end]


def _summarize(rows: list[dict], label: str) -> tuple[dict, pd.DataFrame]:
    if not rows:
        return {"label": label, "n_trades": 0}, pd.DataFrame()
    df = pd.DataFrame(rows)
    rets = df["ret_pct_net"].to_numpy()
    mean, lo, hi = bootstrap_ci(rets)
    s = {
        "label": label, "n_trades": int(len(df)), "hit_rate": float((rets > 0).mean()),
        "expectancy_pct": round(float(mean) * 100, 4),
        "expectancy_ci95_lo_pct": round(float(lo) * 100, 4), "expectancy_ci95_hi_pct": round(float(hi) * 100, 4),
        "exit_reasons": df["exit_reason"].value_counts().to_dict(),
    }
    # Paired vs. Control's own 1-week grade on the SAME signals (kill criteria compare "vs
    # baseline", not vs. an absolute zero -- Control's own baseline over this window is
    # strongly negative, per the 104-week walk-forward, so a positive-vs-zero result can still
    # be a positive-vs-baseline result even more decisively).
    paired = df.dropna(subset=["control_ret_pct_net"]) if "control_ret_pct_net" in df.columns else df.iloc[0:0]
    if not paired.empty:
        diff = (paired["ret_pct_net"] - paired["control_ret_pct_net"]).to_numpy()
        d_mean, d_lo, d_hi = bootstrap_ci(diff)
        s["n_paired_vs_control"] = int(len(paired))
        s["vs_control_pct"] = round(float(d_mean) * 100, 4)
        s["vs_control_ci95_lo_pct"] = round(float(d_lo) * 100, 4)
        s["vs_control_ci95_hi_pct"] = round(float(d_hi) * 100, 4)
    return s, df


def main():
    get_experiment("V3")
    get_experiment("V4")

    rule_spec, adapter, universe_df, panels, shares = env_extended()
    fold_dates = _fold_dates(panels, DEV_START, DEV_END)
    if not fold_dates:
        print("Not enough history in this window.")
        return
    segs = assert_allowed([fold_dates[0], fold_dates[-1]])
    print(f"segment(s) touched: {segs}")
    print(f"\n########## V3 / V4  ({len(fold_dates)} folds: {fold_dates[0].date()} -> {fold_dates[-1].date()}) ##########")

    v3_w1, v3_wN, v4_w1, v4_wN = [], [], [], []
    n_signal, n_v3_fill, n_v4_early = 0, 0, 0

    for as_of in fold_dates:
        res = run_screen(as_of, rule_spec, adapter, universe_df, panels, shares)
        trades = build_trades(res["survivors"], rule_spec)
        if trades.empty:
            continue
        # Control's own 1-week grade for these exact signals -- the paired baseline both kill
        # criteria ("expectancy <= baseline (Control 1-week, D1-fixed) on the same weeks") need.
        control_graded = simulate_week_forward(trades, panels, as_of, COST_PCT)
        control_ret_by_ticker = dict(zip(control_graded["ticker"], control_graded["ret_pct_net"])) \
            if not control_graded.empty else {}

        daily_by_ticker = adapter.daily_ohlcv(trades["ticker"].tolist(), rule_spec["data"]["history_weeks"] * 7)
        for _, t in trades.iterrows():
            ticker = t["ticker"]
            daily = daily_by_ticker.get(ticker)
            if daily is None or daily.empty:
                continue
            n_signal += 1
            SL = float(t["SL"])
            signal_close = float(t["close"])
            control_ret = control_ret_by_ticker.get(ticker)

            # ---- V3: pullback limit entry ----
            fill = pullback_limit_fill(daily, as_of, limit=signal_close, window_days=5)
            if fill["filled"]:
                n_v3_fill += 1
                EP = fill["fill_price"]
                if EP > SL:
                    for horizon_list, n_weeks in ((v3_w1, 1), (v3_wN, N_STAR)):
                        h_end = horizon_end_date(fill["fill_date"], n_weeks)
                        g = simulate_daily_exit(daily, fill["fill_date"], EP, SL, h_end, COST_PCT)
                        if g is not None:
                            horizon_list.append({**g, "ticker": ticker, "signal_week": as_of,
                                                 "control_ret_pct_net": control_ret})

            # ---- V4: same-week confirmation ----
            entry = same_week_entry(daily, rule_spec, as_of)
            if entry["confirmed_early"]:
                n_v4_early += 1
            if entry["entry_price"] is not None and entry["entry_price"] > SL:
                for horizon_list, n_weeks in ((v4_w1, 1), (v4_wN, N_STAR)):
                    h_end = horizon_end_date(entry["entry_date"], n_weeks)
                    g = simulate_daily_exit(daily, entry["entry_date"], entry["entry_price"], SL, h_end, COST_PCT)
                    if g is not None:
                        horizon_list.append({**g, "ticker": ticker, "signal_week": as_of,
                                             "confirmed_early": entry["confirmed_early"],
                                             "control_ret_pct_net": control_ret})

    print(f"\nControl signals with daily coverage: {n_signal}")
    print(f"V3 fill rate: {n_v3_fill}/{n_signal} ({n_v3_fill / n_signal:.1%})" if n_signal else "V3: n/a")
    print(f"V4 early-confirmed: {n_v4_early}/{n_signal} ({n_v4_early / n_signal:.1%})" if n_signal else "V4: n/a")

    OUT.mkdir(parents=True, exist_ok=True)
    summary = {"window": [str(fold_dates[0].date()), str(fold_dates[-1].date())],
               "n_signal": n_signal, "v3_fill_rate": n_v3_fill / n_signal if n_signal else None,
               "v4_early_confirm_rate": n_v4_early / n_signal if n_signal else None}

    for label, rows in (("V3_week1", v3_w1), ("V3_weekN", v3_wN), ("V4_week1", v4_w1), ("V4_weekN", v4_wN)):
        s, df = _summarize(rows, label)
        summary[label] = s
        print(f"  {label:<10} n={s['n_trades']:<4} " +
              (f"hit={s['hit_rate']:.1%} expectancy/trade={s['expectancy_pct']:.3f}% "
               f"CI95=[{s['expectancy_ci95_lo_pct']:.3f}%, {s['expectancy_ci95_hi_pct']:.3f}%]  exits={s['exit_reasons']}"
               if s["n_trades"] else "no gradeable trades"))
        if s.get("n_paired_vs_control"):
            print(f"             vs Control (paired, n={s['n_paired_vs_control']}): "
                  f"{s['vs_control_pct']:+.3f}%  CI95=[{s['vs_control_ci95_lo_pct']:.3f}%, {s['vs_control_ci95_hi_pct']:.3f}%]")
        if not df.empty:
            df.to_csv(OUT / f"{label}_trades.csv", index=False)

    # Kill criteria compare vs. Control's own paired baseline on the same weeks (registry text),
    # not vs. an absolute zero.
    fill_rate = summary["v3_fill_rate"]
    v3_w1 = summary["V3_week1"]
    v3_kill = (fill_rate is None or fill_rate < 0.40 or
               (v3_w1.get("n_paired_vs_control") and v3_w1["vs_control_ci95_hi_pct"] <= 0))
    v4_w1 = summary["V4_week1"]
    v4_kill = (v4_w1["n_trades"] == 0 or
               (v4_w1.get("n_paired_vs_control") and v4_w1["vs_control_ci95_hi_pct"] <= 0))
    summary["v3_kill_triggered"] = bool(v3_kill)
    summary["v4_kill_triggered"] = bool(v4_kill)
    if fill_rate is not None:
        print(f"\nV3 kill (\"fill rate < 40%, or filled-trade expectancy <= baseline (Control 1-week) "
              f"on the same weeks\"): fill_rate={fill_rate:.1%}, "
              f"vs_control CI95 upper={v3_w1.get('vs_control_ci95_hi_pct')} "
              f"-> {'TRIGGERED' if v3_kill else 'not triggered'}")
    print(f"V4 kill (\"expectancy not above baseline (Control 1-week) on the same weeks\"): "
          f"vs_control CI95 upper={v4_w1.get('vs_control_ci95_hi_pct')} "
          f"-> {'TRIGGERED' if v4_kill else 'not triggered'}")

    record_read("V3", "dev", fold_dates[0], fold_dates[-1], len(fold_dates), note="V3 pullback-limit dev backtest")
    record_read("V4", "dev", fold_dates[0], fold_dates[-1], len(fold_dates), note="V4 same-week-confirmation dev backtest")

    (OUT / "V3_V4_summary.json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"\nWritten -> {OUT / 'V3_V4_summary.json'}")


if __name__ == "__main__":
    main()
