"""
Arm registry for the week-over-week study (docs/wow-arm-history-analysis-plan.md §3, §5.1).

Every arm is a deterministic row filter over the flag-matrix replay panel
(results/feature_flags/replay/flags_<wk>_graded.csv). No arm re-runs the screener or
re-fetches a price; T4 and threshold arm definitions are imported from the code that
already owns them (src/flags/t4.py, src/experiments/threshold.py) rather than restated,
per §3.1's explicit instruction.

Arms are restricted to those already registered before this plan (§5.1): config/rules.yaml
(Control), config/feature_flags.yaml (T4), config/threshold_experiment.yaml (risk-cap sweep).
`registered_arm_ids()` is the single source of truth the panel builder checks against (T-06).
"""
from __future__ import annotations

import pandas as pd

from src.experiments import threshold as tx
from src.flags.registry import load_registry as load_flags_registry
from src.flags.t4 import select_t4

STATIC_ARM_IDS = ["universe", "control", "riskcap_rejected", "near_miss_rsi", "flip_all"]


def _threshold_registry() -> dict:
    from src.config import load_rule_spec
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    return tx.load_registry(rule_spec=load_rule_spec(str(root / "config" / "rules.yaml")))


def threshold_caps() -> list[float]:
    return [float(c) for c in _threshold_registry()["caps_pct"]]


def threshold_arm_ids() -> list[str]:
    exp = _threshold_registry()["experiment"]
    return [tx.arm_name(c, exp) for c in threshold_caps()]


def t4_k_grid() -> list[int]:
    return list(load_flags_registry()["t4"]["k_grid"])


def t4_arm_ids() -> list[str]:
    return [f"t4_k{k}" for k in t4_k_grid()]


def registered_arm_ids() -> list[str]:
    """Every Lane A arm id this study is allowed to emit — §5.1's registry discipline.
    An arm id not in this list is refused by the panel builder (T-06)."""
    return STATIC_ARM_IDS + t4_arm_ids() + threshold_arm_ids()


def arm_mask(week_df: pd.DataFrame, arm_id: str) -> pd.Series:
    """Boolean mask selecting arm_id's picks within one signal week's eligible-universe
    rows (the flag-matrix replay panel's own row set for that week). Raises for an
    unregistered arm id (T-06)."""
    if arm_id == "universe":
        return pd.Series(True, index=week_df.index)
    if arm_id == "control":
        return week_df["control_status"] == "TRADE"
    if arm_id == "riskcap_rejected":
        return week_df["control_status"] == "SHADOW_rejected_by_risk_cap"
    if arm_id == "near_miss_rsi":
        return week_df["control_status"] == "NEAR_MISS_failed_rsi_band"
    if arm_id == "flip_all":
        return week_df["A01_vstop_flip_up"] == 1

    if arm_id.startswith("t4_k"):
        k = int(arm_id[len("t4_k"):])
        if k not in t4_k_grid():
            raise ValueError(f"unregistered T4 K={k} (not in config/feature_flags.yaml t4.k_grid)")
        registry = load_flags_registry()
        t4cfg = registry["t4"]
        sel = select_t4(week_df, k, max_names=t4cfg["max_names"], tie_break=t4cfg["tie_break"])
        return sel["t4_selected"] == 1

    if arm_id.startswith("threshold-experiment_"):
        caps = threshold_caps()
        cap_label = arm_id[len("threshold-experiment_"):]
        matches = [c for c in caps if tx.cap_label(c) == cap_label]
        if not matches:
            raise ValueError(f"unregistered threshold arm id: {arm_id}")
        cap = matches[0]
        # Mirrors thresh_{cap} per plan §3.1: A01 & A03 & uptrend & R_pct_of_close <= cap
        # (cap_inclusive: true, config/threshold_experiment.yaml). Same boundary rule as
        # src.experiments.threshold.is_selected — reject iff ratio > cap, not >=.
        ratio_ok = week_df["R_pct_of_close"] <= float(cap)
        return ((week_df["A01_vstop_flip_up"] == 1) & (week_df["A03_rsi_in_band"] == 1)
                 & (week_df["uptrend"] == True) & ratio_ok)  # noqa: E712

    raise ValueError(f"unregistered arm id: {arm_id!r} — not in registered_arm_ids()")
