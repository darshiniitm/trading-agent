"""
T4 — Flag-count selection Test arm (docs/feature-flag-matrix-plan.md §7).

Selection mechanism: eligible stocks with A02=1 AND A04=1 AND flags_met>=K,
top max_names by the pre-registered tie-break, equal weight. A02+A04 are
hard requirements (§7.2) so T4 stays inside Control's own risk envelope
(same SL, same exit rule, same costs) — this is a selection change only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

DEFAULT_TIE_BREAK = ["flags_met", "median_weekly_turnover_cr", "ticker"]
DEFAULT_ASCENDING = [False, False, True]


def _parse_tie_break(tie_break) -> tuple[list[str], list[bool]]:
    """Accepts either plain column names (assumed to follow DEFAULT_ASCENDING) or
    the registry's config/feature_flags.yaml spelling (e.g. 'flags_met_desc',
    'ticker_asc')."""
    if tie_break is None:
        return DEFAULT_TIE_BREAK, DEFAULT_ASCENDING
    cols, asc = [], []
    for spec in tie_break:
        if spec.endswith("_desc"):
            cols.append(spec[: -len("_desc")]); asc.append(False)
        elif spec.endswith("_asc"):
            cols.append(spec[: -len("_asc")]); asc.append(True)
        else:
            cols.append(spec); asc.append(DEFAULT_ASCENDING[DEFAULT_TIE_BREAK.index(spec)]
                                           if spec in DEFAULT_TIE_BREAK else True)
    return cols, asc


def select_t4(df: pd.DataFrame, k: int, max_names: int = 10,
              tie_break: list[str] = None) -> pd.DataFrame:
    cols, ascending = _parse_tie_break(tie_break)
    out = df.copy()
    out["t4_selected"] = 0
    out["t4_rank"] = np.nan
    if k is None or df.empty:
        return out

    candidates = out[(out["A02_vstop_uptrend"] == 1) & (out["A04_risk_cap_ok"] == 1)
                      & (out["flags_met"] >= k)]
    candidates = candidates.sort_values(cols, ascending=ascending, kind="mergesort")
    selected = candidates.head(max_names)

    rank_map = {t: i + 1 for i, t in enumerate(selected["ticker"])}
    out.loc[out["ticker"].isin(rank_map), "t4_selected"] = 1
    out["t4_rank"] = out["ticker"].map(rank_map)
    return out


def t4_weekly_basket_net(selected_df: pd.DataFrame, return_col: str = "fwd_ret_control_exit_net_pct") -> float:
    """§7.1: a week with zero T4 names counts as 0.0%, never dropped."""
    picks = selected_df[selected_df["t4_selected"] == 1]
    if picks.empty or picks[return_col].isna().all():
        return 0.0
    return float(picks[return_col].dropna().mean())


def _weekly_baskets(merged_df: pd.DataFrame, weeks: list, k: int, max_names: int, tie_break: list[str]):
    nets, n_nonzero = [], 0
    for wk in weeks:
        wk_df = merged_df[merged_df["signal_week"] == wk]
        sel = select_t4(wk_df, k, max_names, tie_break)
        if (sel["t4_selected"] == 1).any():
            n_nonzero += 1
        nets.append(t4_weekly_basket_net(sel))
    return nets, n_nonzero


def calibrate_k(merged_df: pd.DataFrame, k_grid: list[int], max_names: int = 10,
                 tie_break: list[str] = None, min_coverage: float = 0.6) -> dict:
    """§7.3: DEV (older half of the replay window) picks K; VALIDATE (newer half)
    runs it once. Ties -> larger K. Returns the full protocol trail, not just the
    chosen K, so the decision is auditable."""
    tie_break = tie_break or DEFAULT_TIE_BREAK
    weeks = sorted(merged_df["signal_week"].unique())
    n = len(weeks)
    split = n // 2
    dev_weeks, val_weeks = weeks[:split], weeks[split:]

    dev_results = {}
    for k in k_grid:
        nets, n_nonzero = _weekly_baskets(merged_df, dev_weeks, k, max_names, tie_break)
        dev_results[k] = {
            "mean_weekly_net_pct": round(float(np.mean(nets)), 4) if nets else None,
            "coverage": round(n_nonzero / len(dev_weeks), 3) if dev_weeks else 0.0,
            "n_weeks": len(dev_weeks),
        }

    eligible = [k for k, r in dev_results.items() if r["coverage"] >= min_coverage]
    if not eligible:
        return {"chosen_k": None, "dev": dev_results, "validate": None,
                "kill_criterion_a_triggered": None,
                "note": f"no K in k_grid produced >=1 name in >={min_coverage:.0%} of DEV weeks"}

    chosen_k = max(eligible, key=lambda k: (dev_results[k]["mean_weekly_net_pct"], k))
    val_nets, val_nonzero = _weekly_baskets(merged_df, val_weeks, chosen_k, max_names, tie_break)
    val_mean = round(float(np.mean(val_nets)), 4) if val_nets else None
    return {
        "chosen_k": chosen_k, "dev": dev_results,
        "validate": {"mean_weekly_net_pct": val_mean, "n_weeks": len(val_weeks),
                     "coverage": round(val_nonzero / len(val_weeks), 3) if val_weeks else 0.0},
        "kill_criterion_a_triggered": bool(val_mean is not None and val_mean <= 0),
    }


def t4_vs_control_series(merged_df: pd.DataFrame, k: int, max_names: int = 10,
                          tie_break: list[str] = None) -> pd.DataFrame:
    """§7.4: t4_vs_control.csv — paired by signal_week, never array position."""
    tie_break = tie_break or DEFAULT_TIE_BREAK
    rows = []
    for wk, wk_df in merged_df.groupby("signal_week"):
        sel = select_t4(wk_df, k, max_names, tie_break)
        t4_net = t4_weekly_basket_net(sel)
        control_rows = wk_df[wk_df["control_status"] == "TRADE"]
        control_net = (float(control_rows["fwd_ret_control_exit_net_pct"].dropna().mean())
                       if len(control_rows) and control_rows["fwd_ret_control_exit_net_pct"].notna().any() else 0.0)
        eligible_mean = (float(wk_df["fwd_ret_oc_net_pct"].dropna().mean())
                         if wk_df["fwd_ret_oc_net_pct"].notna().any() else None)
        rows.append({
            "signal_week": wk, "mode": wk_df["recording_mode"].iloc[0] if len(wk_df) else None,
            "t4_n": int((sel["t4_selected"] == 1).sum()), "t4_net_pct": round(t4_net, 3),
            "control_n": len(control_rows), "control_net_pct": round(control_net, 3),
            "delta_pct": round(t4_net - control_net, 3),
            "eligible_mean_pct": round(eligible_mean, 3) if eligible_mean is not None else None,
        })
    return pd.DataFrame(rows).sort_values("signal_week").reset_index(drop=True)
