"""T-11: deterministic tie-break; A02/A04 hard requirement; zero-pick week -> 0.0 in paired series."""
from __future__ import annotations

import pandas as pd

from src.flags.t4 import select_t4, t4_vs_control_series, t4_weekly_basket_net


def _row(ticker, a02, a04, flags_met, turnover, ret=1.0):
    return {"ticker": ticker, "A02_vstop_uptrend": a02, "A04_risk_cap_ok": a04,
            "flags_met": flags_met, "median_weekly_turnover_cr": turnover,
            "fwd_ret_control_exit_net_pct": ret}


def test_a02_a04_hard_requirement_excludes_downtrend_and_risk_reject():
    df = pd.DataFrame([
        _row("A.NS", 1, 1, 9, 50),
        _row("B.NS", 0, 1, 12, 50),   # downtrend -> excluded even with high flags_met
        _row("C.NS", 1, 0, 12, 50),   # risk-cap fail -> excluded
    ])
    out = select_t4(df, k=5, max_names=10)
    assert set(out.loc[out["t4_selected"] == 1, "ticker"]) == {"A.NS"}


def test_tie_break_flags_met_desc_then_turnover_desc_then_ticker_asc():
    df = pd.DataFrame([
        _row("Z.NS", 1, 1, 8, 100),
        _row("A.NS", 1, 1, 8, 100),  # tie with Z on flags_met and turnover -> ticker asc wins
        _row("B.NS", 1, 1, 8, 200),  # higher turnover, same flags_met -> ranks above A/Z
        _row("C.NS", 1, 1, 9, 10),   # highest flags_met -> ranks first
    ])
    out = select_t4(df, k=5, max_names=10)
    ranked = out[out["t4_selected"] == 1].sort_values("t4_rank")
    assert list(ranked["ticker"]) == ["C.NS", "B.NS", "A.NS", "Z.NS"]


def test_max_names_caps_selection():
    df = pd.DataFrame([_row(f"T{i}.NS", 1, 1, 10, i) for i in range(15)])
    out = select_t4(df, k=5, max_names=10)
    assert (out["t4_selected"] == 1).sum() == 10


def test_below_k_excluded():
    df = pd.DataFrame([_row("A.NS", 1, 1, 4, 50)])
    out = select_t4(df, k=5, max_names=10)
    assert (out["t4_selected"] == 1).sum() == 0


def test_zero_pick_week_returns_zero_not_dropped():
    df = pd.DataFrame([_row("A.NS", 0, 1, 12, 50)])  # A02=0, no candidate qualifies
    sel = select_t4(df, k=5, max_names=10)
    assert t4_weekly_basket_net(sel) == 0.0


def test_t4_vs_control_series_pairs_by_week_and_never_drops_zero_pick_weeks():
    rows = []
    # week 1: no T4 candidates (A02=0), Control has a trade
    rows.append({"signal_week": "2026-01-05", "ticker": "A.NS", "A02_vstop_uptrend": 0, "A04_risk_cap_ok": 1,
                 "flags_met": 12, "median_weekly_turnover_cr": 50, "fwd_ret_control_exit_net_pct": -3.0,
                 "control_status": "TRADE", "fwd_ret_oc_net_pct": -3.0, "recording_mode": "replay"})
    # week 2: T4 has one pick, no Control trade that week
    rows.append({"signal_week": "2026-01-12", "ticker": "B.NS", "A02_vstop_uptrend": 1, "A04_risk_cap_ok": 1,
                 "flags_met": 12, "median_weekly_turnover_cr": 50, "fwd_ret_control_exit_net_pct": 2.0,
                 "control_status": "NONE", "fwd_ret_oc_net_pct": 2.0, "recording_mode": "replay"})
    df = pd.DataFrame(rows)
    series = t4_vs_control_series(df, k=5, max_names=10)
    assert len(series) == 2
    wk1 = series[series["signal_week"] == "2026-01-05"].iloc[0]
    assert wk1["t4_n"] == 0 and wk1["t4_net_pct"] == 0.0
    assert wk1["control_n"] == 1 and wk1["control_net_pct"] == -3.0
    wk2 = series[series["signal_week"] == "2026-01-12"].iloc[0]
    assert wk2["t4_n"] == 1 and wk2["t4_net_pct"] == 2.0
    assert wk2["control_n"] == 0 and wk2["control_net_pct"] == 0.0
