"""
Forward test: record this week's picks, grade them next week.

A forward test is only evidence if the prediction is written down BEFORE the
outcome exists. This script does two things and nothing else:

  record  — freeze the current screen's picks + the exit rule + the prior
  grade   — once next week's bar exists, score the frozen record against it

The record is never edited after `record`. If the rule needs changing, that
starts a NEW record; it does not amend an old one.

Alongside the actual picks, each record also captures "near-misses" —
tickers that fired the VStop trend signal but were filtered out by a later
condition (e.g. RSI band) and so never became a pick. These are graded the
same way but kept in a separate `near_miss` list/summary, so the traded and
shadow-rejected baskets aren't diluted by them. See
docs/forward_test_findings.md for what this has turned up so far.

usage:
  python3 -m tests.track_forward record
  python3 -m tests.track_forward grade results/forward_test/picks_2026-08-24.json
  python3 -m tests.track_forward t1
  python3 -m tests.track_forward t1grade results/forward_test/picks_2026-08-24_t1.json
  python3 -m tests.track_forward t1replay 2024-09-09 2026-08-31   # one-time historical backfill
"""
from __future__ import annotations

import glob
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from src.backtest.harness import bootstrap_ci, confidence_rank_ic
from src.data.holding_week import corrected_week_bar
from src.screen.candidate_score import compute_candidate_score, score_row as _score_row
from src.screen.daily_scale import daily_rule_spec
from src.screen.engine import run_screen, compute_features_for_ticker, _slice_as_of
from src.screen.t1_scan import T1_SCORE_FILTER_THRESHOLD, scan_t1_week
from src.trade.builder import build_trades, _rsi_band_bounds
from tests.offline import env, all_dates

OUT = Path(__file__).resolve().parents[1] / "results" / "forward_test"

# Pre-registered prior, from the 104-week walk-forward (see vstop-test-results doc).
PRIOR = {
    "source": "104-week walk-forward, 244 trades, net of 0.5% round trip",
    "expected_return_per_trade_pct": -1.37,
    "expected_basket_return_pct": -1.81,
    "prob_week_positive": 0.272,
    "hit_rate": 0.357,
    "note": "A single week has almost no statistical power. This record accumulates; "
            "it does not adjudicate. Do not update beliefs on one week either way.",
}

EXIT_RULE = {
    "entry": "open of the first trading day of the following week",
    "exit": "that week's close, unless the intraweek low <= SL, in which case SL",
    "gap_caveat": "if the week OPENS below SL the honest fill is the open, not SL (defect D1)",
    "costs_pct_round_trip": 0.5,
    "horizon": "fixed 1 week",
}

# Decided 26 Sep 2026 (docs/literal-spec-plan.md, decision 2): keep recording Control
# for 4-6 weeks alongside the new Literal series (config/rules_literal.yaml), then stop.
# last_recording_week is provisional -- Dharmin still needs to confirm the exact final
# week; this only WARNS past that date, it never blocks record() (mirrors
# src/data/segments.py's assert_allowed pattern, but non-fatal -- a human, not a test,
# makes the actual stop-recording call).
CONTROL_WIND_DOWN = {
    "last_recording_week": "2026-10-23",  # provisional: ~4 weeks after Literal's first record (2 Oct)
    "decided": "2026-09-26",
    "reason": "Proceeding with the Literal-brief spec per Dharmin's decision, even though it "
              "means winding down Control -- see docs/literal-spec-plan.md decision 2. The "
              "threshold experiment and T4 flag-matrix arm (both derived solely from Control's "
              "weekly picks file) will not reach their forward-week statistical gate as a "
              "consequence; see docs/forward_test_findings.md, 2026-09-26 entry.",
}


def record():
    rule_spec, adapter, uni, panels, shares = env()
    dates = all_dates(panels)
    as_of = dates[-1]
    if str(as_of.date()) > CONTROL_WIND_DOWN["last_recording_week"]:
        print(f"NOTE: this signal week ({as_of.date()}) is past Control's agreed wind-down "
              f"date ({CONTROL_WIND_DOWN['last_recording_week']}, decided "
              f"{CONTROL_WIND_DOWN['decided']}). Recording anyway -- this is a loud warning, "
              f"not a block; confirm with Dharmin whether Control recording should actually "
              f"continue before treating this week's record as intended.")

    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    survivors = res["survivors"]
    near_miss = res["near_miss"]
    trades = build_trades(survivors, rule_spec)
    taken = set(trades["ticker"]) if not trades.empty else set()

    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"],
                                     rule_spec["data"]["history_weeks"])
    bench_close = None
    if not bench.empty:
        b = bench[bench["date"] <= as_of]
        if not b.empty:
            bench_close = float(b["close"].iloc[-1])

    rsi_band = _rsi_band_bounds(rule_spec)
    primary_lb = rule_spec["sector"]["rs_lookbacks_weeks"][0]
    rs_col = f"rs_{primary_lb}w"

    rows = []
    for _, s in survivors.iterrows():
        tk = s["ticker"]
        tr = trades[trades["ticker"] == tk].iloc[0] if tk in taken else None
        R = float(s["close"]) - float(s["vstop_line"])
        row = {
            "ticker": tk,
            "name": s.get("name"),
            "sector": s.get("sector"),
            "status": "TRADE" if tk in taken else "SHADOW_rejected_by_risk_cap",
            "signal_close": round(float(s["close"]), 4),
            "vstop_line_SL": round(float(s["vstop_line"]), 4),
            "rsi": round(float(s["rsi"]), 3),
            "atr": round(float(s["atr"]), 4) if pd.notna(s.get("atr")) else None,
            "volume": float(s["volume"]) if pd.notna(s.get("volume")) else None,
            "avg_vol_8w": float(s["avg_vol_8w"]) if pd.notna(s.get("avg_vol_8w")) else None,
            "mktcap_cr": round(float(s["mktcap_cr"]), 1),
            "turnover_cr": round(float(s["median_weekly_turnover_cr"]), 2),
            "R_ref": round(R, 4),
            "R_pct_of_close": round(R / float(s["close"]) * 100, 3),
            "target_ref": round(float(tr["target"]), 4) if tr is not None else None,
            "confidence": float(tr["confidence"]) if tr is not None else None,
            "EP": "PENDING — next week's open",
        }
        row.update(_score_row(row, rule_spec, rsi_band, s.get(rs_col)))
        rows.append(row)

    near_rows = []
    for _, s in near_miss.iterrows():
        R = float(s["close"]) - float(s["vstop_line"]) if pd.notna(s.get("vstop_line")) else None
        near_row = {
            "ticker": s["ticker"],
            "name": s.get("name"),
            "sector": s.get("sector"),
            "status": f"NEAR_MISS_failed_{'+'.join(s['failed_signals'])}",
            "signal_close": round(float(s["close"]), 4),
            "vstop_line_SL": round(float(s["vstop_line"]), 4) if pd.notna(s.get("vstop_line")) else None,
            "rsi": round(float(s["rsi"]), 3) if pd.notna(s.get("rsi")) else None,
            "atr": round(float(s["atr"]), 4) if pd.notna(s.get("atr")) else None,
            "volume": float(s["volume"]) if pd.notna(s.get("volume")) else None,
            "avg_vol_8w": float(s["avg_vol_8w"]) if pd.notna(s.get("avg_vol_8w")) else None,
            "mktcap_cr": round(float(s["mktcap_cr"]), 1),
            "turnover_cr": round(float(s["median_weekly_turnover_cr"]), 2),
            "R_ref": round(R, 4) if R is not None else None,
            "R_pct_of_close": round(R / float(s["close"]) * 100, 3) if R is not None else None,
            "target_ref": None,
            "confidence": None,
            "EP": "PENDING — next week's open",
        }
        # near-miss rows aren't in survivors_df, so they never got the sector-RS merge; look it up separately.
        rs_val = None
        sec_rs = res["sector_rs"]
        if s.get("sector") in set(sec_rs.get("sector", [])):
            match = sec_rs[sec_rs["sector"] == s["sector"]]
            if not match.empty and rs_col in match.columns:
                rs_val = match.iloc[0][rs_col]
        near_row.update(_score_row(near_row, rule_spec, rsi_band, rs_val))
        near_rows.append(near_row)

    rec = {
        "record_id": f"fwd_{as_of.date()}",
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signal_week_start": str(as_of.date()),
        "signal_week_note": "weekly bar Mon..Fri; signal is that Friday's close",
        "grade_after": str((as_of + pd.Timedelta(weeks=1)).date()),
        "strategy": {
            "market_cap_cr": rule_spec["universe"]["market_cap_cr"],
            "liquidity_min_cr": rule_spec["universe"]["liquidity"]["min"],
            "vstop": "VStop(10, 2.0) weekly, flip_up == True",
            "rsi": "RSI(14) weekly, 50 <= value <= 65",
            "max_r_pct": rule_spec["trade"]["max_r_pct"],
        },
        "exit_rule": EXIT_RULE,
        "prior": PRIOR,
        "funnel": {k: int(v) for k, v in zip(res["funnel"]["stage"], res["funnel"]["count"])},
        "benchmark_ticker": rule_spec["sector"]["benchmark_ticker"],
        "benchmark_close_at_signal": bench_close,
        "n_survivors": int(len(survivors)),
        "n_trades": int(len(trades)),
        "picks": rows,
        "near_miss": near_rows,
        "graded": None,
    }

    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f"picks_{as_of.date()}.json"
    if p.exists():
        print(f"REFUSING to overwrite an existing record: {p}")
        print("A forward record is immutable. Delete it deliberately if you truly mean to re-record.")
        return
    p.write_text(json.dumps(rec, indent=2))
    pd.DataFrame(rows).to_csv(OUT / f"picks_{as_of.date()}.csv", index=False)
    if near_rows:
        pd.DataFrame(near_rows).to_csv(OUT / f"picks_{as_of.date()}_near_miss.csv", index=False)
    print(f"recorded {len(rows)} picks ({len(trades)} tradeable), {len(near_rows)} near-misses -> {p}")
    print(json.dumps(rec["funnel"], indent=1))
    for r in rows:
        print(f"  {r['status']:28s} {r['ticker']:15s} SL={r['vstop_line_SL']:>10} "
              f"RSI={r['rsi']:>6} R={r['R_pct_of_close']:>6}%")
    for r in near_rows:
        print(f"  {r['status']:28s} {r['ticker']:15s} SL={r['vstop_line_SL']:>10} "
              f"RSI={r['rsi']:>6} R={r['R_pct_of_close']:>6}%")


def _grade_rows(rows, panels, as_of, cost, daily_panels=None, entry_price_source="next_week_open"):
    """Apply the pre-registered exit rule to a list of pick/near-miss dicts.
    Rows lacking a usable SL (near-misses with no vstop_line) still exit on
    the fixed week-close horizon; the stop-hit / gap-stop paths just never
    trigger for them.

    D7: pass `daily_panels` (ticker -> daily OHLCV, e.g. adapter.daily_ohlcv()) to fill
    EP/low/close from the holding week's own daily sessions instead of the weekly bar,
    which reports the previous Friday's close as the open in a week whose Monday is an
    NSE holiday. Without daily_panels (or when a ticker/week isn't covered) this grades
    exactly as before the fix -- see src/data/holding_week.py.

    entry_price_source: "next_week_open" (Control, default) uses the following week's
    (corrected) open as EP -- the row's own recorded EP is a placeholder until this runs.
    "signal_close" (Literal spec) instead treats the row's own `signal_close` as the real,
    already-fixed EP (decided 26 Sep 2026, per the brief's literal reading); the following
    week's open is still read and reported as `next_week_open_check`, an informational
    fill-price check never used in the return/R-multiple calculation."""
    out, missing = [], []
    for row in rows:
        p = panels.get(row["ticker"])
        if p is None:
            missing.append(row["ticker"]); continue
        nxt = p[p["date"] > as_of].sort_values("date")
        if nxt.empty:
            missing.append(row["ticker"]); continue
        n = nxt.iloc[0]
        week_start = pd.Timestamp(n["date"])
        bar = corrected_week_bar(row["ticker"], daily_panels, week_start,
                                  float(n["open"]), float(n["low"]), float(n["close"]))
        next_week_open, week_low, week_close = bar["open"], bar["low"], bar["close"]
        if entry_price_source == "signal_close":
            EP = float(row["signal_close"])
        else:
            EP = next_week_open
        SL = float(row["vstop_line_SL"]) if row.get("vstop_line_SL") is not None else None
        # The gap/stop-hit checks are real-market-open events (did the following week's
        # own open or low breach SL) -- always checked against next_week_open, never
        # against EP. In "next_week_open" mode EP == next_week_open so this is unchanged
        # from before; in "signal_close" mode EP is fixed at the (always-above-SL) signal
        # close, so checking EP here would silently never detect a real opening gap.
        if SL is not None and next_week_open <= SL:
            exit_px, reason = next_week_open, "gap_stop_at_open"
        elif SL is not None and week_low <= SL:
            exit_px, reason = SL, "stop_hit"
        else:
            exit_px, reason = week_close, "week_close"
        ret = (exit_px - EP) / EP
        graded = {**row, "exit_week": str(pd.Timestamp(n["date"]).date()),
                  "EP_actual": round(EP, 4), "week_low": round(week_low, 4),
                  "week_close": round(week_close, 4), "ep_source": bar["source"],
                  "exit_reason": reason, "exit_price": round(exit_px, 4),
                  "ret_pct": round(ret * 100, 3),
                  "ret_pct_net": round((ret - cost) * 100, 3),
                  "r_multiple": round((exit_px - EP) / (EP - SL), 3) if SL is not None and EP > SL else None}
        if entry_price_source == "signal_close":
            graded["next_week_open_check"] = round(next_week_open, 4)
        out.append(graded)
    return out, missing


def _weighted_basket_return(traded: pd.DataFrame, weight_col: str, positive_only: bool = False) -> float | None:
    """T2/T3: re-weight Control's own trade list by weight_col instead of equal weight.
    Shadow-mode only — selection is untouched, this just changes how a basket return
    would be computed if capital were allocated by weight_col instead of equally.
    Rows with a missing/non-positive weight are dropped rather than crashing the grade."""
    if traded.empty or weight_col not in traded.columns:
        return None
    w = traded[weight_col].astype(float)
    mask = w.notna() & (w > 0) if positive_only else w.notna()
    if not mask.any():
        return None
    w = w[mask]
    rets = traded.loc[mask, "ret_pct_net"].astype(float)
    weights = w / w.sum()
    return round(float((weights * rets).sum()), 3)


def grade(path):
    rec = json.loads(Path(path).read_text())
    if rec.get("graded"):
        print("already graded:"); print(json.dumps(rec["graded"], indent=2)); return

    rule_spec, adapter, uni, panels, shares = env()
    as_of = pd.Timestamp(rec["signal_week_start"])
    cost = rec["exit_rule"]["costs_pct_round_trip"] / 100

    graded_tickers = [r["ticker"] for r in rec["picks"]] + [r["ticker"] for r in rec.get("near_miss", [])]
    daily_panels = adapter.daily_ohlcv(graded_tickers, rule_spec["data"]["history_weeks"] * 7) if graded_tickers else {}

    out, missing = _grade_rows(rec["picks"], panels, as_of, cost, daily_panels)
    near_out, near_missing = _grade_rows(rec.get("near_miss", []), panels, as_of, cost, daily_panels)
    missing += near_missing

    if missing:
        print(f"no forward bar yet for: {missing} — data not refreshed, or the week hasn't closed.")
        if not out and not near_out:
            return

    df = pd.DataFrame(out)
    traded = df[df["status"] == "TRADE"].copy()
    shadow = df[df["status"] != "TRADE"]
    near_df = pd.DataFrame(near_out)

    if not traded.empty:
        r = traded["R_ref"].astype(float)
        traded["inv_R"] = np.where(r > 0, 1.0 / r, np.nan)
    t2_basket_net_pct = _weighted_basket_return(traded, "inv_R", positive_only=True)
    t3_basket_net_pct = _weighted_basket_return(traded, "confidence", positive_only=True)

    bench_ret = None
    bench = adapter.benchmark_series(rec["benchmark_ticker"], rule_spec["data"]["history_weeks"])
    if not bench.empty and rec.get("benchmark_close_at_signal"):
        nb = bench[bench["date"] > as_of].sort_values("date")
        if not nb.empty:
            o, c = float(nb.iloc[0]["open"]), float(nb.iloc[0]["close"])
            bench_ret = round((c - o) / o * 100, 3)

    summary = {
        "graded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_traded": int(len(traded)),
        "basket_gross_pct": round(float(traded["ret_pct"].mean()), 3) if len(traded) else None,
        "basket_net_pct": round(float(traded["ret_pct_net"].mean()), 3) if len(traded) else None,
        "T2_basket_net_pct": t2_basket_net_pct,
        "T3_basket_net_pct": t3_basket_net_pct,
        "winners": int((traded["ret_pct_net"] > 0).sum()) if len(traded) else 0,
        "benchmark_week_pct": bench_ret,
        "shadow_basket_net_pct": round(float(shadow["ret_pct_net"].mean()), 3) if len(shadow) else None,
        "n_near_miss": int(len(near_df)),
        "near_miss_basket_net_pct": round(float(near_df["ret_pct_net"].mean()), 3) if len(near_df) else None,
        "near_miss_winners": int((near_df["ret_pct_net"] > 0).sum()) if len(near_df) else 0,
        "prior_expected_basket_pct": rec["prior"]["expected_basket_return_pct"],
        "detail": out,
        "near_miss_detail": near_out,
    }
    rec["graded"] = summary
    Path(path).write_text(json.dumps(rec, indent=2))
    df.to_csv(str(path).replace(".json", "_graded.csv"), index=False)
    if near_out:
        near_df.to_csv(str(path).replace(".json", "_near_miss_graded.csv"), index=False)

    print(f"=== GRADED {rec['record_id']} ===")
    cols = ["ticker", "status", "EP_actual", "week_low", "vstop_line_SL", "exit_reason",
            "exit_price", "ret_pct", "ret_pct_net"]
    print(df[cols].to_string(index=False))
    if len(near_df):
        print("\n-- near-misses (flipped VStop, filtered out before becoming a pick) --")
        print(near_df[cols].to_string(index=False))
    print()
    print(f"  traded basket net : {summary['basket_net_pct']}%   "
          f"(prior expectation {summary['prior_expected_basket_pct']}%)")
    if summary["T2_basket_net_pct"] is not None:
        print(f"  T2 (1%/R weight)  : {summary['T2_basket_net_pct']}%  <- shadow reweight, same trade list")
    if summary["T3_basket_net_pct"] is not None:
        print(f"  T3 (confidence wt): {summary['T3_basket_net_pct']}%  <- shadow reweight, same trade list")
    print(f"  benchmark week    : {summary['benchmark_week_pct']}%")
    if summary["shadow_basket_net_pct"] is not None:
        print(f"  shadow (rejected) : {summary['shadow_basket_net_pct']}%  "
              f"<- did the 15% risk cap help or hurt?")
    if summary["near_miss_basket_net_pct"] is not None:
        print(f"  near-miss basket  : {summary['near_miss_basket_net_pct']}%  "
              f"<- what the RSI band (or other filters) screened out")
    print("\n  One week is not evidence. Log it and move on.")


def record_t1_shadow():
    """T1 (docs/forward-test-response-and-volume-plan.md §3.2): scan the last 5
    trading days with the identical VStop+RSI rule instead of only Friday's
    close, and see if it catches genuine flips the weekly anchor misses. Shadow
    only — no capital, no change to Control's own record(). Requires the daily-
    bar backfill (Phase 9); reports cleanly and does nothing if that hasn't run.

    Thin wrapper around src/screen/t1_scan.py:scan_t1_week() — the scan itself is
    as_of-parameterized so it can also run historically (see t1_replay() below).
    """
    rule_spec, adapter, uni, panels, shares = env()
    as_of = all_dates(panels)[-1]

    tickers = uni["ticker"].tolist()
    daily_panels = adapter.daily_ohlcv(tickers, rule_spec["data"]["history_weeks"] * 7)
    if not daily_panels:
        print("no daily-bar cache yet — T1 shadow scan skipped (Phase 9 backfill not run)")
        return None

    rec = scan_t1_week(as_of, rule_spec, adapter, uni, panels, daily_panels, shares,
                        recording_mode="forward", score_filter_threshold=T1_SCORE_FILTER_THRESHOLD)
    if rec is None:
        print("insufficient daily history for a rolling window — T1 shadow scan skipped")
        return None

    out_path = OUT / f"picks_{as_of.date()}_t1.json"
    if out_path.exists():
        print(f"REFUSING to overwrite an existing T1 record: {out_path}")
        return None
    out_path.write_text(json.dumps(rec, indent=2))
    print(f"T1 shadow: {rec['n_extra_confirmed']} extra name(s) confirmed at Friday, "
          f"{rec['n_extra_reversed']} reversed before Friday -> {out_path}")
    return rec


def t1_replay(start_str: str, end_str: str):
    """Backtest T1's scan across historical weeks (docs/wow-arm-history-analysis-plan.md
    follow-up) — mirrors tests/track_flags.py:replay()'s structure: same week grid, same
    "load the daily cache once, slice per week" shape. Writes to
    results/forward_test/replay/, never touching the live picks_*_t1.json records.
    Run once, standalone (like scripts/backfill_history.py) — this is materially heavier
    than the weekly flag-matrix replay (5 daily run_screen() calls per week, not 1).
    """
    rule_spec, adapter, uni, panels, shares = env()
    tickers = uni["ticker"].tolist()
    daily_panels = adapter.daily_ohlcv(tickers, rule_spec["data"]["history_weeks"] * 7)
    if not daily_panels:
        print("no daily-bar cache — t1 replay skipped")
        return

    dates = [d for d in all_dates(panels) if pd.Timestamp(start_str) <= d <= pd.Timestamp(end_str)]
    if not dates:
        print(f"no weeks in range [{start_str}, {end_str}]")
        return

    replay_dir = OUT / "replay"
    replay_dir.mkdir(parents=True, exist_ok=True)
    replay_run_id = f"t1replay_{datetime.now(timezone.utc).isoformat(timespec='seconds')}"
    cost = EXIT_RULE["costs_pct_round_trip"] / 100

    all_records, all_grades = [], []
    n_scanned = n_graded = 0
    for as_of in dates:
        rec = scan_t1_week(as_of, rule_spec, adapter, uni, panels, daily_panels, shares,
                            recording_mode="replay")
        if rec is None:
            continue
        n_scanned += 1
        rec["replay_run_id"] = replay_run_id
        manifest = {k: v for k, v in rec.items() if k != "picks"}
        (replay_dir / f"t1_{as_of.date()}.manifest.json").write_text(json.dumps(manifest, indent=2, default=str))

        picks_df = pd.DataFrame(rec["picks"])
        if not picks_df.empty:
            picks_df["recording_mode"] = "replay"
            picks_df["signal_week"] = str(as_of.date())
            picks_df.to_csv(replay_dir / f"t1_{as_of.date()}.csv", index=False)
            all_records.append(picks_df)

        out, missing = _grade_rows(rec["picks"], panels, as_of, cost, daily_panels)
        if out:
            n_graded += 1
            graded_df = pd.DataFrame(out)
            graded_df["recording_mode"] = "replay"
            graded_df["signal_week"] = str(as_of.date())
            filtered_set = set(rec.get("filtered_tickers", []))
            graded_df["score_filter_eligible"] = graded_df["ticker"].isin(filtered_set)
            graded_df.to_csv(replay_dir / f"t1_{as_of.date()}_graded.csv", index=False)
            all_grades.append(graded_df)

        # Rewrite the concatenated ledgers after EVERY week, not just at the end -- this
        # run takes hours (~90s/week, ~5 daily run_screen() calls each); incremental
        # writes mean progress is inspectable mid-run and nothing is lost if it's killed.
        if all_records:
            pd.concat(all_records, ignore_index=True).to_csv(replay_dir / "t1_ledger_records.csv", index=False)
        if all_grades:
            pd.concat(all_grades, ignore_index=True).to_csv(replay_dir / "t1_ledger_grades.csv", index=False)
        print(f"  {as_of.date()}: scanned ({n_scanned}/{len(dates)}), graded={n_graded}")

    print(f"t1 replay: {len(dates)} week(s) in range, {n_scanned} scanned, {n_graded} graded "
          f"-> {replay_dir} (run_id={replay_run_id})")


def grade_t1(path):
    rec = json.loads(Path(path).read_text())
    if rec.get("graded"):
        print("already graded:"); print(json.dumps(rec["graded"], indent=2)); return
    if not rec["picks"]:
        print("no T1 extra picks that week — nothing to grade.")
        return

    rule_spec, adapter, uni, panels, shares = env()
    as_of = pd.Timestamp(rec["signal_week_start"])
    cost = 0.005

    daily_panels = adapter.daily_ohlcv([r["ticker"] for r in rec["picks"]], rule_spec["data"]["history_weeks"] * 7)
    out, missing = _grade_rows(rec["picks"], panels, as_of, cost, daily_panels)
    if missing:
        print(f"no forward bar yet for: {missing} — data not refreshed, or the week hasn't closed.")
        if not out:
            return

    df = pd.DataFrame(out)
    filtered_set = set(rec.get("filtered_tickers", []))
    filtered_df = df[df["ticker"].isin(filtered_set)] if filtered_set else df.iloc[0:0]
    summary = {
        "graded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_traded": int(len(df)),
        "basket_net_pct": round(float(df["ret_pct_net"].mean()), 3) if len(df) else None,
        "score_filter_threshold": rec.get("score_filter_threshold"),
        "n_filtered_eligible": len(filtered_df),
        "filtered_basket_net_pct": round(float(filtered_df["ret_pct_net"].mean()), 3) if len(filtered_df) else None,
        "detail": out,
    }
    rec["graded"] = summary
    Path(path).write_text(json.dumps(rec, indent=2))
    print(f"=== GRADED {rec['record_id']} ===")
    print(df[["ticker", "exit_reason", "exit_price", "ret_pct", "ret_pct_net"]].to_string(index=False))
    print(f"\n  T1 shadow basket net (all {summary['n_traded']}): {summary['basket_net_pct']}%")
    if summary["filtered_basket_net_pct"] is not None:
        print(f"  T1 score>={summary['score_filter_threshold']:.0f} shadow sub-basket "
              f"(n={summary['n_filtered_eligible']}): {summary['filtered_basket_net_pct']}%  "
              f"<- SHADOW ONLY, not real capital")


# ~13 weeks = first look, ~26 weeks = a real read (docs/forward-test-response-and-volume-plan.md §2).
FIRST_LOOK_WEEKS = 13
REAL_READ_WEEKS = 26


def _series_report(label: str, values: np.ndarray) -> None:
    n = len(values)
    if n == 0:
        print(f"  {label:<22} n=0")
        return
    mean, lo, hi = bootstrap_ci(values)
    if n < FIRST_LOOK_WEEKS:
        note = f"insufficient data (need {FIRST_LOOK_WEEKS} for a first look, have {n})"
    elif n < REAL_READ_WEEKS:
        note = f"first look (need {REAL_READ_WEEKS} for a real read); CI95=[{lo:.2f}%, {hi:.2f}%]"
    else:
        note = f"real read; CI95=[{lo:.2f}%, {hi:.2f}%]"
    print(f"  {label:<22} n={n:<3} mean={mean:.2f}%   {note}")


def summary():
    """Accumulate the diagnostic pack (§2/§A2) across all graded forward-test records:
    Control basket, shadow (risk-cap rejected) basket, near-miss (RSI-filtered) basket,
    T2/T3 shadow reweights, and a confidence rank-IC check (B6)."""
    records = []
    for p in sorted(glob.glob(str(OUT / "picks_*.json"))):
        if p.endswith("_t1.json"):
            continue  # T1 shadow records are a separate schema, aggregated below
        rec = json.loads(Path(p).read_text())
        if rec.get("graded"):
            records.append(rec)

    if not records:
        print("No graded records yet.")
        return

    control = np.array([r["graded"]["basket_net_pct"] for r in records if r["graded"].get("basket_net_pct") is not None])
    shadow = np.array([r["graded"]["shadow_basket_net_pct"] for r in records if r["graded"].get("shadow_basket_net_pct") is not None])
    near_miss = np.array([r["graded"]["near_miss_basket_net_pct"] for r in records if r["graded"].get("near_miss_basket_net_pct") is not None])
    t2 = np.array([r["graded"]["T2_basket_net_pct"] for r in records if r["graded"].get("T2_basket_net_pct") is not None])
    t3 = np.array([r["graded"]["T3_basket_net_pct"] for r in records if r["graded"].get("T3_basket_net_pct") is not None])

    print(f"=== DIAGNOSTIC PACK ({len(records)} graded week(s)) ===\n")
    print("Series (Control vs shadow/near-miss populations, §2):")
    _series_report("Control (traded)", control)
    _series_report("Shadow (risk-cap)", shadow)
    _series_report("Near-miss (RSI)", near_miss)

    print("\nTest arms vs Control, same weeks (§3.4) — risk-adjusted comparison needs per-trade")
    print("R/vol data beyond basket means; this reports raw shadow reweights only:")
    _series_report("T2 (1%/R weight)", t2)
    _series_report("T3 (confidence wt)", t3)

    # Pair by record_id, not array position — records without T2/T3 (graded before
    # that code shipped) or without a Control basket that week must not silently
    # shift the alignment between the two series.
    control_by_id = {r["record_id"]: r["graded"]["basket_net_pct"] for r in records
                      if r["graded"].get("basket_net_pct") is not None}
    for label, key in (("T2", "T2_basket_net_pct"), ("T3", "T3_basket_net_pct")):
        paired = [(r["graded"][key] - control_by_id[r["record_id"]]) for r in records
                  if r["graded"].get(key) is not None and r["record_id"] in control_by_id]
        if paired:
            print(f"  {label} - Control (paired, {len(paired)} wks): {np.mean(paired):.2f}% avg delta")

    t1_records = [json.loads(Path(p).read_text()) for p in sorted(glob.glob(str(OUT / "picks_*_t1.json")))]
    print("\nT1 (rolling window):")
    if not t1_records:
        print("  no daily cache yet — T1 has never run (Phase 9 backfill not done).")
    else:
        n_confirmed = sum(r["n_extra_confirmed"] for r in t1_records)
        n_reversed = sum(r["n_extra_reversed"] for r in t1_records)
        t1_graded = np.array([r["graded"]["basket_net_pct"] for r in t1_records
                               if r.get("graded") and r["graded"].get("basket_net_pct") is not None])
        print(f"  {len(t1_records)} week(s) scanned: {n_confirmed} extra name(s) confirmed at Friday "
              f"(caught by T1, missed by Control), {n_reversed} reversed before Friday "
              f"(would never have been a Control trade).")
        _series_report("T1 extra (shadow)", t1_graded)

    all_trades = pd.DataFrame([
        row for r in records for row in r["graded"]["detail"] if row["status"] == "TRADE"
    ])
    print("\nConfidence rank-IC (B6 — is confidence a real ordering signal?):")
    ic = confidence_rank_ic(all_trades) if not all_trades.empty else {"n": 0, "rank_ic": None, "p_value": None}
    if ic["rank_ic"] is None:
        print(f"  n={ic['n']}: not enough distinct data to compute rank-IC yet.")
    else:
        sig = "significant" if ic["p_value"] < 0.05 else "not significant"
        print(f"  n={ic['n']}: rank_ic={ic['rank_ic']:.3f}, p={ic['p_value']:.3f} ({sig} at 0.05)")
        if ic["p_value"] >= 0.05:
            print("  -> T3's kill criterion (§3.2) is not yet cleared: do not read T3 as validated.")

    out_rows = []
    for r in records:
        g = r["graded"]
        out_rows.append({
            "record_id": r["record_id"], "signal_week_start": r["signal_week_start"],
            "basket_net_pct": g.get("basket_net_pct"), "shadow_basket_net_pct": g.get("shadow_basket_net_pct"),
            "near_miss_basket_net_pct": g.get("near_miss_basket_net_pct"),
            "T2_basket_net_pct": g.get("T2_basket_net_pct"), "T3_basket_net_pct": g.get("T3_basket_net_pct"),
        })
    out_path = OUT / "diagnostic_summary.csv"
    pd.DataFrame(out_rows).to_csv(out_path, index=False)
    print(f"\nWritten -> {out_path}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "record"
    if cmd == "record":
        record()
    elif cmd == "grade":
        grade(sys.argv[2])
    elif cmd == "summary":
        summary()
    elif cmd == "t1":
        record_t1_shadow()
    elif cmd == "t1grade":
        grade_t1(sys.argv[2])
    elif cmd == "t1replay":
        t1_replay(sys.argv[2], sys.argv[3])
    else:
        print(__doc__)
