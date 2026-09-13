"""
Quantify the real-world impact of the defects found, on the actual 104-week
walk-forward. A bug that never fires is a footnote; one that fires often and
moves the headline number is a blocker.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest.harness import (
    rolling_walk_forward, summarize_trades, weekly_portfolio_returns, portfolio_metrics,
)
from tests.offline import env, all_dates


def corrected_grade(graded: pd.DataFrame, panels: dict, cost_pct: float) -> pd.DataFrame:
    """Re-grade each trade with gap-aware fills: you cannot fill better than the open."""
    rows = []
    for _, t in graded.iterrows():
        p = panels[t["ticker"]]
        nxt = p[p["date"] == t["week_end"]]
        if nxt.empty:
            continue
        nxt = nxt.iloc[0]
        EP, SL = float(nxt["open"]), float(t["SL"])
        if EP <= SL:
            # gapped straight through the stop at the open -> stopped at the open
            exit_price, reason = EP, "gap_stop_at_open"
        elif float(nxt["low"]) <= SL:
            exit_price, reason = SL, "stop_hit"
        else:
            exit_price, reason = float(nxt["close"]), "week_close"
        ret = (exit_price - EP) / EP
        rows.append({**t.to_dict(), "exit_price_fixed": exit_price, "exit_reason_fixed": reason,
                     "ret_pct_fixed": ret, "ret_pct_net_fixed": ret - cost_pct})
    return pd.DataFrame(rows)


def main():
    rule_spec, adapter, uni, panels, shares = env()
    dates = all_dates(panels)
    n_folds = rule_spec["validation"]["walk_forward_weeks"]
    fold_dates = dates[-(n_folds + 1):-1]        # need a forward week for each
    cost_pct = rule_spec["validation"]["costs_pct_round_trip"] / 100

    print(f"Running {len(fold_dates)} folds: {fold_dates[0].date()} -> {fold_dates[-1].date()}")
    graded = rolling_walk_forward(fold_dates, rule_spec, adapter, uni, panels, shares,
                                  progress_every=0)
    print(f"\ngraded trades: {len(graded)}")

    # ---- Defect A: gap-through-stop fills
    fixed = corrected_grade(graded, panels, cost_pct)
    gaps = fixed[fixed["exit_reason_fixed"] == "gap_stop_at_open"]
    print("\n" + "=" * 68)
    print("DEFECT A — gap-through-stop fills")
    print("=" * 68)
    print(f"trades that gapped below SL at the open : {len(gaps)} / {len(fixed)} "
          f"({len(gaps)/max(len(fixed),1):.1%})")
    if len(gaps):
        wrong = gaps["ret_pct"].to_numpy()
        right = gaps["ret_pct_fixed"].to_numpy()
        print(f"  reported mean return on those trades : {wrong.mean():+.2%}")
        print(f"  correct  mean return on those trades : {right.mean():+.2%}")
        print(f"  reported as PROFITABLE but stopped   : {(wrong > 0).sum()}")
        print(f"  worst single overstatement           : {(wrong - right).max():+.2%}")

    # ---- Headline metrics, as reported vs corrected
    print("\n" + "=" * 68)
    print("HEADLINE IMPACT")
    print("=" * 68)
    rep = summarize_trades(graded)
    fx = fixed.rename(columns={"ret_pct_net_fixed": "_tmp"}).copy()
    fx["ret_pct_net"] = fx["_tmp"]
    fxs = summarize_trades(fx)
    for k in ["n_trades", "hit_rate", "avg_win_pct", "avg_loss_pct", "expectancy_pct",
              "mean_ret_pct", "mean_ret_ci95_lo", "mean_ret_ci95_hi"]:
        a, b = rep.get(k), fxs.get(k)
        fmt = (lambda v: f"{v:.4%}") if isinstance(a, float) and abs(a) < 1 else (lambda v: f"{v}")
        print(f"  {k:22s} reported={fmt(a):>12s}   gap-corrected={fmt(b):>12s}")

    # ---- Defect B: dropped flat weeks
    print("\n" + "=" * 68)
    print("DEFECT B — weeks with no picks dropped from the portfolio series")
    print("=" * 68)
    w = weekly_portfolio_returns(graded)
    traded_weeks, calendar_weeks = len(w), len(fold_dates)
    print(f"calendar weeks in walk-forward : {calendar_weeks}")
    print(f"weeks present in return series : {traded_weeks}")
    print(f"flat weeks silently dropped    : {calendar_weeks - traded_weeks}")

    m_reported = portfolio_metrics(w)
    full_idx = pd.DataFrame({"week_start": fold_dates})
    w_full = full_idx.merge(w, on="week_start", how="left").fillna({"portfolio_ret_net": 0.0})
    m_correct = portfolio_metrics(w_full)
    print(f"\n  {'metric':16s} {'reported':>12s} {'corrected':>12s}")
    for k in ["n_weeks", "cagr", "vol_annual", "sharpe", "max_drawdown"]:
        a, b = m_reported.get(k), m_correct.get(k)
        f = (lambda v: f"{v:.3f}" if isinstance(v, float) else f"{v}")
        print(f"  {k:16s} {f(a):>12s} {f(b):>12s}")

    graded.to_parquet("/tmp/graded.parquet")
    print("\n(saved graded trades to /tmp/graded.parquet)")


if __name__ == "__main__":
    main()
