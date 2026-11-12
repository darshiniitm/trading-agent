"""T-12: week-clustered bootstrap on synthetic data with a known lift; BH
ordering; maturity labels at the 12/13/25/26-week boundaries."""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.flags.scorecard import _bh_correction, flag_scorecard, flags_met_rank_ic, maturity_label


def test_maturity_label_boundaries():
    assert maturity_label(12) == "TOO_EARLY"
    assert maturity_label(13) == "FIRST_LOOK"
    assert maturity_label(25) == "FIRST_LOOK"
    assert maturity_label(26) == "REAL_READ"


def _synthetic_ledger(n_weeks=30, n_per_week=10, seed=7):
    rng = np.random.default_rng(seed)
    rows = []
    weeks = pd.date_range("2024-01-01", periods=n_weeks, freq="W-MON")
    for w in range(n_weeks):
        week = str(weeks[w].date())
        for i in range(n_per_week):
            flag_on = i < n_per_week // 2
            noise_flag = rng.random() < 0.5
            # known lift: flag_on names get +2% extra excess return on average
            excess = rng.normal(0.0, 1.0) + (2.0 if flag_on else 0.0)
            rows.append({
                "signal_week": week, "ticker": f"T{i}",
                "KNOWN_LIFT_FLAG": 1 if flag_on else 0,
                "NOISE_FLAG": 1 if noise_flag else 0,
                "flags_met": i, "fwd_ret_oc_net_pct": excess,
                "fwd_excess_vs_eligible_pct": excess,
            })
    return pd.DataFrame(rows)


def test_known_lift_flag_shows_positive_lift_and_significance():
    df = _synthetic_ledger()
    card = flag_scorecard(df, ["KNOWN_LIFT_FLAG", "NOISE_FLAG"])
    known = card[card["flag_id"] == "KNOWN_LIFT_FLAG"].iloc[0]
    assert known["lift_mean"] > 1.0, "known +2% lift should show up strongly positive"
    assert known["lift_ci_lo"] > 0, "CI should exclude zero for a strong, consistent effect"
    assert known["p_value"] < 0.05


def test_bh_correction_orders_by_significance():
    p_values = {"a": 0.001, "b": 0.02, "c": 0.5, "d": None}
    q = _bh_correction(p_values)
    assert q["a"] < q["b"] < q["c"]
    assert q["d"] is None


def test_flags_met_rank_ic_detects_monotonic_relationship():
    rng = np.random.default_rng(3)
    rows = []
    weeks = pd.date_range("2024-01-01", periods=20, freq="W-MON")
    for w in range(20):
        week = str(weeks[w].date())
        for i in range(10):
            fm = i
            excess = fm * 0.3 + rng.normal(0, 0.1)
            rows.append({"signal_week": week, "flags_met": fm, "fwd_excess_vs_eligible_pct": excess})
    df = pd.DataFrame(rows)
    ic = flags_met_rank_ic(df)
    assert ic["mean_ic"] > 0.8
    assert ic["n_weeks"] == 20


def test_scorecard_handles_too_few_weeks_gracefully():
    df = _synthetic_ledger(n_weeks=2)
    card = flag_scorecard(df, ["KNOWN_LIFT_FLAG"])
    assert card.iloc[0]["maturity"] == "TOO_EARLY"
