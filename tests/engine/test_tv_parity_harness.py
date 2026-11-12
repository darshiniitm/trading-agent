"""The TradingView parity harness (plan §6): tolerances and report logic, offline. The live comparison needs the
filled fixture + network and is run by `python -m scripts.watchlist_parity`."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from scripts import watchlist_parity as wp


def test_tolerances_match_the_plan_table():
    assert wp.TOLERANCES["perf_1y"][:2] == ("abs", 0.3)
    assert wp.TOLERANCES["avg_vol_10"][:2] == ("rel", 0.03) and wp.TOLERANCES["market_cap"][:2] == ("rel", 0.03)
    assert wp.TOLERANCES["beta_3y"][:2] == ("abs", 0.10)
    assert wp.TOLERANCES["vol_1m"][:2] == ("abs", 0.15)
    assert wp.TOLERANCES["rsi14"][:2] == ("rel", 0.01) and wp.TOLERANCES["cci20"][:2] == ("rel", 0.01)
    assert wp.TOLERANCES["pe"][:2] == ("rel", 0.05) and wp.TOLERANCES["yield"][:2] == ("rel", 0.05)


def test_compare_value_verdicts_and_notes():
    assert wp.compare_value("perf_1w", 1.25, 1.0)[0] == "PASS"
    v, note = wp.compare_value("perf_1w", 1.4, 1.0)
    assert v == "FAIL" and "adjusted vs unadjusted" in note
    assert wp.compare_value("rsi14", 60.5, 60.0)[0] == "PASS" and wp.compare_value("rsi14", 61.0, 60.0)[0] == "FAIL"
    assert wp.compare_value("beta_1y", 0.95, 1.0)[0] == "PASS" and wp.compare_value("beta_1y", 0.85, 1.0)[0] == "FAIL"
    assert wp.compare_value("tech_rating", "Buy", "Buy")[0] == "PASS" and wp.compare_value("tech_rating", "Buy", "Sell")[0] == "FAIL"
    assert wp.compare_value("pe", None, 20.0)[0] == "FAIL" and wp.compare_value("pe", 20.0, None)[0] == "SKIP"


def test_rating_gate_needs_eight_of_nine():
    rows = [{"metric": "tech_rating", "verdict": "PASS" if i < 8 else "FAIL"} for i in range(9)]
    assert wp.ratings_gate(rows)["tech_rating"]["ok"] is True
    rows = [{"metric": "tech_rating", "verdict": "PASS" if i < 7 else "FAIL"} for i in range(9)]
    assert wp.ratings_gate(rows)["tech_rating"]["ok"] is False
    assert wp.ratings_gate(rows[:3])["tech_rating"]["ok"] is None   # too few symbols to judge


def test_run_end_to_end_with_a_synthetic_fixture_and_report(tmp_path):
    idx = pd.bdate_range("2024-06-03", periods=400)
    c = np.linspace(100, 200, 400)
    df = pd.DataFrame({"date": idx, "open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000})
    fx = tmp_path / "fx.json"
    fx.write_text(json.dumps({"captured_at": "2026-10-14T15:30:00+05:30", "symbols": {"AAA": {"yahoo": "AAA.NS", "values": {"perf_1w": 0.0, "rsi14": 100.0, "tech_rating": "Strong buy"}}}}))
    results, gate, captured = wp.run(fx, history_fn=lambda s: df, fundamentals_fn=lambda syms: {s: {} for s in syms})
    assert captured.startswith("2026-10-14")
    by = {r["metric"]: r for r in results}
    assert by["rsi14"]["verdict"] == "PASS"
    report = wp.render_report(results, captured, gate)
    assert "| AAA | rsi14 |" in report and "Golden values captured: 2026-10-14" in report


def test_run_refuses_an_unfilled_fixture():
    with pytest.raises(SystemExit):
        wp.run()   # the committed fixture is deliberately empty until the screenshot values are entered
