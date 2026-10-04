"""
Gap-aware exit on daily bars, shared by V3 and V4 (config/experiments.yaml; docs/open-decisions-
implementation-plan.md §2 step 3). One engine, reused for every daily-resolution horizon rather
than a variant-specific reimplementation (HARNESS §2's spirit applied to the exit path too).

Horizon convention: "holding week N" counts calendar weeks from the week containing the actual
ENTRY (not the signal week) -- holding week 1 ends at that week's own Friday close, holding week
N ends (N-1) weeks later. This re-anchors V2's fixed-N-week convention to the entry date instead
of the signal date, since V3/V4 exist specifically to test entries that land after the signal
week's own Friday.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def horizon_end_date(entry_date: pd.Timestamp, n_weeks: int) -> pd.Timestamp:
    entry_date = pd.Timestamp(entry_date)
    monday_of_entry_week = entry_date - pd.Timedelta(days=entry_date.weekday())
    friday_of_entry_week = monday_of_entry_week + pd.Timedelta(days=4)
    return friday_of_entry_week + pd.Timedelta(weeks=n_weeks - 1)


def simulate_daily_exit(daily: pd.DataFrame, entry_date: pd.Timestamp, EP: float, SL: float,
                         horizon_end: pd.Timestamp, cost_pct: float) -> dict | None:
    """Entry day itself only ever checks the low (EP == that day's open, by construction, so a
    gap-through-open check is meaningless on the entry day itself). Every later day checks
    open <= SL first (gap_stop_at_open), then low <= SL (stop_hit). No stop through horizon_end
    -> horizon_close at the last available day's close at/before horizon_end. Returns None if
    there isn't yet a bar on or after entry_date (can't grade this trade yet)."""
    days = daily[(daily["date"] >= entry_date) & (daily["date"] <= horizon_end)].sort_values("date")
    if days.empty:
        return None

    exit_price, exit_reason, exit_date = None, None, None
    for i, (_, row) in enumerate(days.iterrows()):
        d = pd.Timestamp(row["date"])
        if i == 0:
            if float(row["low"]) <= SL:
                exit_price, exit_reason, exit_date = SL, "stop_hit", d
                break
            continue
        if float(row["open"]) <= SL:
            exit_price, exit_reason, exit_date = float(row["open"]), "gap_stop_at_open", d
            break
        if float(row["low"]) <= SL:
            exit_price, exit_reason, exit_date = SL, "stop_hit", d
            break

    if exit_price is None:
        last = days.iloc[-1]
        # not yet reached the horizon end -> can't grade this trade yet (last bar is mid-horizon)
        if pd.Timestamp(last["date"]) < horizon_end and (daily["date"] > horizon_end).sum() == 0:
            return None
        exit_price, exit_reason, exit_date = float(last["close"]), "horizon_close", pd.Timestamp(last["date"])

    ret_pct = (exit_price - EP) / EP
    R = EP - SL
    return {"EP": EP, "SL": SL, "entry_date": pd.Timestamp(entry_date), "exit_price": exit_price,
            "exit_reason": exit_reason, "exit_date": exit_date,
            "ret_pct": ret_pct, "ret_pct_net": ret_pct - cost_pct,
            "r_multiple": (exit_price - EP) / R if R > 0 else np.nan}
