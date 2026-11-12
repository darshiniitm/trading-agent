"""
Literal-spec forward test: record this week's picks, grade them next week.

This is the Literal series' own record/grade cadence (docs/literal-spec-plan.md,
Phase 5) -- a clean, independent series driven by config/rules_literal.yaml, not a
fork of tests/track_forward.py's Control cadence. It reuses the same shared building
blocks (run_screen, build_trades, corrected_week_bar via _grade_rows, bootstrap_ci)
per the reuse-vs-modify audit; it does not edit or pool into Control's records.

Two things this script does, same discipline as Control's:
  record — freeze this week's picks + trades. EP is NOT a placeholder here: the
           brief's literal EP (Friday's own signal close, decided 26 Sep 2026) is
           already final at record time, so every survivor gets a real EP/R/target/
           confidence immediately -- see docs/literal-spec-plan.md, decision 3.
  grade  — once next week's bar exists, score the frozen record against it, using
           the recorded EP (never overwritten by next week's actual open, which is
           only captured as `next_week_open_check`, an informational fill-price
           check -- see _grade_rows(entry_price_source="signal_close") in
           tests/track_forward.py).

usage:
  python3 -m tests.track_literal record
  python3 -m tests.track_literal grade results/literal_test/picks_2026-10-02.json

Requires data_cache_literal/ to already be populated by a live bootstrap
(scripts/common.py:bootstrap('config/rules_literal.yaml')) -- the full-NSE-from-2024
universe is a real, one-time network-heavy pull that never happens inside this
script or inside a test (HARNESS.md rule 8).

Also here: the OLD mid-week scan (src/screen/t1_scan.py:scan_t1_week()), run under
THIS spec's environment instead of Control's -- same scan code, no fork (HARNESS §2),
just fed Literal's full-NSE universe/rules. This is NOT called T1 any more (see below)
-- it is frozen, kept for reference, renamed midweek_scan/midweek_scan_grade/
midweek_scan_replay:

  python3 -m tests.track_literal midweek_scan
  python3 -m tests.track_literal midweek_scan_grade results/literal_test/t1_picks_2026-10-02.json
  python3 -m tests.track_literal midweek_scan_replay 2024-01-08 2026-09-14

midweek_scan/midweek_scan_grade/midweek_scan_replay additionally require the daily-bar
backfill in data_cache_literal/ (scripts/backfill_history.py --config
config/rules_literal.yaml --start 2024-01-01).

T1 REDEFINED (docs/literal-spec-plan.md's "T1 redefined per the brief" section, 27 Sep
2026): the old mid-week scan looked for flips on any 5-day window, which contradicts
step 2's "Friday closing weekly" -- so it is no longer called T1, and is frozen above
under its own name. T1 now means Literal's own rolling weekly loop: each Friday t, run
steps 1-4 on Friday t's close (record()), grade Friday t-1's picks on the week ending
Friday t (grade()), and append that graded week to a rolling ledger with 4-/13-/26-week
totals -- the SAME record()/grade() functions already used for Literal's own forward
cadence, just accumulated and reported on a rolling basis. See rolling_stats() and
rolling() below; replay() builds and reports from the identical ledger format so the
live week and replayed history are the same code path (item 4 of the redefinition).

  python3 -m tests.track_literal rolling

STEP 5 EXTENDED (docs/literal-spec-plan.md's "Step 5 extended: 1-, 2- and 3-week
returns" section, added 27 Sep 2026): 1-/2-/3-week horizon grading in a signal view
(close-to-close, stop ignored) and a trade view (trailing-stop, decided by Dharmin 27
Sep 2026 -- the stop trails to each week's own closed VStop line). See
src/backtest/horizons.py:grade_horizons(), and maturity_loop()/replay_horizons() below,
which call it identically for the live cadence and for history:

  python3 -m tests.track_literal maturity
  python3 -m tests.track_literal replay_horizons 2024-01-01 2026-09-14

WEEKLY REPORT: weekly_report() assembles the doc's 5-step weekly report entirely from
already-recorded evidence (record()'s JSON, maturity_loop()'s horizons/*.jsonl, the
rolling ledger) -- no re-screening, no re-grading:

  python3 -m tests.track_literal weekly_report
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from src.backtest.horizons import grade_horizons
from src.screen.engine import run_screen
from src.screen.t1_scan import scan_t1_week, T1_SCORE_FILTER_THRESHOLD
from src.trade.builder import build_trades, _rsi_band_bounds
from tests.offline import env_literal, env_literal_with_daily, all_dates
from tests.track_forward import _grade_rows

OUT = Path(__file__).resolve().parents[1] / "results" / "literal_test"

# T1 redefined (27 Sep 2026, see module docstring): the rolling ledger every graded
# Literal week appends to, and the rolling-window sizes reported alongside the latest
# week. Not a fixed calendar span -- a count of graded weeks, so an early gap (a
# skipped/late week) doesn't silently shrink the window without saying so.
ROLLING_LEDGER = OUT / "rolling_ledger.csv"
ROLLING_WINDOWS = (4, 13, 26)

EXIT_RULE = {
    "entry": "this Friday's close (signal_close) -- the trade's real EP from record "
             "time, per the brief's literal step 4/5 reading (decided 26 Sep 2026)",
    "fill_check": "next Monday's open is captured as next_week_open_check, "
                  "informational only -- never used to compute R, target, or return",
    "exit": "that week's close, unless the intraweek low <= SL, in which case SL",
    "gap_caveat": "if the week OPENS below SL the honest fill is the open, not SL",
    "costs_pct_round_trip": 0.5,
    "horizon": "fixed 1 week",
}


def _benchmark_week_return(bench: pd.DataFrame, as_of: pd.Timestamp) -> float | None:
    """The benchmark's own open-to-close return for the HOLDING week (the week after
    as_of) -- the same week our basket's trade-result return is measured over, so the
    two are a like-for-like comparison. Shared by grade(), replay(), and midweek_scan_replay() so
    "how did we do vs the benchmark" is computed identically in the forward path and
    every retrospective replay (HARNESS §2 spirit -- one function, not three copies)."""
    if bench.empty:
        return None
    nb = bench[bench["date"] > as_of].sort_values("date")
    if nb.empty:
        return None
    o, c = float(nb.iloc[0]["open"]), float(nb.iloc[0]["close"])
    return round((c - o) / o * 100, 3)


def _ledger_row(signal_week: str, n_traded: int, basket_c2c: float | None, basket_net: float | None,
                 winners_c2c: int, benchmark_week_pct: float | None, source: str) -> dict:
    """One graded week, in the flat shape the rolling ledger accumulates -- built the
    same way whether the week came from a live grade() or a replay() fold, so
    rolling_stats() below never has to know which produced a given row (T1 redefined,
    item 4: the live week and replayed history are the same code path)."""
    alpha = round(basket_c2c - benchmark_week_pct, 3) if basket_c2c is not None and benchmark_week_pct is not None else None
    return {
        "signal_week": signal_week, "n_traded": int(n_traded),
        "basket_close_to_close_pct": basket_c2c, "basket_trade_result_net_pct": basket_net,
        "winners_close_to_close": int(winners_c2c), "benchmark_week_pct": benchmark_week_pct,
        "alpha_close_to_close_pct": alpha, "source": source,
    }


def _append_rolling_ledger(row: dict, ledger_path: Path = ROLLING_LEDGER) -> pd.DataFrame:
    """Append-only, like every other record in this project (HARNESS rule 4): a week
    already present in the ledger is never overwritten, even with a different `source`
    -- grade() runs before replay() would ever cover the same week, and if a week were
    ever re-graded that's a bug to fix at the source, not paper over here."""
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    cols = list(row.keys())
    df = pd.read_csv(ledger_path) if ledger_path.exists() else pd.DataFrame(columns=cols)
    if not df.empty and row["signal_week"] in set(df["signal_week"].astype(str)):
        return df
    df = pd.concat([df, pd.DataFrame([row])], ignore_index=True)
    df["signal_week"] = df["signal_week"].astype(str)
    df = df.sort_values("signal_week").reset_index(drop=True)
    df.to_csv(ledger_path, index=False)
    return df


def rolling_stats(ledger_df: pd.DataFrame, as_of: str, windows=ROLLING_WINDOWS) -> dict:
    """Rolling N-graded-week aggregate stats as of `as_of` (inclusive): mean
    close-to-close (headline, Q7), mean trade-result net, win rate, and mean alpha vs
    benchmark, over the trailing N rows of the ledger ending at or before as_of. A
    window with fewer than N graded weeks so far still reports on what exists, with
    its true n_weeks -- never padded or treated as the full window."""
    if ledger_df.empty:
        return {w: None for w in windows}
    df = ledger_df[ledger_df["signal_week"].astype(str) <= str(as_of)].sort_values("signal_week")
    out = {}
    for w in windows:
        sub = df.tail(w)
        if sub.empty:
            out[w] = None
            continue
        c2c, net, alpha = sub["basket_close_to_close_pct"], sub["basket_trade_result_net_pct"], sub["alpha_close_to_close_pct"]
        traded_weeks = sub[sub["n_traded"] > 0]
        win_rate = (round(float((traded_weeks["winners_close_to_close"] / traded_weeks["n_traded"]).mean() * 100), 1)
                    if not traded_weeks.empty else None)
        out[w] = {
            "n_weeks": int(len(sub)),
            "mean_close_to_close_pct": round(float(c2c.dropna().mean()), 3) if c2c.notna().any() else None,
            "mean_trade_result_net_pct": round(float(net.dropna().mean()), 3) if net.notna().any() else None,
            "win_rate_pct": win_rate,
            "mean_alpha_pct": round(float(alpha.dropna().mean()), 3) if alpha.notna().any() else None,
        }
    return out


def _print_rolling_stats(stats: dict) -> None:
    for w, s in stats.items():
        if s is None:
            print(f"  rolling {w}w: no graded weeks yet")
            continue
        alpha_str = f", alpha {s['mean_alpha_pct']}%" if s["mean_alpha_pct"] is not None else ""
        print(f"  rolling {w}w (n={s['n_weeks']}): close-to-close {s['mean_close_to_close_pct']}%, "
              f"trade-result net {s['mean_trade_result_net_pct']}%, win rate {s['win_rate_pct']}%{alpha_str}")


def rolling():
    """T1 redefined, item 3: report the latest graded week plus rolling 4-/13-/26-week
    totals, read straight off the ledger grade()/replay() maintain -- no re-screening,
    no re-grading, just a read of already-recorded evidence."""
    if not ROLLING_LEDGER.exists():
        print(f"no rolling ledger yet at {ROLLING_LEDGER} -- run grade() on at least one week first.")
        return
    df = pd.read_csv(ROLLING_LEDGER)
    if df.empty:
        print("rolling ledger is empty.")
        return
    latest = df.sort_values("signal_week").iloc[-1]
    print(f"=== T1 (Literal rolling window) as of {latest['signal_week']} ===")
    print(f"  latest week: close-to-close {latest['basket_close_to_close_pct']}%, "
          f"trade-result net {latest['basket_trade_result_net_pct']}%, "
          f"n_traded={int(latest['n_traded'])}, benchmark {latest['benchmark_week_pct']}%")
    _print_rolling_stats(rolling_stats(df, str(latest["signal_week"])))


def weekly_report(picks_path: str | None = None):
    """Assemble the weekly report docs/literal-spec-plan.md asks for (steps 1-5),
    entirely from already-recorded evidence -- record()'s own JSON, maturity_loop()'s
    horizons/*.jsonl, and the rolling ledger. No re-screening, no re-grading (same
    discipline as the threshold experiment's derived-only records, HARNESS §12).
    Defaults to the most recently recorded picks_<date>.json."""
    if picks_path is None:
        candidates = sorted(OUT.glob("picks_*.json"))
        if not candidates:
            print("no Literal picks recorded yet.")
            return
        picks_path = candidates[-1]
    rec = json.loads(Path(picks_path).read_text())

    print(f"=== Literal weekly report: signal week {rec['signal_week_start']} ({rec['record_id']}) ===\n")

    print("Step 1 -- universe funnel:")
    for stage, count in rec.get("funnel", {}).items():
        print(f"  {stage:30s} {count}")

    print("\nStep 2 -- qualified stocks (flip=up, RSI band per config):")
    for p in rec["picks"]:
        print(f"  {p['ticker']:15s} close={p['signal_close']:>10} vstop_line={p['vstop_line_SL']:>10} "
              f"RSI={p['rsi']:>6}")
    if not rec["picks"]:
        print("  (none qualified this week)")

    print("\nStep 3 -- sector view:")
    for s in rec.get("sector_view", []):
        print(f"  {s.get('sector'):20s} n_qualified={s.get('n_qualified')}  rs_4w={s.get('rs_4w')}  "
              f"rs_1w={s.get('rs_1w')}  rs_13w={s.get('rs_13w')}")

    print("\nStep 4 -- trades (EP/SL, no risk-cap filter, one confidence score):")
    for p in rec["picks"]:
        print(f"  {p['ticker']:15s} EP={p['EP']:>10} SL={p['SL']:>10} R={p['R']:>8} "
              f"target={p['target']:>10} confidence={p['confidence']:>6}")

    print("\nStep 5 -- last 3 Fridays graded (1-/2-/3-week returns):")
    cohorts = sorted(OUT.glob("picks_*.json"))[-3:]
    for cp in cohorts:
        crec = json.loads(cp.read_text())
        h_path = HORIZONS_OUT / f"{crec['record_id']}.jsonl"
        print(f"  {crec['signal_week_start']} ({crec['record_id']}):")
        if not h_path.exists():
            print("    no matured horizons yet -- run `maturity` first")
            continue
        rows = [json.loads(line) for line in h_path.read_text().splitlines() if line.strip()]
        horizons_present = sorted({r["horizon_weeks"] for r in rows})
        for h in horizons_present:
            for view in ("signal", "trade"):
                group = [r for r in rows if r["horizon_weeks"] == h and r["view"] == view]
                if not group:
                    print(f"    {h}w ({view}): pending")
                    continue
                mean_r = round(sum(r["r_Nw"] for r in group) / len(group), 3)
                hit_rate = round(sum(1 for r in group if r["r_Nw"] > 0) / len(group) * 100, 1)
                bench = group[0].get("bench_Nw")
                print(f"    {h}w ({view}): basket mean {mean_r}%  hit rate {hit_rate}%  "
                      f"n={len(group)}  benchmark {bench}%")
    print()
    rolling()


def _build_picks_rows(res: dict, rule_spec: dict) -> tuple[list[dict], list[dict]]:
    """Shared by record() and replay(): survivors + their trades -> picks rows, plus
    the sector view (step 3: visible, not a hidden score input -- sector.mode: report).
    Every survivor with a usable SL gets a real EP/R/target/confidence immediately
    (decision 3 -- EP is Friday's own signal close, never a placeholder)."""
    survivors = res["survivors"]
    trades = build_trades(survivors, rule_spec)
    if len(trades) != len(survivors):
        print(f"NOTE: {len(survivors) - len(trades)} survivor(s) had no usable SL and "
              f"were dropped by build_trades() -- not a risk-cap rejection (Literal has none).")

    lookbacks = rule_spec["sector"]["rs_lookbacks_weeks"]
    primary_lb = lookbacks[0]
    rs_cols = [f"rs_{lb}w" for lb in lookbacks]
    ret_cols = [f"ret_{lb}w" for lb in lookbacks]

    rows = []
    for _, s in survivors.iterrows():
        tk = s["ticker"]
        tr = trades[trades["ticker"] == tk]
        if tr.empty:
            continue  # no usable SL -- see NOTE above, not a Literal filter
        tr = tr.iloc[0]
        rows.append({
            "ticker": tk,
            "name": s.get("name"),
            "sector": s.get("sector"),
            "status": "TRADE",
            "signal_close": round(float(s["close"]), 4),
            "vstop_line_SL": round(float(s["vstop_line"]), 4),
            "rsi": round(float(s["rsi"]), 3),
            "atr": round(float(s["atr"]), 4) if pd.notna(s.get("atr")) else None,
            "volume": float(s["volume"]) if pd.notna(s.get("volume")) else None,
            "avg_vol_8w": float(s["avg_vol_8w"]) if pd.notna(s.get("avg_vol_8w")) else None,
            "mktcap_cr": round(float(s["mktcap_cr"]), 1),
            "turnover_cr": round(float(s["median_weekly_turnover_cr"]), 2),
            "EP": round(float(tr["EP"]), 4),          # final at record time -- brief step 4/5, decision 3
            "SL": round(float(tr["SL"]), 4),
            "R": round(float(tr["R"]), 4),
            "target": round(float(tr["target"]), 4),
            "confidence": float(tr["confidence"]),
        })

    sector_rs = res["sector_rs"].copy()
    for c in rs_cols + ret_cols:
        if c in sector_rs.columns:
            sector_rs[c] = sector_rs[c].round(4)
    qualified_by_sector = survivors["sector"].value_counts().to_dict() if not survivors.empty else {}
    sector_rs["n_qualified"] = sector_rs["sector"].map(qualified_by_sector).fillna(0).astype(int)
    sector_view = sector_rs.sort_values(f"rs_{primary_lb}w", ascending=False).to_dict("records")
    return rows, sector_view


def record():
    rule_spec, adapter, uni, panels, shares = env_literal()
    dates = all_dates(panels)
    as_of = dates[-1]

    res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    survivors = res["survivors"]
    rows, sector_view = _build_picks_rows(res, rule_spec)

    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"],
                                      rule_spec["data"]["history_weeks"])
    bench_close = None
    if not bench.empty:
        b = bench[bench["date"] <= as_of]
        if not b.empty:
            bench_close = float(b["close"].iloc[-1])

    rsi_band = _rsi_band_bounds(rule_spec)

    rec = {
        "record_id": f"lit_{as_of.date()}",
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signal_week_start": str(as_of.date()),
        "signal_week_note": "weekly bar Mon..Fri; signal is that Friday's close, which IS the EP",
        "grade_after": str((as_of + pd.Timedelta(weeks=1)).date()),
        "strategy": {
            "universe": "full NSE EQ-series list (Literal step 1), not the index-constituent proxy",
            "market_cap_cr": rule_spec["universe"]["market_cap_cr"],
            "liquidity_min_cr": rule_spec["universe"]["liquidity"]["min"],
            "vstop": "VStop(10, 2.0) weekly, flip_up == True",
            "rsi": f"RSI(14) weekly, {rsi_band[0]} <= value <= {rsi_band[1]}",
            "max_r_pct": rule_spec["trade"]["max_r_pct"],
        },
        "exit_rule": EXIT_RULE,
        "prior": None,  # Literal starts clean -- no pooled/converted Control history (decision 5)
        "funnel": {k: int(v) for k, v in zip(res["funnel"]["stage"], res["funnel"]["count"])},
        "benchmark_ticker": rule_spec["sector"]["benchmark_ticker"],
        "benchmark_close_at_signal": bench_close,
        "n_survivors": int(len(survivors)),
        "n_trades": int(len(rows)),
        "sector_view": sector_view,
        "picks": rows,
        "near_miss": [],  # Literal has no risk-cap/RSI-ceiling shadow rejects to speak of by design
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
    print(f"recorded {len(rows)} Literal picks (of {len(survivors)} survivors) -> {p}")
    print(json.dumps(rec["funnel"], indent=1))
    for r in rows:
        print(f"  {r['ticker']:15s} EP={r['EP']:>10} SL={r['SL']:>10} "
              f"RSI={r['rsi']:>6} confidence={r['confidence']:>5}")


def grade(path):
    rec = json.loads(Path(path).read_text())
    if rec.get("graded"):
        print("already graded:"); print(json.dumps(rec["graded"], indent=2)); return

    rule_spec, adapter, uni, panels, shares = env_literal()
    as_of = pd.Timestamp(rec["signal_week_start"])
    cost = rec["exit_rule"]["costs_pct_round_trip"] / 100

    graded_tickers = [r["ticker"] for r in rec["picks"]]
    daily_panels = adapter.daily_ohlcv(graded_tickers, rule_spec["data"]["history_weeks"] * 7) if graded_tickers else {}

    out, missing = _grade_rows(rec["picks"], panels, as_of, cost, daily_panels, entry_price_source="signal_close")
    if missing:
        print(f"no forward bar yet for: {missing} -- data not refreshed, or the week hasn't closed.")
        if not out:
            return

    df = pd.DataFrame(out)

    bench = adapter.benchmark_series(rec["benchmark_ticker"], rule_spec["data"]["history_weeks"])
    bench_ret = _benchmark_week_return(bench, as_of) if rec.get("benchmark_close_at_signal") else None

    summary = {
        "graded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_traded": int(len(df)),
        # Q7 (decided): close-to-close is the headline return; trade-result-with-SL-hits reported alongside.
        "basket_close_to_close_pct": round(float(((df["week_close"] - df["signal_close"]) / df["signal_close"] * 100).mean()), 3) if len(df) else None,
        "basket_trade_result_net_pct": round(float(df["ret_pct_net"].mean()), 3) if len(df) else None,
        "winners_close_to_close": int(((df["week_close"] - df["signal_close"]) > 0).sum()) if len(df) else 0,
        "benchmark_week_pct": bench_ret,
        "detail": out,
    }
    rec["graded"] = summary
    Path(path).write_text(json.dumps(rec, indent=2))
    df.to_csv(str(path).replace(".json", "_graded.csv"), index=False)

    print(f"=== GRADED {rec['record_id']} ===")
    cols = ["ticker", "signal_close", "EP_actual", "next_week_open_check", "week_close",
            "exit_reason", "exit_price", "ret_pct", "ret_pct_net"]
    print(df[[c for c in cols if c in df.columns]].to_string(index=False))
    print()
    print(f"  basket close-to-close (headline): {summary['basket_close_to_close_pct']}%")
    print(f"  basket trade-result net          : {summary['basket_trade_result_net_pct']}%")
    if bench_ret is not None:
        print(f"  benchmark ({rec['benchmark_ticker']})           : {bench_ret}%")

    # T1 redefined (module docstring): every graded Literal week feeds the rolling
    # ledger, live or replay, through this same row shape and the same rolling_stats().
    row = _ledger_row(rec["signal_week_start"], summary["n_traded"], summary["basket_close_to_close_pct"],
                       summary["basket_trade_result_net_pct"], summary["winners_close_to_close"],
                       bench_ret, source="live")
    ledger_df = _append_rolling_ledger(row)
    print()
    print(f"  T1 (rolling window) as of {rec['signal_week_start']}:")
    _print_rolling_stats(rolling_stats(ledger_df, rec["signal_week_start"]))


def midweek_scan_record():
    """FROZEN, no longer called T1 (see module docstring, 27 Sep 2026 redefinition) --
    the old daily rolling-window scan (src/screen/t1_scan.py:scan_t1_week()), run under
    Literal's ruleset (full NSE universe, no risk cap) instead of Control's -- same
    scan code fed a different environment, per HARNESS §2. Shadow only, same
    discipline as tests/track_forward.py:record_t1_shadow()."""
    rule_spec, adapter, uni, panels, shares, daily_panels = env_literal_with_daily()
    as_of = all_dates(panels)[-1]

    if not daily_panels:
        print("no daily-bar cache in data_cache_literal/ yet -- T1-on-Literal scan skipped "
              "(run scripts/backfill_history.py --config config/rules_literal.yaml --start 2024-01-01)")
        return None

    rec = scan_t1_week(as_of, rule_spec, adapter, uni, panels, daily_panels, shares,
                        recording_mode="forward", score_filter_threshold=T1_SCORE_FILTER_THRESHOLD)
    if rec is None:
        print("insufficient daily history for a rolling window -- T1-on-Literal scan skipped")
        return None
    rec["record_id"] = f"lit_{as_of.date()}_t1"

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / f"t1_picks_{as_of.date()}.json"
    if out_path.exists():
        print(f"REFUSING to overwrite an existing T1-on-Literal record: {out_path}")
        return None
    out_path.write_text(json.dumps(rec, indent=2))
    print(f"midweek-scan-on-Literal: {rec['n_extra_confirmed']} extra name(s) confirmed at Friday, "
          f"{rec['n_extra_reversed']} reversed before Friday -> {out_path}")
    return rec


def midweek_scan_grade(path):
    rec = json.loads(Path(path).read_text())
    if rec.get("graded"):
        print("already graded:"); print(json.dumps(rec["graded"], indent=2)); return
    if not rec["picks"]:
        print("no T1-on-Literal extra picks that week -- nothing to grade.")
        return

    rule_spec, adapter, uni, panels, shares, daily_panels = env_literal_with_daily()
    as_of = pd.Timestamp(rec["signal_week_start"])
    cost = EXIT_RULE["costs_pct_round_trip"] / 100

    out, missing = _grade_rows(rec["picks"], panels, as_of, cost, daily_panels, entry_price_source="signal_close")
    if missing:
        print(f"no forward bar yet for: {missing} -- data not refreshed, or the week hasn't closed.")
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
    print(f"\n  midweek-scan-on-Literal shadow basket net (all {summary['n_traded']}): {summary['basket_net_pct']}%")
    if summary["filtered_basket_net_pct"] is not None:
        print(f"  score>={summary['score_filter_threshold']:.0f} shadow sub-basket "
              f"(n={summary['n_filtered_eligible']}): {summary['filtered_basket_net_pct']}%  "
              f"<- SHADOW ONLY, not real capital")


T1_REPLAY_OUT = Path(__file__).resolve().parents[1] / "results" / "literal_test" / "replay"


def midweek_scan_replay(start_str: str, end_str: str):
    """FROZEN, no longer called T1 (see module docstring). Backtest of the old
    mid-week rolling-window scan across historical weeks, under Literal's ruleset
    (full NSE universe, no risk cap) -- mirrors tests/track_forward.py: t1_replay()
    exactly, just fed Literal's environment instead of Control's. Writes to
    results/literal_test/replay/ (t1_ prefix, alongside Literal's own
    literal_replay_*.csv -- distinct names, no collision), never touching the live
    t1_picks_*.json records. Backtest/replay evidence only (HARNESS rule 4)."""
    rule_spec, adapter, uni, panels, shares, daily_panels = env_literal_with_daily()
    if not daily_panels:
        print("no daily-bar cache in data_cache_literal/ -- t1 replay skipped "
              "(run scripts/backfill_history.py --config config/rules_literal.yaml --start 2024-01-01)")
        return

    dates = [d for d in all_dates(panels) if pd.Timestamp(start_str) <= d <= pd.Timestamp(end_str)]
    if not dates:
        print(f"no weeks in range [{start_str}, {end_str}]")
        return

    T1_REPLAY_OUT.mkdir(parents=True, exist_ok=True)
    replay_run_id = f"lit_t1replay_{datetime.now(timezone.utc).isoformat(timespec='seconds')}"
    cost = EXIT_RULE["costs_pct_round_trip"] / 100
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])

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
        (T1_REPLAY_OUT / f"t1_{as_of.date()}.manifest.json").write_text(json.dumps(manifest, indent=2, default=str))

        picks_df = pd.DataFrame(rec["picks"])
        if not picks_df.empty:
            picks_df["recording_mode"] = "replay"
            picks_df["signal_week"] = str(as_of.date())
            picks_df.to_csv(T1_REPLAY_OUT / f"t1_{as_of.date()}.csv", index=False)
            all_records.append(picks_df)

        out, missing = _grade_rows(rec["picks"], panels, as_of, cost, daily_panels, entry_price_source="signal_close")
        if out:
            n_graded += 1
            graded_df = pd.DataFrame(out)
            graded_df["recording_mode"] = "replay"
            graded_df["signal_week"] = str(as_of.date())
            graded_df["benchmark_week_pct"] = _benchmark_week_return(bench, as_of)
            filtered_set = set(rec.get("filtered_tickers", []))
            graded_df["score_filter_eligible"] = graded_df["ticker"].isin(filtered_set)
            graded_df.to_csv(T1_REPLAY_OUT / f"t1_{as_of.date()}_graded.csv", index=False)
            all_grades.append(graded_df)

        # Incremental writes every week (t1_replay() has the same reasoning): this run
        # is materially heavier than a single weekly scan (5 daily run_screen() calls
        # per week), so progress should be inspectable and nothing lost if it's killed.
        if all_records:
            pd.concat(all_records, ignore_index=True).to_csv(T1_REPLAY_OUT / "t1_ledger_records.csv", index=False)
        if all_grades:
            pd.concat(all_grades, ignore_index=True).to_csv(T1_REPLAY_OUT / "t1_ledger_grades.csv", index=False)
        print(f"  {as_of.date()}: scanned ({n_scanned}/{len(dates)}), graded={n_graded}")

    print(f"T1-on-Literal replay: {len(dates)} week(s) in range, {n_scanned} scanned, {n_graded} graded "
          f"-> {T1_REPLAY_OUT} (run_id={replay_run_id})")
    if all_grades:
        gdf = pd.concat(all_grades, ignore_index=True)
        per_week = gdf.groupby("signal_week").agg(net=("ret_pct_net", "mean"),
                                                    bench=("benchmark_week_pct", "first"))
        per_week = per_week.dropna(subset=["bench"])
        if not per_week.empty:
            alpha = per_week["net"] - per_week["bench"]
            print(f"  mean benchmark ({rule_spec['sector']['benchmark_ticker']}) : "
                  f"{per_week['bench'].mean():.3f}%  (per-week open-to-close, holding week)")
            print(f"  mean alpha vs benchmark      : {alpha.mean():.3f}%")
            print(f"  weeks beating benchmark      : {(alpha > 0).sum()}/{len(per_week)}")


REPLAY_OUT = Path(__file__).resolve().parents[1] / "results" / "literal_test" / "replay"


def replay(n_weeks: int = 142):
    """Backtest/replay evidence ONLY -- never written to results/literal_test/picks_*.json
    (the immutable, pre-registered forward-record path). Per HARNESS.md rule 4 and the
    plan's own "Existing work and evidence" note: only a week logged before its Monday's
    open counts as forward evidence; replaying past weeks after the outcome is already
    known is fine for seeing how the corrected logic *would have* behaved, but it is not,
    and must never be presented as, a forward-test record.

    Runs over the REAL full-NSE universe in data_cache_literal/, backfilled 26 Sep 2026
    (docs/literal-spec-plan.md) -- weekly OHLCV/shares via scripts/bootstrap_literal.py,
    daily bars (for corrected_week_bar's D7 fix) via scripts/backfill_history.py --config
    config/rules_literal.yaml --start 2024-01-01. Supersedes this function's earlier interim
    version, which ran over Control's old proxy universe because data_cache_literal/ was
    still empty at the time; that run's output
    (results/literal_test/replay/literal_replay_2026-06-29_2026-09-14.csv) is left on disk as
    a dated, superseded artifact -- not deleted, but no longer what this function produces.
    Default n_weeks=142 covers every cached week from 2024-01-01 (Literal's own universe
    start, decision 1) through the most recent gradable week.
    """
    rule_spec, adapter, uni, panels, shares = env_literal()
    tickers = uni["ticker"].tolist()
    daily_panels = adapter.daily_ohlcv(tickers, rule_spec["data"]["history_weeks"] * 7)
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])

    dates = all_dates(panels)
    if len(dates) < n_weeks + 1:
        print(f"only {len(dates)} cached weeks available, need at least {n_weeks + 1} "
              f"(n_weeks + 1 so the last fold still has a following week to grade against)")
        n_weeks = max(0, len(dates) - 1)
    # leave the very last cached date out of as_of_dates -- it is needed as "next week"
    # to grade the final fold; replaying it would have no future bar to score against.
    as_of_dates = dates[-(n_weeks + 1):-1]

    print(f"REPLAY (backtest evidence, NOT forward evidence) -- REAL full-NSE universe, "
          f"benchmark {rule_spec['sector']['benchmark_ticker']}, "
          f"{len(as_of_dates)} weeks: {as_of_dates[0].date()} .. {as_of_dates[-1].date()}")

    cost = EXIT_RULE["costs_pct_round_trip"] / 100
    all_graded, all_sector_views = [], {}
    for as_of in as_of_dates:
        res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
        rows, sector_view = _build_picks_rows(res, rule_spec)
        graded, missing = _grade_rows(rows, panels, as_of, cost, daily_panels, entry_price_source="signal_close")
        bench_week_pct = _benchmark_week_return(bench, as_of)
        for g in graded:
            g["week"] = str(as_of.date())
            g["benchmark_week_pct"] = bench_week_pct
        all_graded.extend(graded)
        all_sector_views[str(as_of.date())] = sector_view
        print(f"  {as_of.date()}: {len(rows)} picks, {len(missing)} missing next-week bar, "
              f"benchmark {bench_week_pct}%")

        # Incremental write, same reasoning as midweek_scan_replay(): 142 weeks over the full
        # ~2300-ticker universe is a long run -- keep progress inspectable and
        # nothing lost if it's killed partway.
        REPLAY_OUT.mkdir(parents=True, exist_ok=True)
        if all_graded:
            pd.DataFrame(all_graded).to_csv(REPLAY_OUT / "literal_ledger_progress.csv", index=False)

    REPLAY_OUT.mkdir(parents=True, exist_ok=True)
    start, end = as_of_dates[0].date(), as_of_dates[-1].date()
    df = pd.DataFrame(all_graded)
    csv_path = REPLAY_OUT / f"literal_replay_{start}_{end}.csv"
    json_path = REPLAY_OUT / f"literal_replay_{start}_{end}_sector_views.json"
    df.to_csv(csv_path, index=False)
    json_path.write_text(json.dumps(all_sector_views, indent=2))

    print(f"\nwrote {len(df)} picks-across-{len(as_of_dates)}-weeks -> {csv_path}")
    if not df.empty:
        basket_c2c = ((df["week_close"] - df["signal_close"]) / df["signal_close"] * 100)
        print(f"  weeks              : {df['week'].nunique()}")
        print(f"  total picks         : {len(df)}")
        print(f"  mean close-to-close : {basket_c2c.mean():.3f}%  (headline, per decision Q7)")
        print(f"  mean trade-result   : {df['ret_pct_net'].mean():.3f}%  (net, with SL hits)")
        print(f"  win rate (c2c)      : {(basket_c2c > 0).mean() * 100:.1f}%")
        # Per-week alpha vs benchmark: one basket-mean-net and one benchmark value per
        # week, not per pick, so a 10-pick week doesn't outweigh a 1-pick week 10x.
        per_week = df.groupby("week").agg(net=("ret_pct_net", "mean"),
                                           bench=("benchmark_week_pct", "first"))
        per_week = per_week.dropna(subset=["bench"])
        if not per_week.empty:
            alpha = per_week["net"] - per_week["bench"]
            print(f"  mean benchmark ({rule_spec['sector']['benchmark_ticker']}) : "
                  f"{per_week['bench'].mean():.3f}%  (per-week open-to-close, holding week)")
            print(f"  mean alpha vs benchmark      : {alpha.mean():.3f}%")
            print(f"  weeks beating benchmark      : {(alpha > 0).sum()}/{len(per_week)}")

        # T1 redefined, item 4: build the SAME rolling-ledger row shape and call the
        # SAME rolling_stats() function replay() and grade() both use, over every
        # replayed week -- proving the live cadence and this historical sweep are one
        # code path, not two. Written to its own replay ledger file, never merged into
        # the live rolling_ledger.csv (that stays forward-only, HARNESS rule 4 spirit).
        per_week_c2c = df.groupby("week").apply(
            lambda g: pd.Series({
                "n_traded": len(g),
                "basket_close_to_close_pct": round(float(((g["week_close"] - g["signal_close"]) / g["signal_close"] * 100).mean()), 3),
                "winners_close_to_close": int(((g["week_close"] - g["signal_close"]) > 0).sum()),
                "basket_trade_result_net_pct": round(float(g["ret_pct_net"].mean()), 3),
                "benchmark_week_pct": g["benchmark_week_pct"].iloc[0],
            }), include_groups=False)
        replay_ledger = pd.DataFrame([
            _ledger_row(week, row["n_traded"], row["basket_close_to_close_pct"], row["basket_trade_result_net_pct"],
                        row["winners_close_to_close"], row["benchmark_week_pct"], source="replay")
            for week, row in per_week_c2c.iterrows()
        ])
        replay_ledger_path = REPLAY_OUT / f"rolling_ledger_replay_{start}_{end}.csv"
        replay_ledger.to_csv(replay_ledger_path, index=False)
        print(f"\nT1 (rolling window) as of {replay_ledger['signal_week'].iloc[-1]} -- "
              f"replay evidence, {replay_ledger_path}:")
        _print_rolling_stats(rolling_stats(replay_ledger, replay_ledger["signal_week"].iloc[-1]))
    return df


HORIZONS_OUT = OUT / "horizons"


def maturity_loop():
    """Step 5 extended (docs/literal-spec-plan.md, 27 Sep 2026): for every Literal
    cohort (results/literal_test/picks_<date>.json) that still has an ungraded
    configured horizon, grade whatever has newly matured and append ONLY the newly
    graded (ticker, horizon, view) rows to results/literal_test/horizons/<record_id>.jsonl.
    Append-only and idempotent -- a (ticker, horizon, view) already in that file is
    never re-written, so running this twice produces byte-identical output, and the
    original picks_<date>.json is never touched (HARNESS rule 4). Uses the exact same
    grade_horizons() replay_horizons() below calls -- one grading function, not two."""
    rule_spec, adapter, uni, panels, shares = env_literal()
    horizons = rule_spec["validation"]["horizons_weeks"]
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])

    cohorts = []
    tickers_needed = set()
    for p in sorted(OUT.glob("picks_*.json")):
        rec = json.loads(p.read_text())
        if rec.get("picks"):
            cohorts.append(rec)
            tickers_needed |= {r["ticker"] for r in rec["picks"]}
    if not cohorts:
        print("no Literal picks cohorts yet -- nothing to grade.")
        return

    daily_panels = adapter.daily_ohlcv(sorted(tickers_needed), rule_spec["data"]["history_weeks"] * 7)

    HORIZONS_OUT.mkdir(parents=True, exist_ok=True)
    total_new = 0
    for rec in cohorts:
        as_of = pd.Timestamp(rec["signal_week_start"])
        out_path = HORIZONS_OUT / f"{rec['record_id']}.jsonl"
        existing_keys = set()
        if out_path.exists():
            for line in out_path.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    existing_keys.add((row["ticker"], row["horizon_weeks"], row["view"]))

        rows = grade_horizons(rec["picks"], panels, as_of, horizons, bench, rule_spec, daily_panels=daily_panels)
        new_rows = [r for r in rows if r["status"] == "graded"
                    and (r["ticker"], r["horizon_weeks"], r["view"]) not in existing_keys]
        if new_rows:
            with out_path.open("a") as f:
                for r in new_rows:
                    f.write(json.dumps(r) + "\n")
            total_new += len(new_rows)
            print(f"  {rec['record_id']}: +{len(new_rows)} newly matured horizon row(s) -> {out_path}")
    print(f"maturity_loop: {total_new} new row(s) across {len(cohorts)} cohort(s)")


def replay_horizons(start_str: str = "2024-01-01", end_str: str | None = None):
    """Backtest evidence ONLY (HARNESS rule 4) -- the SAME grade_horizons() call
    maturity_loop() uses above, swept over historical Fridays instead of 'still-open
    cohorts today' (item 4 of the T1/Step-5-extended redefinition: live and replay are
    one code path). A full, deterministic rebuild each run (not append-only like the
    live maturity ledger) -- re-running it over the same range reproduces the same
    file byte-for-byte, which is the replay equivalent of the live loop's idempotency."""
    rule_spec, adapter, uni, panels, shares = env_literal()
    horizons = rule_spec["validation"]["horizons_weeks"]
    tickers = uni["ticker"].tolist()
    daily_panels = adapter.daily_ohlcv(tickers, rule_spec["data"]["history_weeks"] * 7)
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])

    dates = all_dates(panels)
    end = pd.Timestamp(end_str) if end_str else dates[-1]
    as_of_dates = [d for d in dates if pd.Timestamp(start_str) <= d <= end]
    if not as_of_dates:
        print(f"no weeks in range [{start_str}, {end_str}]")
        return

    REPLAY_OUT.mkdir(parents=True, exist_ok=True)
    out_path = REPLAY_OUT / f"horizons_replay_{as_of_dates[0].date()}_{as_of_dates[-1].date()}.jsonl"
    all_rows = []
    for as_of in as_of_dates:
        res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
        rows, _ = _build_picks_rows(res, rule_spec)
        graded_now = []
        if rows:
            graded_now = [r for r in grade_horizons(rows, panels, as_of, horizons, bench, rule_spec,
                                                       daily_panels=daily_panels) if r["status"] == "graded"]
            all_rows.extend(graded_now)
        # Incremental write, same reasoning as replay()/midweek_scan_replay(): keep
        # progress inspectable and nothing lost if a long run is killed partway.
        out_path.write_text("".join(json.dumps(r) + "\n" for r in all_rows))
        print(f"  {as_of.date()}: {len(rows)} picks, {len(graded_now)} horizon row(s) graded")
    print(f"replay_horizons: {len(all_rows)} graded row(s) across {len(as_of_dates)} week(s) -> {out_path}")
    return out_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "record":
        record()
    elif cmd == "grade":
        grade(sys.argv[2])
    elif cmd == "replay":
        replay(int(sys.argv[2]) if len(sys.argv) > 2 else 12)
    elif cmd == "rolling":
        rolling()
    elif cmd == "weekly_report":
        weekly_report(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "maturity":
        maturity_loop()
    elif cmd == "replay_horizons":
        replay_horizons(sys.argv[2] if len(sys.argv) > 2 else "2024-01-01",
                         sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == "midweek_scan":
        midweek_scan_record()
    elif cmd == "midweek_scan_grade":
        midweek_scan_grade(sys.argv[2])
    elif cmd == "midweek_scan_replay":
        midweek_scan_replay(sys.argv[2], sys.argv[3])
    else:
        print(__doc__); sys.exit(1)
