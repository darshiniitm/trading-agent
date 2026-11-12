"""
Week-over-week arm history study. Spec: docs/wow-arm-history-analysis-plan.md.
Read-only over results/feature_flags/, results/forward_test/, results/experiments/
(§6.3) — the one write outside results/wow/ is the NIFTY 50 fetch into data_cache/,
scoped to a reporting series only (never enters an arm filter/gate/score).

usage:
  python3 -m tests.track_wow build         # panel + three-line series + manifest
  python3 -m tests.track_wow summarise     # arm_summary.csv + trend_tests.csv
  python3 -m tests.track_wow diagnostics   # repetition_diagnostics.csv (§4.4)
  python3 -m tests.track_wow verify        # re-run build, assert byte-identical panel
"""
from __future__ import annotations

import filecmp
import json
import sys
import tempfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "results" / "wow"
SEED = 42


def build(out_dir: Path = OUT) -> dict:
    from src.config import load_rule_spec
    from src.wow.panel import load_replay_panel, build_lane_a_panel, build_lane_b_panel, build_lane_c_panel
    from src.wow.three_line import fetch_nifty50_into_cache, build_weekly_three_line, NIFTY50_TICKER
    from src.wow.manifest import build_manifest
    from tests.offline import env as offline_env

    out_dir.mkdir(parents=True, exist_ok=True)
    rule_spec = load_rule_spec(str(ROOT / "config" / "rules.yaml"))

    print("Fetching NIFTY 50 (^NSEI) — the one write this study makes outside results/wow/...")
    nifty50_source = fetch_nifty50_into_cache(rule_spec)
    print(f"  {nifty50_source}")

    print("Loading Lane A replay panel (results/feature_flags/replay/)...")
    replay_df = load_replay_panel()
    print(f"  {len(replay_df)} rows, {replay_df['signal_week'].nunique()} weeks")

    print("Building Lane A arm-week panel...")
    lane_a = build_lane_a_panel(replay_df)
    print(f"  {len(lane_a)} (arm, week) rows across {lane_a['arm'].nunique()} arms")

    print("Building Lane B arm-week panel (V2/V3/V4, isolated)...")
    lane_b = build_lane_b_panel()
    print(f"  {len(lane_b)} (arm, week) rows")

    print("Building Lane C arm-week panel (live forward test, append-only)...")
    lane_c = build_lane_c_panel()
    print(f"  {len(lane_c)} (arm, week) rows")

    panel = pd.concat([lane_a, lane_b, lane_c], ignore_index=True)
    panel = panel.sort_values(["lane", "arm", "signal_week"]).reset_index(drop=True)
    panel_path = out_dir / "arm_week_panel.csv"
    panel.to_csv(panel_path, index=False)
    print(f"wrote {panel_path} ({len(panel)} rows)")

    print("Building the three-line weekly series (Control vs NIFTY50 vs NIFTYMIDCAP150)...")
    _, adapter, _, _, _ = offline_env()
    nifty50_panel = adapter.weekly_ohlcv([NIFTY50_TICKER], rule_spec["data"]["history_weeks"]).get(NIFTY50_TICKER)
    if nifty50_panel is None or nifty50_panel.empty:
        raise RuntimeError(f"{NIFTY50_TICKER} not found in the offline cache after fetch — build aborted")
    three_line = build_weekly_three_line(replay_df, nifty50_panel)
    three_line_path = out_dir / "weekly_three_line.csv"
    three_line.to_csv(three_line_path, index=False)
    print(f"wrote {three_line_path} ({len(three_line)} weeks)")

    manifest = build_manifest(SEED, nifty50_source)
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str))
    print(f"wrote {manifest_path}")

    return {"panel_rows": len(panel), "three_line_weeks": len(three_line)}


def summarise(out_dir: Path = OUT) -> dict:
    from src.wow.summarise import (arm_summary, trend_tests, paired_vs_control, pooled_means_lane_a,
                                    paired_t1_replay_vs_control_replay)
    from src.wow.panel import load_replay_panel
    from src.wow.arms import registered_arm_ids

    panel_path = out_dir / "arm_week_panel.csv"
    if not panel_path.exists():
        print("no arm_week_panel.csv — run `build` first")
        return {}
    panel = pd.read_csv(panel_path)

    frames_summary, frames_trend, frames_paired = [], [], []
    for lane in ("A", "B"):
        if not (panel["lane"] == lane).any():
            continue
        s = arm_summary(panel, lane)
        if lane == "A":
            replay_df = load_replay_panel()
            pooled = pooled_means_lane_a(replay_df, registered_arm_ids())
            for basis in ("net_pct", "excess_eligible_pp", "excess_bench_pp"):
                mask = s["split"] == "all"
                s.loc[mask, f"pooled_mean_{basis}_secondary"] = s.loc[mask, "arm"].map(
                    lambda a: pooled.get(a, {}).get(basis))
        frames_summary.append(s)
        frames_trend.append(trend_tests(panel, lane))
        if lane == "A":
            frames_paired.append(paired_vs_control(panel, lane, control_arm="control"))

    # Lane C: t1_shadow now carries two recording_modes under one arm id -- 'replay'
    # (T1's 104-week historical backtest, dev evidence) and 'forward' (the real, live
    # weeks). Never blend them into one series (mode-segmented trend tests below); the
    # graduation-track comparison stays forward-only and stays suppressed below
    # MIN_PAIRED_WEEKS=13 (currently true: 1 live forward week) -- §5.4. Not added to
    # arm_summary (its equity-curve/drawdown machinery assumes one continuous series per
    # arm, which a replay+forward blend would misrepresent).
    if (panel["lane"] == "C").any():
        frames_trend.append(trend_tests(panel, "C", mode="replay"))
        frames_trend.append(trend_tests(panel, "C", mode="forward"))
        frames_paired.append(paired_vs_control(panel, "C", control_arm="control_live", mode="forward"))

    arm_summary_df = pd.concat(frames_summary, ignore_index=True)
    trend_df = pd.concat(frames_trend, ignore_index=True)
    paired_df = pd.concat(frames_paired, ignore_index=True) if frames_paired else pd.DataFrame()

    arm_summary_df.to_csv(out_dir / "arm_summary.csv", index=False)
    trend_df.to_csv(out_dir / "trend_tests.csv", index=False)
    if not paired_df.empty:
        paired_df.to_csv(out_dir / "paired_vs_control.csv", index=False)

    # T1 replay vs. Control's own replay -- a real 104-week dev-backtest read, but a
    # SEPARATE, distinctly-named/output cross-lane comparison so it can never be mistaken
    # for the forward-only, graduation-track number above.
    if (panel["lane"] == "C").any() and (panel["lane"] == "A").any():
        dev_df = paired_t1_replay_vs_control_replay(panel)
        if not dev_df.empty:
            dev_df.to_csv(out_dir / "t1_replay_vs_control_replay.csv", index=False)
            print(f"wrote t1_replay_vs_control_replay.csv ({len(dev_df)} rows) — "
                  f"DEV-BACKTEST ONLY, not forward evidence")

    print(f"wrote arm_summary.csv ({len(arm_summary_df)} rows), trend_tests.csv ({len(trend_df)} rows), "
          f"paired_vs_control.csv ({len(paired_df)} rows)")
    print()
    print("Trend tests, split='all' only, arms with >=26 weeks-with-picks:")
    ok = trend_df[(trend_df["status"] == "ok")]
    if ok.empty:
        print("  none — every Lane A/B arm is below the 26-week floor")
    else:
        for _, r in ok.iterrows():
            agree = "agree" if r["agree_direction"] else "DISAGREE"
            print(f"  {r['lane']}/{r['arm']:<28} {r['basis']:<18} OLS slope={r['ols_slope']:+.5f} "
                  f"(p={r['ols_p']:.3f})  MK tau={r['mk_tau']:+.3f} (p={r['mk_p']:.3f})  [{agree}]")
    return {"arm_summary_rows": len(arm_summary_df), "trend_rows": len(trend_df)}


def diagnostics(out_dir: Path = OUT) -> dict:
    from src.wow.panel import load_replay_panel
    from src.wow.diagnostics import (add_delta_flags_met, top10_overlap_series, per_flag_persistence,
                                      flags_met_autocorrelation, distinct_tickers_trailing,
                                      top_decile_appearance_counts)
    from src.wow.arms import arm_mask

    replay_df = load_replay_panel()
    replay_df = add_delta_flags_met(replay_df)

    rows = []
    overlap = top10_overlap_series(replay_df)
    for _, r in overlap.iterrows():
        rows.append({"metric_type": "top10_overlap_pct", "signal_week": r["signal_week"],
                     "key": None, "value": r["overlap_pct"], "n": r["overlap_n"]})

    persistence = per_flag_persistence(replay_df)
    for _, r in persistence.iterrows():
        rows.append({"metric_type": "flag_persistence_rate", "signal_week": None, "key": r["flag_id"],
                     "value": r["persistence_rate"], "n": r["n_ticker_weeks_on_last_week"]})

    ac = flags_met_autocorrelation(replay_df, lag=1)
    rows.append({"metric_type": "flags_met_autocorrelation", "signal_week": None,
                 "key": f"lag{ac['lag']}", "value": ac["autocorr"], "n": ac["n"]})

    trailing = distinct_tickers_trailing(replay_df, arm_mask, "control", window=13)
    for _, r in trailing.iterrows():
        rows.append({"metric_type": "distinct_tickers_trailing13_control", "signal_week": r["signal_week"],
                     "key": "control", "value": r["distinct_tickers"], "n": r["n_weeks_in_window"]})
    trailing_flip = distinct_tickers_trailing(replay_df, arm_mask, "flip_all", window=13)
    for _, r in trailing_flip.iterrows():
        rows.append({"metric_type": "distinct_tickers_trailing13_flip_all", "signal_week": r["signal_week"],
                     "key": "flip_all", "value": r["distinct_tickers"], "n": r["n_weeks_in_window"]})

    top_decile = top_decile_appearance_counts(replay_df)
    for _, r in top_decile.iterrows():
        rows.append({"metric_type": "top_decile_appearance_count", "signal_week": None,
                     "key": r["ticker"], "value": r["top_decile_weeks"], "n": None})

    df = pd.DataFrame(rows)
    path = out_dir / "repetition_diagnostics.csv"
    df.to_csv(path, index=False)
    print(f"wrote {path} ({len(df)} rows)")

    mean_overlap = overlap["overlap_pct"].dropna().mean()
    print(f"  top-10-by-flags_met week-over-week overlap: mean {mean_overlap:.1%} across {overlap['overlap_pct'].notna().sum()} weeks")
    print(f"  flags_met lag-1 autocorrelation: {ac['autocorr']} (n={ac['n']})")
    persistent = persistence[persistence["persistence_rate"] >= 0.7]
    print(f"  {len(persistent)}/{len(persistence)} countable flags have >=70% week-over-week persistence")
    return {"rows": len(df)}


def verify(out_dir: Path = OUT) -> bool:
    panel_path = out_dir / "arm_week_panel.csv"
    if not panel_path.exists():
        print("no arm_week_panel.csv to verify against — run `build` first")
        return False
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        build(tmp_dir)
        ok = filecmp.cmp(panel_path, tmp_dir / "arm_week_panel.csv", shallow=False)
        print(f"verify: arm_week_panel.csv byte-identical: {ok}")
        return ok


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "build":
        build()
    elif cmd == "summarise":
        summarise()
    elif cmd == "diagnostics":
        diagnostics()
    elif cmd == "verify":
        sys.exit(0 if verify() else 1)
    else:
        print(__doc__)
