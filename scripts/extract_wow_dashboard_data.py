"""One-off helper: pull results/wow/*.csv into the JSON blob embedded in
docs/dashboards/wow-trend-dashboard.html. Not part of the wow study itself (that stays
CSV-only per its own read-only discipline) -- this is purely a dashboard-authoring tool,
rerun by hand after `tests.track_wow build && summarise` whenever the dashboard needs a
data refresh. Writes /tmp/wow_dashboard_data.json for the next manual HTML edit.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
WOW = ROOT / "results" / "wow"


def main():
    panel = pd.read_csv(WOW / "arm_week_panel.csv")
    tl = pd.read_csv(WOW / "weekly_three_line.csv")
    tl["signal_week"] = tl["signal_week"].astype(str)
    s = pd.read_csv(WOW / "arm_summary.csv")
    t = pd.read_csv(WOW / "trend_tests.csv")
    p = pd.read_csv(WOW / "paired_vs_control.csv")
    d = pd.read_csv(WOW / "repetition_diagnostics.csv")

    out = {}

    basket_curve = (tl["basket_net_pct"].fillna(0) / 100 + 1).cumprod()
    midcap_curve = (tl["niftymidcap150_wk_pct"] / 100 + 1).cumprod()
    nifty50_curve = (tl["nifty50_wk_pct"] / 100 + 1).cumprod()
    out["three_line"] = {
        "weeks": tl["signal_week"].tolist(),
        "basket": [None if pd.isna(v) else round(v, 3) for v in tl["basket_net_pct"]],
        "midcap": [round(v, 3) for v in tl["niftymidcap150_wk_pct"]],
        "nifty50": [round(v, 3) for v in tl["nifty50_wk_pct"]],
        "vs_midcap": [None if pd.isna(v) else round(v, 3) for v in tl["vs_midcap150_pp"]],
        "basket_curve": [round(v, 4) for v in basket_curve],
        "midcap_curve": [round(v, 4) for v in midcap_curve],
        "nifty50_curve": [round(v, 4) for v in nifty50_curve],
    }

    allA = s[(s["lane"] == "A") & (s["split"] == "all")][
        ["arm", "n_weeks_with_picks", "n_cash_weeks", "mean_net_pct", "win_week_rate",
         "pooled_mean_net_pct_secondary", "equity_final", "max_drawdown_pct"]]
    out["arm_summary_all"] = allA.round(4).to_dict("records")

    out["control_splits"] = s[(s["lane"] == "A") & (s["arm"] == "control")][
        ["split", "n_weeks_with_picks", "mean_net_pct"]].round(4).to_dict("records")

    trend_net = t[(t["basis"] == "net_pct") & (t["lane"].isin(["A", "B"]))][
        ["lane", "arm", "n_weeks_with_picks", "status", "ols_slope", "ols_p", "mk_tau", "mk_p",
         "agree_direction", "half_first_mean", "half_second_mean", "half_diff_mean",
         "half_diff_ci_lo", "half_diff_ci_hi"]]
    out["trend_net"] = trend_net.round(4).to_dict("records")

    paired_net = p[(p["basis"] == "net_pct") & (p["lane"] == "A")][
        ["arm", "n_paired_weeks", "status", "mean_diff", "ci_lo", "ci_hi"]].sort_values(
        "mean_diff", ascending=False)
    out["paired_net"] = paired_net.round(4).to_dict("records")

    flag_pers = d[d["metric_type"] == "flag_persistence_rate"][["key", "value", "n"]].sort_values(
        "value", ascending=False)
    out["flag_persistence"] = flag_pers.round(4).to_dict("records")

    out["autocorr"] = d[d["metric_type"] == "flags_met_autocorrelation"][["key", "value", "n"]].to_dict("records")

    overlap = d[d["metric_type"] == "top10_overlap_pct"][["signal_week", "value"]].dropna()
    out["overlap_series"] = {"weeks": overlap["signal_week"].tolist(), "values": overlap["value"].round(4).tolist()}

    top_decile = d[d["metric_type"] == "top_decile_appearance_count"][["key", "value"]].sort_values(
        "value", ascending=False).head(15)
    out["top_decile"] = top_decile.to_dict("records")

    # lane_c: latest forward week with picks per arm (matches the JS's existing shape).
    lane_c_fwd = panel[(panel["lane"] == "C") & (panel["recording_mode"] == "forward") & (panel["n_picks"] > 0)]
    lane_c = {}
    for arm in ("control_live", "t1_shadow"):
        rows = lane_c_fwd[lane_c_fwd["arm"] == arm].sort_values("signal_week")
        if not rows.empty:
            r = rows.iloc[-1]
            lane_c[arm] = {"signal_week": r["signal_week"], "n_picks": int(r["n_picks"]),
                           "basket_net_pct": r["basket_net_pct"]}
    lane_c["n_weeks_with_picks"] = int(lane_c_fwd[lane_c_fwd["arm"] == "control_live"]["signal_week"].nunique())
    out["lane_c"] = lane_c

    # T1 replay curve, aligned to the Lane A three-line week grid.
    t1_replay = panel[(panel["lane"] == "C") & (panel["arm"] == "t1_shadow")
                       & (panel["recording_mode"] == "replay")].sort_values("signal_week")
    t1_filtered_replay = panel[(panel["lane"] == "C") & (panel["arm"] == "t1_shadow_filtered")
                                & (panel["recording_mode"] == "replay")].sort_values("signal_week")

    weeks = tl["signal_week"].tolist()
    t1_by_week = dict(zip(t1_replay["signal_week"], t1_replay["basket_net_pct"]))
    t1f_by_week = dict(zip(t1_filtered_replay["signal_week"], t1_filtered_replay["basket_net_pct"]))

    last_replay_week = t1_replay["signal_week"].max() if not t1_replay.empty else None
    t1_curve = []
    t1f_curve = []
    factor = 1.0
    factor_f = 1.0
    for wk in weeks:
        if last_replay_week is not None and wk > last_replay_week:
            # Backfill hasn't reached this week yet -- null, not a flat/neutral line,
            # so the chart stops rather than implying a computed (zero) return.
            t1_curve.append(None)
            t1f_curve.append(None)
            continue
        v = t1_by_week.get(wk)
        factor *= (1 + (v or 0.0) / 100)
        t1_curve.append(round(factor, 4))
        vf = t1f_by_week.get(wk)
        factor_f *= (1 + (vf or 0.0) / 100)
        t1f_curve.append(round(factor_f, 4))

    out["t1_replay_curve"] = t1_curve
    out["t1_replay_filtered_curve"] = t1f_curve
    out["t1_replay_n_weeks"] = int(len(t1_replay))

    # Lane C forward (live) single point(s), for the still-isolated marker.
    lane_c_forward = panel[(panel["lane"] == "C") & (panel["arm"] == "t1_shadow")
                            & (panel["recording_mode"] == "forward") & (panel["n_picks"] > 0)]
    out["lane_c_forward"] = lane_c_forward[["signal_week", "n_picks", "basket_net_pct"]].to_dict("records")

    # Dev-backtest cross-lane comparison, if it exists.
    dev_path = WOW / "t1_replay_vs_control_replay.csv"
    if dev_path.exists():
        dev = pd.read_csv(dev_path)
        out["t1_replay_vs_control"] = dev.where(pd.notna(dev), None).to_dict("records")
    else:
        out["t1_replay_vs_control"] = []

    # Trend tests for t1_shadow / t1_shadow_filtered, mode=replay.
    trend_path = WOW / "trend_tests.csv"
    if trend_path.exists():
        trend = pd.read_csv(trend_path)
        t1_trend = trend[(trend["lane"] == "C") & (trend["recording_mode"] == "replay")
                          & (trend["arm"].isin(["t1_shadow", "t1_shadow_filtered"]))]
        out["t1_replay_trend"] = t1_trend.where(pd.notna(t1_trend), None).to_dict("records")
    else:
        out["t1_replay_trend"] = []

    out_path = Path("/tmp/wow_dashboard_data.json")
    out_path.write_text(json.dumps(out, default=str))
    print(f"wrote {out_path} ({len(json.dumps(out))} bytes)")
    print(f"t1_replay_n_weeks={out['t1_replay_n_weeks']}")


if __name__ == "__main__":
    main()
