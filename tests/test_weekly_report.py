"""
weekly_report() assembly smoke test: it must run over already-recorded evidence
(a picks_<date>.json plus a matured horizons/*.jsonl and a rolling ledger row)
without re-screening or crashing, and its output must actually include the numbers
those sources hold -- not just "it didn't raise".
"""
from __future__ import annotations

import json

import tests.track_literal as tl


def test_weekly_report_reads_recorded_evidence_without_recomputing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tl, "OUT", tmp_path)
    monkeypatch.setattr(tl, "HORIZONS_OUT", tmp_path / "horizons")
    monkeypatch.setattr(tl, "ROLLING_LEDGER", tmp_path / "rolling_ledger.csv")

    rec = {
        "record_id": "lit_2024-04-08",
        "signal_week_start": "2024-04-08",
        "funnel": {"in_band": 500, "qualified": 1},
        "sector_view": [{"sector": "Test", "n_qualified": 1, "rs_4w": 1.2, "rs_1w": 0.3, "rs_13w": 4.5}],
        "picks": [{"ticker": "T.NS", "signal_close": 150.0, "vstop_line_SL": 140.0, "rsi": 55.0,
                    "EP": 150.0, "SL": 140.0, "R": 10.0, "target": 170.0, "confidence": 62.0}],
    }
    (tmp_path / "picks_2024-04-08.json").write_text(json.dumps(rec))

    (tmp_path / "horizons").mkdir()
    horizon_rows = [
        {"ticker": "T.NS", "horizon_weeks": 1, "view": "signal", "status": "graded",
         "r_Nw": 2.5, "bench_Nw": 0.5},
        {"ticker": "T.NS", "horizon_weeks": 1, "view": "trade", "status": "graded",
         "r_Nw": 2.5, "bench_Nw": 0.5},
    ]
    (tmp_path / "horizons" / "lit_2024-04-08.jsonl").write_text(
        "\n".join(json.dumps(r) for r in horizon_rows) + "\n")

    tl.weekly_report()
    out = capsys.readouterr().out

    assert "signal week 2024-04-08" in out
    assert "in_band" in out and "500" in out
    assert "T.NS" in out
    assert "Test" in out  # sector view
    assert "1w (signal): basket mean 2.5%" in out
    assert "no rolling ledger yet" in out  # rolling() ran too, honestly reported empty


def test_weekly_report_handles_no_records_gracefully(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(tl, "OUT", tmp_path)
    tl.weekly_report()
    assert "no Literal picks recorded yet" in capsys.readouterr().out
