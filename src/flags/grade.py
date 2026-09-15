"""
Grade a recorded flags_<wk>.csv against the following week's forward bar
(docs/feature-flag-matrix-plan.md §6.3). Reuses tests/track_forward.py's
`_grade_rows` for the gap-stop-aware Control-style exit — no second
implementation of the exit rule (G2's spirit applied to grading too).

Writes a SEPARATE file (`flags_<wk>_graded.csv`); the record CSV itself is
never mutated (G6).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from tests.track_forward import _grade_rows

COST_PCT_ROUND_TRIP = 0.005


def _next_week_bar(panel: pd.DataFrame, as_of: pd.Timestamp):
    if panel is None:
        return None
    nxt = panel[panel["date"] > as_of].sort_values("date")
    if nxt.empty:
        return None
    return nxt.iloc[0]


def grade_matrix(df: pd.DataFrame, rule_spec: dict, adapter, panels: dict, as_of: pd.Timestamp) -> tuple[pd.DataFrame, dict]:
    evaluable = df[df["eligible_reason"].isna()].copy()
    cost = rule_spec["validation"]["costs_pct_round_trip"] / 100

    control_style_rows = []
    for _, r in evaluable.iterrows():
        sl = r["vstop_line"] if bool(r["uptrend"]) else None
        control_style_rows.append({"ticker": r["ticker"], "vstop_line_SL": sl})
    graded_control, missing_control = _grade_rows(control_style_rows, panels, as_of, cost)
    control_by_ticker = {g["ticker"]: g for g in graded_control}

    out_rows = []
    missing_forward = []
    for _, r in evaluable.iterrows():
        ticker = r["ticker"]
        bar = _next_week_bar(panels.get(ticker), as_of)
        row = r.to_dict()
        if bar is None:
            missing_forward.append(ticker)
            row.update({"EP_actual": None, "week_open": None, "week_high": None, "week_low": None,
                        "week_close": None, "exit_reason": None, "exit_price": None,
                        "fwd_ret_oc_net_pct": None, "fwd_ret_control_exit_net_pct": None,
                        "fwd_excess_vs_eligible_pct": None, "fwd_excess_vs_benchmark_pct": None,
                        "graded_utc": None, "missing_forward_bar": 1})
            out_rows.append(row)
            continue

        EP = float(bar["open"])
        oc_ret_net = (float(bar["close"]) - EP) / EP - cost
        ctrl = control_by_ticker.get(ticker)

        row.update({
            "EP_actual": round(EP, 4), "week_open": round(EP, 4),
            "week_high": round(float(bar["high"]), 4), "week_low": round(float(bar["low"]), 4),
            "week_close": round(float(bar["close"]), 4),
            "exit_reason": ctrl["exit_reason"] if ctrl else "week_close",
            "exit_price": ctrl["exit_price"] if ctrl else round(float(bar["close"]), 4),
            "fwd_ret_oc_net_pct": round(oc_ret_net * 100, 3),
            "fwd_ret_control_exit_net_pct": ctrl["ret_pct_net"] if ctrl else None,
            "graded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "missing_forward_bar": 0,
        })
        out_rows.append(row)

    graded_df = pd.DataFrame(out_rows)

    eligible_mean = None
    if not graded_df.empty and graded_df["fwd_ret_oc_net_pct"].notna().any():
        eligible_mean = float(graded_df["fwd_ret_oc_net_pct"].dropna().mean())
        graded_df["fwd_excess_vs_eligible_pct"] = graded_df["fwd_ret_oc_net_pct"] - eligible_mean
        graded_df["fwd_excess_vs_eligible_pct"] = graded_df["fwd_excess_vs_eligible_pct"].round(3)

    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])
    bench_ret = None
    if not bench.empty:
        b_bar = _next_week_bar(bench, as_of)
        if b_bar is not None:
            bo, bc = float(b_bar["open"]), float(b_bar["close"])
            bench_ret = (bc - bo) / bo * 100
    if bench_ret is not None and not graded_df.empty:
        graded_df["fwd_excess_vs_benchmark_pct"] = (graded_df["fwd_ret_oc_net_pct"] - bench_ret).round(3)

    control_trades = graded_df[graded_df["control_status"] == "TRADE"] if not graded_df.empty else graded_df
    t4_rows = graded_df[graded_df["t4_selected"] == 1] if not graded_df.empty and "t4_selected" in graded_df else graded_df.iloc[0:0]

    summary = {
        "graded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signal_week": str(as_of.date()),
        "n_rows": len(graded_df),
        "n_missing_forward_bar": len(missing_forward),
        "eligible_mean_fwd_ret_oc_net_pct": round(eligible_mean, 3) if eligible_mean is not None else None,
        "benchmark_week_pct": round(bench_ret, 3) if bench_ret is not None else None,
        "control_basket_net_pct": (round(float(control_trades["fwd_ret_control_exit_net_pct"].dropna().mean()), 3)
                                    if len(control_trades) and control_trades["fwd_ret_control_exit_net_pct"].notna().any()
                                    else None),
        "t4_basket_net_pct": (round(float(t4_rows["fwd_ret_control_exit_net_pct"].dropna().mean()), 3)
                               if len(t4_rows) and t4_rows["fwd_ret_control_exit_net_pct"].notna().any() else None),
        "counts_by_flags_met": (graded_df["flags_met"].value_counts().sort_index().astype(int).to_dict()
                                 if not graded_df.empty else {}),
    }
    return graded_df, summary


def append_ledger(path: Path, rows: list[dict], key_fields: tuple[str, ...]) -> None:
    """Append-only ledger; a duplicate key raises (T-13)."""
    existing = pd.read_csv(path) if path.exists() else pd.DataFrame()
    if not existing.empty:
        existing_keys = set(existing[list(key_fields)].apply(tuple, axis=1))
        for r in rows:
            k = tuple(r[f] for f in key_fields)
            if k in existing_keys:
                raise ValueError(f"duplicate ledger key {k} in {path}")
    new = pd.DataFrame(rows)
    combined = pd.concat([existing, new], ignore_index=True) if not existing.empty else new
    combined.to_csv(path, index=False)
