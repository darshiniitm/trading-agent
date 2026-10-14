"""
One-off: reconstruct Control's missing signal-week 2026-09-14 record.

`tests/track_forward.py:record()` always operates on `all_dates(panels)[-1]` -- whatever
week is CURRENTLY latest -- it has no way to target an arbitrary past signal week. By the
time this gap was noticed (27 Sep 2026 retrospective review), the latest cached week had
already moved past 2026-09-14, so `record()` can no longer reproduce it. This script
reuses the exact same primitives record() calls (run_screen, build_trades, score_row) with
an explicit as_of instead, to reconstruct what that week's screen would have picked.

This is unavoidably HINDSIGHT -- the outcome is already known -- so the record is marked
`"recording_mode": "reconstructed_after_the_fact"`, distinct from this codebase's existing
`late_backfill` label (which means "recorded a few hours/days late," not "reconstructed
weeks after the fact with the result already known"). It is not forward evidence.

Usage: python -m scripts.reconstruct_control_week
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from src.screen.candidate_score import score_row as _score_row
from src.screen.engine import run_screen
from src.trade.builder import build_trades, _rsi_band_bounds
from tests.offline import env
from tests.track_forward import EXIT_RULE, PRIOR, OUT, grade

# NOTE: 2026-09-14 turns out to be a zero-survivor Control week (VStop flip stage itself
# drops to 0 -- no near-misses either, this isn't a risk-cap/RSI-band rejection, nothing
# flipped bullish that Friday at all). tests/track_forward.py:grade() crashes on a
# genuinely empty picks+near_miss week (`df["status"]` on a columnless empty DataFrame) --
# a real latent bug, logged in this run's findings entry rather than silently patched into
# Control's frozen grade() without being asked. Handled here instead, so this script never
# depends on that code path being fixed.

AS_OF = pd.Timestamp("2026-09-14")
RECONSTRUCTED_ON = "2026-09-27"


def main():
    rule_spec, adapter, uni, panels, shares = env()

    res = run_screen(AS_OF, rule_spec, adapter, uni, panels, shares)
    survivors, near_miss = res["survivors"], res["near_miss"]
    trades = build_trades(survivors, rule_spec)
    taken = set(trades["ticker"]) if not trades.empty else set()

    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])
    bench_close = None
    if not bench.empty:
        b = bench[bench["date"] <= AS_OF]
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
            "ticker": tk, "name": s.get("name"), "sector": s.get("sector"),
            "status": "TRADE" if tk in taken else "SHADOW_rejected_by_risk_cap",
            "signal_close": round(float(s["close"]), 4),
            "vstop_line_SL": round(float(s["vstop_line"]), 4),
            "rsi": round(float(s["rsi"]), 3),
            "atr": round(float(s["atr"]), 4) if pd.notna(s.get("atr")) else None,
            "volume": float(s["volume"]) if pd.notna(s.get("volume")) else None,
            "avg_vol_8w": float(s["avg_vol_8w"]) if pd.notna(s.get("avg_vol_8w")) else None,
            "mktcap_cr": round(float(s["mktcap_cr"]), 1),
            "turnover_cr": round(float(s["median_weekly_turnover_cr"]), 2),
            "R_ref": round(R, 4), "R_pct_of_close": round(R / float(s["close"]) * 100, 3),
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
            "ticker": s["ticker"], "name": s.get("name"), "sector": s.get("sector"),
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
            "target_ref": None, "confidence": None,
            "EP": "PENDING — next week's open",
        }
        rs_val = None
        sec_rs = res["sector_rs"]
        if s.get("sector") in set(sec_rs.get("sector", [])):
            match = sec_rs[sec_rs["sector"] == s["sector"]]
            if not match.empty and rs_col in match.columns:
                rs_val = match.iloc[0][rs_col]
        near_row.update(_score_row(near_row, rule_spec, rsi_band, rs_val))
        near_rows.append(near_row)

    rec = {
        "record_id": f"fwd_{AS_OF.date()}",
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signal_week_start": str(AS_OF.date()),
        "signal_week_note": "weekly bar Mon..Fri; signal is that Friday's close",
        "grade_after": str((AS_OF + pd.Timedelta(weeks=1)).date()),
        "recording_mode": "reconstructed_after_the_fact",
        "reconstruction_note": (
            f"Control's main record for this signal week was never recorded live -- only a "
            f"T1 shadow scan exists for 2026-09-14. Reconstructed {RECONSTRUCTED_ON} using "
            f"run_screen()/build_trades() with as_of pinned to 2026-09-14, the outcome already "
            f"known. This is HINDSIGHT, not a forward record -- do not treat it as timely "
            f"forward evidence, and do not count it toward any statistical gate that requires "
            f"forward-mode weeks."
        ),
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
    p = OUT / f"picks_{AS_OF.date()}.json"
    if p.exists():
        print(f"REFUSING to overwrite an existing record: {p}")
        return
    p.write_text(json.dumps(rec, indent=2))
    print(f"reconstructed {len(rows)} picks (of {len(survivors)} survivors), "
          f"{len(near_rows)} near-miss(es) -> {p}")

    if not rows and not near_rows:
        print("zero survivors AND zero near-misses this week -- nothing to grade "
              "(tests.track_forward.grade() crashes on this exact case, see module "
              "docstring note above; constructing the graded summary directly instead).")
        bench_ret = None
        if not bench.empty and bench_close is not None:
            nb = bench[bench["date"] > AS_OF].sort_values("date")
            if not nb.empty:
                o, c = float(nb.iloc[0]["open"]), float(nb.iloc[0]["close"])
                bench_ret = round((c - o) / o * 100, 3)
        rec["graded"] = {
            "graded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "n_traded": 0, "basket_gross_pct": None, "basket_net_pct": None,
            "T2_basket_net_pct": None, "T3_basket_net_pct": None, "winners": 0,
            "benchmark_week_pct": bench_ret, "shadow_basket_net_pct": None,
            "n_near_miss": 0, "near_miss_basket_net_pct": None, "near_miss_winners": 0,
            "prior_expected_basket_pct": PRIOR["expected_basket_return_pct"],
            "detail": [], "near_miss_detail": [],
        }
        p.write_text(json.dumps(rec, indent=2))
        print(f"  benchmark week: {bench_ret}%  (no Control trades to compare against it)")
    else:
        print("Now grading via the real tests.track_forward.grade() (no separate logic):\n")
        grade(str(p))


if __name__ == "__main__":
    main()
