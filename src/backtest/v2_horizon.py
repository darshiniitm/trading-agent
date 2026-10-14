"""
V2 -- fixed N-week hold (config/experiments.yaml id V2; docs/open-decisions-implementation-plan.md
§2 "point 1 -- daily bars -> entry timing", though V2 itself only needs weekly bars).

Control's own weekly trades (run_screen + build_trades, UNCHANGED selection). Entry = open of
the first holding week -- the same fill simulate_week_forward uses. The stop is STATIC at the
signal-week VStop line and is never trailed (unlike simulate_trend_hold's D3-fixed trailing
stop) -- isolating the pure horizon effect from stop-path complexity is the whole point of V2
per the revision plan. Each holding week, in order:
  * open <= SL  -> gap_stop_at_open, exit at the open (same D1 rule every other grader uses)
  * low  <= SL  -> stop_hit, exit at SL
  * this is holding week N -> horizon_close, exit at week N's close
A trade without N full holding weeks of forward data yet is dropped (not graded early), so
short a fold near the end of the available window never masquerades as a completed N-week trade.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def simulate_fixed_hold(trades_df: pd.DataFrame, weekly_panels: dict[str, pd.DataFrame],
                         as_of: pd.Timestamp, cost_pct: float, n_weeks: int) -> pd.DataFrame:
    if trades_df.empty:
        return trades_df.assign(exit_price=[], exit_reason=[], hold_weeks=[], ret_pct=[],
                                 ret_pct_net=[], r_multiple=[])

    rows = []
    for _, t in trades_df.iterrows():
        panel = weekly_panels.get(t["ticker"])
        if panel is None:
            continue
        future = panel[panel["date"] > as_of].sort_values("date").reset_index(drop=True)
        if len(future) < n_weeks:
            continue  # not enough forward data yet to grade this horizon -- skip, don't fabricate an exit

        EP = float(future.iloc[0]["open"])
        SL = float(t["SL"])
        exit_idx, exit_reason, exit_price = None, None, None
        for i in range(n_weeks):
            row = future.iloc[i]
            if float(row["open"]) <= SL:
                exit_idx, exit_reason, exit_price = i, "gap_stop_at_open", float(row["open"])
                break
            if float(row["low"]) <= SL:
                exit_idx, exit_reason, exit_price = i, "stop_hit", SL
                break
            if i == n_weeks - 1:
                exit_idx, exit_reason, exit_price = i, "horizon_close", float(row["close"])

        ret_pct = (exit_price - EP) / EP
        ret_pct_net = ret_pct - cost_pct
        R = EP - SL
        r_multiple = (exit_price - EP) / R if R > 0 else np.nan

        rows.append({**t.to_dict(), "EP": EP, "exit_price": exit_price, "exit_reason": exit_reason,
                     "hold_weeks": exit_idx + 1, "ret_pct": ret_pct, "ret_pct_net": ret_pct_net,
                     "r_multiple": r_multiple, "n_weeks": n_weeks,
                     "week_start": as_of, "week_end": future.iloc[exit_idx]["date"]})

    return pd.DataFrame(rows)
