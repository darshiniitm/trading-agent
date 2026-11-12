"""
Panel builder (docs/wow-arm-history-analysis-plan.md §2, §4.1, §6.1-6.3).

`arm_week_panel.csv` is the contract: one row per (lane, arm, signal_week), built
read-only from already-graded records. Everything else this study emits derives from
that one file.

Lane isolation is enforced here, not by convention (§6.3): Lane A and Lane B rows never
enter the same computed difference (T-05) because callers only ever get one lane's rows
back from `load_lane_a_panel` / `load_lane_b_panel`, and `panel.py` never merges them.
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np
import pandas as pd

from src.wow.arms import registered_arm_ids, arm_mask

ROOT = Path(__file__).resolve().parents[2]
REPLAY_DIR = ROOT / "results" / "feature_flags" / "replay"
EXPERIMENTS_DIR = ROOT / "results" / "experiments"

RETURN_COL = "fwd_ret_oc_net_pct"
EXCESS_ELIGIBLE_COL = "fwd_excess_vs_eligible_pct"
EXCESS_BENCH_COL = "fwd_excess_vs_benchmark_pct"


def _npicks_bucket(n: int) -> str:
    if n <= 1:
        return "1"
    if n <= 3:
        return "2-3"
    return "4+"


def load_replay_panel(replay_dir: Path = REPLAY_DIR) -> pd.DataFrame:
    files = sorted(glob.glob(str(replay_dir / "flags_*_graded.csv")))
    if not files:
        raise FileNotFoundError(f"no graded replay files under {replay_dir}")
    frames = [pd.read_csv(f) for f in files]
    df = pd.concat(frames, ignore_index=True)
    return df.sort_values(["signal_week", "ticker"]).reset_index(drop=True)


def _l1_row(lane: str, arm: str, wk: str, picks: pd.DataFrame, regime: bool | None,
            recording_mode: str | None = None) -> dict:
    n_picks = len(picks)
    if n_picks == 0:
        return {
            "lane": lane, "arm": arm, "signal_week": wk, "n_picks": 0,
            "basket_net_pct": None, "basket_excess_eligible_pp": None, "basket_excess_bench_pp": None,
            "hit_rate": None, "stop_hit_rate": None, "median_pick_net": None, "dispersion": None,
            "n_missing_forward_bar": 0, "market_regime_bench_above_sma30w": regime,
            "n_picks_bucket": _npicks_bucket(0), "recording_mode": recording_mode,
        }
    net = picks[RETURN_COL]
    valid = net.notna()
    n_missing = int(picks["missing_forward_bar"].sum()) if "missing_forward_bar" in picks else 0
    return {
        "lane": lane, "arm": arm, "signal_week": wk, "n_picks": n_picks,
        "basket_net_pct": round(float(net[valid].mean()), 4) if valid.any() else None,
        "basket_excess_eligible_pp": (round(float(picks.loc[valid, EXCESS_ELIGIBLE_COL].mean()), 4)
                                       if valid.any() and EXCESS_ELIGIBLE_COL in picks else None),
        "basket_excess_bench_pp": (round(float(picks.loc[valid, EXCESS_BENCH_COL].mean()), 4)
                                    if valid.any() and EXCESS_BENCH_COL in picks else None),
        "hit_rate": round(float((net[valid] > 0).mean()), 4) if valid.any() else None,
        "stop_hit_rate": (round(float((picks.loc[valid, "exit_reason"] == "stop_hit").mean()), 4)
                           if valid.any() and "exit_reason" in picks else None),
        "median_pick_net": round(float(net[valid].median()), 4) if valid.any() else None,
        "dispersion": round(float(net[valid].std(ddof=1)), 4) if valid.sum() > 1 else None,
        "n_missing_forward_bar": n_missing,
        "market_regime_bench_above_sma30w": regime,
        "n_picks_bucket": _npicks_bucket(n_picks),
        "recording_mode": recording_mode,
    }


def build_lane_a_panel(replay_df: pd.DataFrame | None = None, arm_ids: list[str] | None = None) -> pd.DataFrame:
    """One row per (arm, signal_week) for every registered Lane A arm (§3.1, §5.1)."""
    df = replay_df if replay_df is not None else load_replay_panel()
    arm_ids = arm_ids or registered_arm_ids()
    for a in arm_ids:
        if a not in registered_arm_ids():
            raise ValueError(f"arm id not in registry: {a!r} (T-06)")

    rows = []
    for wk, wk_df in df.groupby("signal_week"):
        regime = (bool(wk_df["market_regime_bench_above_sma30w"].iloc[0])
                  if "market_regime_bench_above_sma30w" in wk_df and wk_df["market_regime_bench_above_sma30w"].notna().any()
                  else None)
        for arm in arm_ids:
            mask = arm_mask(wk_df, arm)
            rows.append(_l1_row("A", arm, wk, wk_df[mask], regime))
    return pd.DataFrame(rows).sort_values(["arm", "signal_week"]).reset_index(drop=True)


LANE_B_FILES = {
    "V2_N2": ("V2_N2_trades.csv", "week_start"),
    "V2_N4": ("V2_N4_trades.csv", "week_start"),
    "V2_N8": ("V2_N8_trades.csv", "week_start"),
    "V3_week1": ("V3_week1_trades.csv", "signal_week"),
    "V3_weekN": ("V3_weekN_trades.csv", "signal_week"),
    "V4_week1": ("V4_week1_trades.csv", "signal_week"),
    "V4_weekN": ("V4_weekN_trades.csv", "signal_week"),
}


def build_lane_b_panel(experiments_dir: Path = EXPERIMENTS_DIR) -> pd.DataFrame:
    """Lane B (§3.2): V-series dev backtests, read as-is and keyed on each file's own
    week column. Isolated by construction — this function returns only lane='B' rows,
    labelled with each arm's own exit convention; nothing here is comparable to Lane A's
    fwd_ret_oc_net_pct without the caveat printed alongside (§2, Lane B)."""
    rows = []
    for arm, (fname, week_col) in LANE_B_FILES.items():
        path = experiments_dir / fname
        if not path.exists():
            continue
        trades = pd.read_csv(path)
        if week_col not in trades.columns or "ret_pct_net" not in trades.columns:
            continue
        for wk, wk_df in trades.groupby(week_col):
            picks = wk_df.rename(columns={"ret_pct_net": RETURN_COL})
            picks["missing_forward_bar"] = 0
            row = _l1_row("B", arm, str(wk), picks, regime=None)
            row["exit_convention"] = arm
            rows.append(row)
    return pd.DataFrame(rows).sort_values(["arm", "signal_week"]).reset_index(drop=True) if rows else pd.DataFrame(
        columns=["lane", "arm", "signal_week", "n_picks", "basket_net_pct"])


LANE_C_ARMS = {
    "control_live": ("results/forward_test/picks_*.json", False),
    "t1_shadow": ("results/forward_test/picks_*_t1.json", True),
}


T1_REPLAY_LEDGER = ROOT / "results" / "forward_test" / "replay" / "t1_ledger_grades.csv"


def _t1_filtered(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty or "score_filter_eligible" not in df:
        return df.iloc[0:0]
    return df[df["score_filter_eligible"] == True]  # noqa: E712


def build_lane_c_panel() -> pd.DataFrame:
    """Lane C (§3.3, §6.4 T-09): append-only, one row per graded forward record per arm,
    now tagged with `recording_mode` ('forward' = live, real evidence; 'replay' = T1's
    historical backtest, dev evidence only — mirrors the flag-matrix's own recording_mode
    convention, see docs/wow-arm-history-analysis-plan.md follow-up). The forward-side
    contract (T-09: exactly one new row per arm per future weekly grade run, no schema
    change) is untouched — replay rows are purely additive, from a separate source file
    that live grading never writes to."""
    import json

    rows = []

    # control_live — forward only (unchanged)
    for path in sorted((ROOT / "results" / "forward_test").glob("picks_*.json")):
        if path.stem.endswith("_t1"):
            continue
        rec = json.loads(path.read_text())
        graded = rec.get("graded")
        wk = rec.get("signal_week_start")
        detail = (graded or {}).get("detail", [])
        traded = pd.DataFrame([d for d in detail if d.get("status") == "TRADE"]) if graded else pd.DataFrame()
        if not traded.empty:
            traded = traded.rename(columns={"ret_pct_net": RETURN_COL})
            traded["missing_forward_bar"] = 0
            traded["exit_reason"] = traded.get("exit_reason")
        rows.append(_l1_row("C", "control_live", wk, traded, regime=None, recording_mode="forward"))

    # t1_shadow / t1_shadow_filtered — forward, from the live *_t1.json records
    for path in sorted((ROOT / "results" / "forward_test").glob("picks_*_t1.json")):
        rec = json.loads(path.read_text())
        graded = rec.get("graded")
        wk = rec.get("signal_week_start") or path.stem.replace("picks_", "").replace("_t1", "")
        detail = (graded or {}).get("detail", []) if graded else []
        t1 = pd.DataFrame(detail)
        if not t1.empty:
            t1 = t1.rename(columns={"ret_pct_net": RETURN_COL})
            t1["missing_forward_bar"] = 0
        rows.append(_l1_row("C", "t1_shadow", wk, t1, regime=None, recording_mode="forward"))
        rows.append(_l1_row("C", "t1_shadow_filtered", wk, _t1_filtered(t1), regime=None, recording_mode="forward"))

    # t1_shadow / t1_shadow_filtered — replay, from the historical backfill (if built yet)
    if T1_REPLAY_LEDGER.exists():
        rdf = pd.read_csv(T1_REPLAY_LEDGER)
        rdf = rdf.rename(columns={"ret_pct_net": RETURN_COL})
        rdf["missing_forward_bar"] = 0
        for wk, wk_df in rdf.groupby("signal_week"):
            rows.append(_l1_row("C", "t1_shadow", str(wk), wk_df, regime=None, recording_mode="replay"))
            rows.append(_l1_row("C", "t1_shadow_filtered", str(wk), _t1_filtered(wk_df), regime=None,
                                 recording_mode="replay"))

    return pd.DataFrame(rows).sort_values(["arm", "signal_week"]).reset_index(drop=True) if rows else pd.DataFrame(
        columns=["lane", "arm", "signal_week", "n_picks", "basket_net_pct", "recording_mode"])
