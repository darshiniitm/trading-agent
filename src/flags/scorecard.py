"""
Scorecard: per-flag week-clustered lift, rank-IC, BH correction, correlation
matrix, maturity labels (docs/feature-flag-matrix-plan.md §6.5).

Computed separately per `mode` (forward/replay never pooled; late_backfill
reported on its own, excluded from gate statistics — §6.5, mirroring how
Control's own T1-T3 gates only count `forward` weeks). Reuses
`bootstrap_ci` (seed=42) from src/backtest/harness.py and the maturity
thresholds from tests/track_forward.py rather than redefining them (G9,
HARNESS §10).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from src.backtest.harness import bootstrap_ci
from tests.track_forward import FIRST_LOOK_WEEKS, REAL_READ_WEEKS

EXCESS_COL = "fwd_excess_vs_eligible_pct"
RETURN_COL = "fwd_ret_oc_net_pct"


def join_ledger(records_df: pd.DataFrame, grades_df: pd.DataFrame,
                 key=("registry_version", "recording_mode", "signal_week", "ticker")) -> pd.DataFrame:
    return records_df.merge(grades_df, on=list(key), how="inner", suffixes=("", "_g"))


def maturity_label(n_weeks: int) -> str:
    if n_weeks < FIRST_LOOK_WEEKS:
        return "TOO_EARLY"
    if n_weeks < REAL_READ_WEEKS:
        return "FIRST_LOOK"
    return "REAL_READ"


def _bootstrap_pvalue(values: np.ndarray, n_boot: int = 5000, seed: int = 42) -> float | None:
    if len(values) == 0:
        return None
    rng = np.random.default_rng(seed)
    means = np.array([rng.choice(values, size=len(values), replace=True).mean() for _ in range(n_boot)])
    p_pos = float((means <= 0).mean())
    p_neg = float((means >= 0).mean())
    return float(min(1.0, 2 * min(p_pos, p_neg)))


def _bh_correction(p_values: dict[str, float | None]) -> dict[str, float | None]:
    ids = [k for k, v in p_values.items() if v is not None]
    if not ids:
        return {k: None for k in p_values}
    sorted_ids = sorted(ids, key=lambda k: p_values[k])
    m = len(sorted_ids)
    q = {}
    prev = 1.0
    for rank, fid in reversed(list(enumerate(sorted_ids, start=1))):
        val = min(prev, p_values[fid] * m / rank)
        q[fid] = round(val, 4)
        prev = val
    for k, v in p_values.items():
        if v is None:
            q[k] = None
    return q


def _weekly_lift(df: pd.DataFrame, flag_id: str) -> pd.Series:
    """Per-week L_w = mean(excess|flag=1) - mean(excess|flag=0); a week is skipped
    if either side has < 3 names (§6.5)."""
    lifts = {}
    for wk, g in df.groupby("signal_week"):
        g = g[g[flag_id].notna() & g[EXCESS_COL].notna()]
        pos, neg = g[g[flag_id] == 1], g[g[flag_id] == 0]
        if len(pos) < 3 or len(neg) < 3:
            continue
        lifts[wk] = pos[EXCESS_COL].mean() - neg[EXCESS_COL].mean()
    return pd.Series(lifts)


def flag_scorecard(df: pd.DataFrame, countable_ids: list[str]) -> pd.DataFrame:
    rows = []
    p_values = {}
    for fid in countable_ids:
        if fid not in df.columns:
            continue
        lift = _weekly_lift(df, fid)
        n_weeks = len(lift)
        mean_lift, lo, hi = bootstrap_ci(lift.to_numpy()) if n_weeks else (np.nan, np.nan, np.nan)
        p = _bootstrap_pvalue(lift.to_numpy()) if n_weeks else None
        p_values[fid] = p

        evaluable = df[df[fid].notna()]
        prevalence = float(evaluable[fid].mean()) if not evaluable.empty else None
        flag1 = evaluable[evaluable[fid] == 1]
        flag0 = evaluable[evaluable[fid] == 0]
        hit1 = float((flag1[RETURN_COL] > 0).mean()) if len(flag1) and flag1[RETURN_COL].notna().any() else None
        hit0 = float((flag0[RETURN_COL] > 0).mean()) if len(flag0) and flag0[RETURN_COL].notna().any() else None

        rows.append({
            "flag_id": fid, "n_weeks": n_weeks, "mean_prevalence": round(prevalence, 4) if prevalence is not None else None,
            "lift_mean": round(float(mean_lift), 4) if n_weeks else None,
            "lift_ci_lo": round(float(lo), 4) if n_weeks else None,
            "lift_ci_hi": round(float(hi), 4) if n_weeks else None,
            "hit_rate_flag1": round(hit1, 4) if hit1 is not None else None,
            "hit_rate_flag0": round(hit0, 4) if hit0 is not None else None,
            "p_value": round(p, 4) if p is not None else None,
            "maturity": maturity_label(n_weeks),
        })

    q_values = _bh_correction(p_values)
    for r in rows:
        r["bh_q_value"] = q_values.get(r["flag_id"])
        r["significant_after_bh"] = bool(r["bh_q_value"] is not None and r["bh_q_value"] < 0.05)
    return pd.DataFrame(rows)


def flags_met_rank_ic(df: pd.DataFrame) -> dict:
    weekly_ic = {}
    for wk, g in df.groupby("signal_week"):
        g = g[g["flags_met"].notna() & g[EXCESS_COL].notna()]
        if len(g) < 3 or g["flags_met"].nunique() < 2:
            continue
        rho, _ = spearmanr(g["flags_met"], g[EXCESS_COL])
        if pd.notna(rho):
            weekly_ic[wk] = rho
    ic_series = pd.Series(weekly_ic)
    if ic_series.empty:
        return {"n_weeks": 0, "mean_ic": None, "ci_lo": None, "ci_hi": None, "maturity": "TOO_EARLY"}
    mean_ic, lo, hi = bootstrap_ci(ic_series.to_numpy())
    return {"n_weeks": len(ic_series), "mean_ic": round(float(mean_ic), 4),
            "ci_lo": round(float(lo), 4), "ci_hi": round(float(hi), 4),
            "maturity": maturity_label(len(ic_series))}


def flags_met_bucket_table(df: pd.DataFrame) -> pd.DataFrame:
    bins = [(0, 3), (4, 6), (7, 9), (10, 13)]
    rows = []
    d = df[df["flags_met"].notna() & df[EXCESS_COL].notna()]
    for lo, hi in bins:
        g = d[(d["flags_met"] >= lo) & (d["flags_met"] <= hi)]
        rows.append({
            "bucket": f"{lo}-{hi}", "n": len(g),
            "mean_excess_pct": round(float(g[EXCESS_COL].mean()), 3) if len(g) else None,
            "hit_rate": round(float((g[RETURN_COL] > 0).mean()), 4) if len(g) and g[RETURN_COL].notna().any() else None,
        })
    return pd.DataFrame(rows)


def flag_correlation_matrix(df: pd.DataFrame, countable_ids: list[str]) -> pd.DataFrame:
    cols = [c for c in countable_ids if c in df.columns]
    return df[cols].astype(float).corr()
