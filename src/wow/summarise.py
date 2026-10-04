"""
L2 (per-arm, across-weeks) and trend-layer summaries (docs/wow-arm-history-analysis-plan.md
§4.2, §4.3, §5.4). Reads only `arm_week_panel.csv` — the contract every other output
derives from.

Splits (§4.3) are applied in full to the level/shape metrics that vary meaningfully at
this sample size (mean/median/win-rate/dispersion/equity/drawdown). The trend tests
(OLS+NW, Mann-Kendall, half-split) and the paired-vs-control comparison are reported on
the unsplit ("all") series only — splitting an already-thin weekly series five further
ways would mostly produce more `insufficient history` strings than trend evidence; this
is a documented simplification, not silent scope creep.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.wow import stats

SPLITS = ["all", "regime_on", "regime_off", "npicks_1", "npicks_2-3", "npicks_4+"]
BASES = [
    ("net_pct", "basket_net_pct"),
    ("excess_eligible_pp", "basket_excess_eligible_pp"),
    ("excess_bench_pp", "basket_excess_bench_pp"),
]


def _split_mask(df: pd.DataFrame, split: str) -> pd.Series:
    if split == "all":
        return pd.Series(True, index=df.index)
    if split == "regime_on":
        return df["market_regime_bench_above_sma30w"] == True  # noqa: E712
    if split == "regime_off":
        return df["market_regime_bench_above_sma30w"] == False  # noqa: E712
    if split.startswith("npicks_"):
        return df["n_picks_bucket"] == split[len("npicks_"):]
    raise ValueError(f"unknown split: {split}")


def arm_summary(panel: pd.DataFrame, lane: str) -> pd.DataFrame:
    """L2: mean/median of each basis, weeks-with-picks/cash-weeks, win rate, equity
    curve shape, pooled row-mean (secondary), for every (arm, split)."""
    rows = []
    lane_df = panel[panel["lane"] == lane]
    for arm, arm_df in lane_df.groupby("arm"):
        arm_df = arm_df.sort_values("signal_week")
        n_weeks_total = len(arm_df)
        with_picks = arm_df[arm_df["n_picks"] > 0]
        n_cash = n_weeks_total - len(with_picks)

        # Equity curve + drawdown always computed on the full (unsplit) chronological
        # series — a "curve" restricted to a split isn't a coherent P&L shape.
        curve = stats.equity_curve(arm_df.set_index("signal_week")["basket_net_pct"])
        mdd = stats.max_drawdown(curve)
        roll13 = stats.rolling_mean(arm_df["basket_net_pct"], 13)
        roll26 = stats.rolling_mean(arm_df["basket_net_pct"], 26)

        for split in SPLITS:
            mask = _split_mask(arm_df, split)
            sub = arm_df[mask]
            sub_with_picks = sub[sub["n_picks"] > 0]
            row = {
                "lane": lane, "arm": arm, "split": split,
                "n_weeks_total": len(sub),
                "n_weeks_with_picks": len(sub_with_picks),
                "n_cash_weeks": len(sub) - len(sub_with_picks),
                "win_week_rate": (round(float((sub_with_picks["basket_net_pct"] > 0).mean()), 4)
                                   if len(sub_with_picks) else None),
                "equity_final": float(curve.iloc[-1]) if split == "all" and len(curve) else None,
                "max_drawdown_pct": round(mdd * 100, 3) if split == "all" and not np.isnan(mdd) else None,
                "rolling_13wk_mean_last": (round(float(roll13.iloc[-1]), 4)
                                            if split == "all" and roll13.notna().any() else None),
                "rolling_26wk_mean_last": (round(float(roll26.iloc[-1]), 4)
                                            if split == "all" and roll26.notna().any() else None),
            }
            for base_name, col in BASES:
                vals = sub_with_picks[col].dropna()
                row[f"mean_{base_name}"] = round(float(vals.mean()), 4) if len(vals) else None
                row[f"median_{base_name}"] = round(float(vals.median()), 4) if len(vals) else None
                # Secondary, pooled (weighted by pick count that week) — labelled, never headline.
                row[f"pooled_mean_{base_name}_secondary"] = None
            rows.append(row)
    return pd.DataFrame(rows)


def pooled_means_lane_a(replay_df: pd.DataFrame, arm_ids: list[str]) -> dict:
    """Secondary pooled (per-pick, not per-week) means for Lane A — computed straight
    from the L0 replay rows, since arm_week_panel.csv only carries L1 aggregates.
    Returns {arm: {basis: pooled_mean}}, merged into arm_summary's split='all' rows by
    the CLI. Labelled '_secondary' throughout — never the headline (§1.2)."""
    from src.wow.arms import arm_mask
    from src.wow.panel import RETURN_COL, EXCESS_ELIGIBLE_COL, EXCESS_BENCH_COL

    col_by_basis = {"net_pct": RETURN_COL, "excess_eligible_pp": EXCESS_ELIGIBLE_COL,
                     "excess_bench_pp": EXCESS_BENCH_COL}
    out = {}
    for arm in arm_ids:
        rows = []
        for _, wk_df in replay_df.groupby("signal_week"):
            rows.append(wk_df[arm_mask(wk_df, arm)])
        picks = pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()
        out[arm] = {basis: (round(float(picks[col].dropna().mean()), 4)
                             if not picks.empty and col in picks and picks[col].notna().any() else None)
                    for basis, col in col_by_basis.items()}
    return out


def trend_tests(panel: pd.DataFrame, lane: str, mode: str | None = None) -> pd.DataFrame:
    """Q1 (§4.2 items 3-4): OLS+NW slope, Mann-Kendall, first/second-half split — on the
    unsplit chronological series, floored at MIN_TREND_WEEKS weeks-with-picks (§5.4).

    `mode`, when given, restricts to rows whose `recording_mode` matches (e.g. Lane C's
    't1_shadow' carries both 'replay' — a 104-week dev backtest — and 'forward' — the
    real, live weeks — under one arm id; never blend them into one series). Omitted
    (default) for lanes that don't carry the column at all, unaffected either way."""
    rows = []
    lane_df = panel[panel["lane"] == lane]
    if mode is not None:
        lane_df = lane_df[lane_df.get("recording_mode") == mode]
    for arm, arm_df in lane_df.groupby("arm"):
        arm_df = arm_df.sort_values("signal_week")
        for base_name, col in BASES:
            series = arm_df[col]
            n_with_picks = int(series.notna().sum())
            row = {"lane": lane, "arm": arm, "basis": base_name, "recording_mode": mode or "all",
                   "n_weeks_with_picks": n_with_picks}
            if n_with_picks < stats.MIN_TREND_WEEKS:
                row["status"] = stats.suppress(n_with_picks, stats.MIN_TREND_WEEKS)
                for k in ("ols_slope", "ols_se", "ols_t", "ols_p", "mk_tau", "mk_p",
                          "half_first_mean", "half_second_mean", "half_diff_mean",
                          "half_diff_ci_lo", "half_diff_ci_hi", "agree_direction"):
                    row[k] = None
                rows.append(row)
                continue

            ols = stats.ols_newey_west_trend(series.to_numpy())
            mk = stats.mann_kendall(series.to_numpy())
            half = stats.half_split_bootstrap(series.to_numpy())
            ols_sign = np.sign(ols["slope"]) if ols["slope"] else 0
            mk_sign = np.sign(mk["tau"]) if mk["tau"] else 0
            row.update({
                "status": "ok",
                "ols_slope": ols["slope"], "ols_se": ols["se"], "ols_t": ols["t"], "ols_p": ols["p"],
                "mk_tau": mk["tau"], "mk_p": mk["p"],
                "half_first_mean": half["first_half_mean"], "half_second_mean": half["second_half_mean"],
                "half_diff_mean": half["diff_mean"], "half_diff_ci_lo": half["diff_ci_lo"],
                "half_diff_ci_hi": half["diff_ci_hi"],
                "agree_direction": bool(ols_sign == mk_sign) if ols["slope"] is not None and mk["tau"] is not None else None,
            })
            rows.append(row)
    return pd.DataFrame(rows)


def paired_vs_control(panel: pd.DataFrame, lane: str, control_arm: str = "control",
                       mode: str | None = None) -> pd.DataFrame:
    """Q2 (§4.2 item 5): mean paired weekly difference vs `control`, block-bootstrap CI,
    and n_paired_weeks — printed beside every figure, floored at MIN_PAIRED_WEEKS.

    `mode` restricts both the arm and the control side to matching `recording_mode` rows
    before pairing — for Lane C this keeps the graduation-track comparison
    (mode="forward") from ever pairing against, or being diluted by, T1's replay rows."""
    lane_df = panel[panel["lane"] == lane]
    if mode is not None:
        lane_df = lane_df[lane_df.get("recording_mode") == mode]
    control_df = lane_df[lane_df["arm"] == control_arm].set_index("signal_week")
    rows = []
    for arm, arm_df in lane_df.groupby("arm"):
        if arm == control_arm:
            continue
        arm_df = arm_df.set_index("signal_week")
        for base_name, col in BASES:
            joined = pd.DataFrame({"arm": arm_df[col], "control": control_df[col]}).dropna()
            n_paired = len(joined)
            row = {"lane": lane, "arm": arm, "control_arm": control_arm, "basis": base_name,
                   "recording_mode": mode or "all", "n_paired_weeks": n_paired}
            if n_paired < stats.MIN_PAIRED_WEEKS:
                row["status"] = stats.suppress(n_paired, stats.MIN_PAIRED_WEEKS)
                row.update({"mean_diff": None, "ci_lo": None, "ci_hi": None})
            else:
                mean_diff, lo, hi = stats.moving_block_bootstrap_diff_ci(
                    joined["arm"].to_numpy(), joined["control"].to_numpy())
                row["status"] = "ok"
                row.update({"mean_diff": round(mean_diff, 4), "ci_lo": round(lo, 4), "ci_hi": round(hi, 4)})
            rows.append(row)
    return pd.DataFrame(rows)


def paired_t1_replay_vs_control_replay(panel: pd.DataFrame) -> pd.DataFrame:
    """T1's 104-week replay (Lane C, arm='t1_shadow'/'t1_shadow_filtered',
    recording_mode='replay') paired against Control's own 104-week replay (Lane A,
    arm='control') on the SAME signal_week. Commensurable — both sides share the same
    _grade_rows()/corrected_week_bar exit convention and 0.5% cost, unlike Lane B's
    V-series — but deliberately a SEPARATE function/output from paired_vs_control()
    because it crosses lanes (something that function structurally can't do) and because
    a distinct name/file keeps this dev-backtest number from ever being mistaken for the
    forward-only, graduation-track comparison paired_vs_control(panel, "C", mode="forward")
    already produces. NOT forward evidence — never a graduation signal on its own."""
    control_df = panel[(panel["lane"] == "A") & (panel["arm"] == "control")].set_index("signal_week")
    t1_df = panel[(panel["lane"] == "C") & (panel.get("recording_mode") == "replay")]
    rows = []
    for arm, arm_df in t1_df.groupby("arm"):
        arm_df = arm_df.set_index("signal_week")
        for base_name, col in BASES:
            joined = pd.DataFrame({"arm": arm_df[col], "control": control_df[col]}).dropna()
            n_paired = len(joined)
            row = {"lane": "C_vs_A_replay", "arm": arm, "control_arm": "control", "basis": base_name,
                   "recording_mode": "replay", "n_paired_weeks": n_paired}
            if n_paired < stats.MIN_PAIRED_WEEKS:
                row["status"] = stats.suppress(n_paired, stats.MIN_PAIRED_WEEKS)
                row.update({"mean_diff": None, "ci_lo": None, "ci_hi": None})
            else:
                mean_diff, lo, hi = stats.moving_block_bootstrap_diff_ci(
                    joined["arm"].to_numpy(), joined["control"].to_numpy())
                row["status"] = "ok"
                row.update({"mean_diff": round(mean_diff, 4), "ci_lo": round(lo, 4), "ci_hi": round(hi, 4)})
            rows.append(row)
    return pd.DataFrame(rows)
