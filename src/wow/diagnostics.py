"""
Repetition diagnostics (docs/wow-arm-history-analysis-plan.md §4.4) — the question that
started this plan (§1.1): Control's own picks don't repeat week to week (an event-driven
flip has a ~2.6% pass rate), but the *candidate* layer is highly persistent because 12 of
13 flags are state, not events. This module quantifies that on the same Lane A panel.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.flags.registry import countable_ids, load_registry


def add_delta_flags_met(replay_df: pd.DataFrame) -> pd.DataFrame:
    """delta_flags_met = this week's flags_met - prior week's, same ticker (§4.4). Null
    for a ticker's first appearance. A panel column, not a summary — makes the signal
    testable later without another data build."""
    df = replay_df.sort_values(["ticker", "signal_week"]).copy()
    df["delta_flags_met"] = df.groupby("ticker")["flags_met"].diff()
    return df.sort_values(["signal_week", "ticker"]).reset_index(drop=True)


def top10_overlap_series(replay_df: pd.DataFrame) -> pd.DataFrame:
    """Week-over-week overlap of the top-10-by-flags_met set (ties broken by ticker for
    determinism — a lighter tie-break than T4's own, since this is descriptive, not
    selective)."""
    weeks = sorted(replay_df["signal_week"].unique())
    top_sets = {}
    for wk in weeks:
        wk_df = replay_df[replay_df["signal_week"] == wk]
        top10 = wk_df.sort_values(["flags_met", "ticker"], ascending=[False, True]).head(10)
        top_sets[wk] = set(top10["ticker"])

    rows = []
    for i, wk in enumerate(weeks):
        if i == 0:
            rows.append({"signal_week": wk, "overlap_n": None, "overlap_pct": None})
            continue
        prev = top_sets[weeks[i - 1]]
        cur = top_sets[wk]
        n_overlap = len(prev & cur)
        denom = min(len(prev), len(cur)) or 1
        rows.append({"signal_week": wk, "overlap_n": n_overlap, "overlap_pct": round(n_overlap / denom, 4)})
    return pd.DataFrame(rows)


def per_flag_persistence(replay_df: pd.DataFrame, flag_ids: list[str] | None = None) -> pd.DataFrame:
    """P(flag=1 this week | flag=1 last week, same ticker present both weeks), per
    countable flag (§1.1's 73-95% persistence claim, reproduced here per flag)."""
    flag_ids = flag_ids or countable_ids(load_registry())
    df = replay_df.sort_values(["ticker", "signal_week"])
    rows = []
    for fid in flag_ids:
        if fid not in df.columns:
            continue
        prev = df.groupby("ticker")[fid].shift(1)
        both_present = prev.notna() & df[fid].notna()
        was_on = both_present & (prev == 1)
        n_was_on = int(was_on.sum())
        persistence = float((df[fid][was_on] == 1).mean()) if n_was_on else None
        rows.append({"flag_id": fid, "n_ticker_weeks_on_last_week": n_was_on,
                     "persistence_rate": round(persistence, 4) if persistence is not None else None})
    return pd.DataFrame(rows)


def flags_met_autocorrelation(replay_df: pd.DataFrame, lag: int = 1) -> dict:
    """Lag-`lag` autocorrelation of flags_met, pooled across tickers that appear in
    consecutive weeks (same ticker, week t and week t-lag both present)."""
    df = replay_df.sort_values(["ticker", "signal_week"])
    lagged = df.groupby("ticker")["flags_met"].shift(lag)
    mask = lagged.notna() & df["flags_met"].notna()
    x, y = df.loc[mask, "flags_met"].to_numpy(), lagged[mask].to_numpy()
    if len(x) < 3:
        return {"lag": lag, "n": len(x), "autocorr": None}
    corr = float(np.corrcoef(x, y)[0, 1])
    return {"lag": lag, "n": len(x), "autocorr": round(corr, 4)}


def distinct_tickers_trailing(replay_df: pd.DataFrame, arm_mask_fn, arm_id: str, window: int = 13) -> pd.DataFrame:
    """Distinct-ticker count in `arm_id`'s trailing `window` weeks, as of each week."""
    weeks = sorted(replay_df["signal_week"].unique())
    picks_by_week = {}
    for wk in weeks:
        wk_df = replay_df[replay_df["signal_week"] == wk]
        picks_by_week[wk] = set(wk_df.loc[arm_mask_fn(wk_df, arm_id), "ticker"])

    rows = []
    for i, wk in enumerate(weeks):
        window_weeks = weeks[max(0, i - window + 1):i + 1]
        distinct = set().union(*(picks_by_week[w] for w in window_weeks)) if window_weeks else set()
        rows.append({"signal_week": wk, "arm": arm_id, "window": window,
                     "n_weeks_in_window": len(window_weeks), "distinct_tickers": len(distinct)})
    return pd.DataFrame(rows)


def top_decile_appearance_counts(replay_df: pd.DataFrame) -> pd.DataFrame:
    """Per-ticker count of appearances in each week's top decile by flags_met, across
    the whole grid — which names keep showing up at the top of the candidate layer."""
    counts = {}
    for wk, wk_df in replay_df.groupby("signal_week"):
        n_top = max(1, int(np.ceil(len(wk_df) * 0.10)))
        top = wk_df.sort_values(["flags_met", "ticker"], ascending=[False, True]).head(n_top)
        for t in top["ticker"]:
            counts[t] = counts.get(t, 0) + 1
    out = pd.DataFrame([{"ticker": t, "top_decile_weeks": c} for t, c in counts.items()])
    return out.sort_values(["top_decile_weeks", "ticker"], ascending=[False, True]).reset_index(drop=True)
