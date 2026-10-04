"""
1-/2-/3-week horizon grading for the manually-curated "T1-extra selected" shadow
basket (results/literal_test/t1_extra_selected_<date>.json) -- 20 of the 21 names
the frozen midweek_scan (old T1, run under Literal's rules) confirmed at Friday
close, after Dharmin excluded CLEANMAX.NS for invalidating (VStop flip_down + RSI
leaving [50,65]) at Monday's actual opening print. See that file's own `note` and
`grading_plan` fields for the full decision trail.

Reuses grade_horizons() verbatim -- the SAME function tests/track_literal.py's
maturity_loop() calls for the main Literal picks_*.json cohorts (HARNESS reuse-vs-
modify: do not fork it). maturity_loop() itself only globs picks_*.json, so this
basket (a different filename, t1_extra_selected_*.json, deliberately not matching
that glob so it's never picked up as if it were an official Literal cohort) needs
its own thin driver -- this script is that driver, nothing more.

Append-only and idempotent, same discipline as maturity_loop(): a (ticker, horizon,
view) row already present in the output .jsonl is never rewritten, so re-running
this after nothing new has matured is a no-op.

usage:
  python3 -m scripts.track_t1_extra_horizons results/literal_test/t1_extra_selected_2026-09-21.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.backtest.horizons import grade_horizons  # noqa: E402
from tests.offline import env_literal  # noqa: E402

HORIZONS_OUT = Path(__file__).resolve().parents[1] / "results" / "literal_test" / "horizons"


def _as_ep_sl_picks(picks: list[dict]) -> list[dict]:
    """grade_horizons() expects pick['EP']/pick['SL'] (the main Literal record()
    schema, via _build_picks_rows()) -- this basket's source records use
    signal_close/vstop_line_SL (scan_t1_week()'s schema) instead. Same convention
    the project already uses for this series: EP = Friday's own signal close
    (entry_price_source="signal_close", per midweek_scan_grade()/_grade_rows()),
    SL = the recorded VStop line at that close."""
    return [{"ticker": p["ticker"], "EP": p["signal_close"], "SL": p["vstop_line_SL"]} for p in picks]


def main(path: str):
    rec = json.loads(Path(path).read_text())
    rule_spec, adapter, uni, panels, shares = env_literal()
    horizons = rule_spec["validation"]["horizons_weeks"]
    bench = adapter.benchmark_series(rule_spec["sector"]["benchmark_ticker"], rule_spec["data"]["history_weeks"])

    picks = _as_ep_sl_picks(rec["picks"])
    tickers = [p["ticker"] for p in picks]
    daily_panels = adapter.daily_ohlcv(tickers, rule_spec["data"]["history_weeks"] * 7)

    as_of = pd.Timestamp(rec["signal_week_start"])
    out_path = HORIZONS_OUT / f"{rec['record_id']}.jsonl"
    existing_keys = set()
    if out_path.exists():
        for line in out_path.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                existing_keys.add((row["ticker"], row["horizon_weeks"], row["view"]))

    rows = grade_horizons(picks, panels, as_of, horizons, bench, rule_spec, daily_panels=daily_panels)
    new_rows = [r for r in rows if r["status"] == "graded" and (r["ticker"], r["horizon_weeks"], r["view"]) not in existing_keys]
    pending = sum(1 for r in rows if r["status"] == "pending")

    HORIZONS_OUT.mkdir(parents=True, exist_ok=True)
    if new_rows:
        with out_path.open("a") as f:
            for r in new_rows:
                f.write(json.dumps(r) + "\n")
    print(f"{rec['record_id']}: +{len(new_rows)} newly matured row(s), {pending} still pending -> {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
