"""
Step 5 extended (27 Sep 2026): maturity_loop() must be append-only and idempotent --
running it twice over the same cohort produces byte-identical output, and it never
touches the original picks_<date>.json (HARNESS rule 4). Hermetic: no data_cache_literal/
needed, env_literal() is monkeypatched.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

import tests.track_literal as tl
from tests.offline import make_panel


class _FakeAdapter:
    def __init__(self, daily_panels=None):
        self._daily_panels = daily_panels or {}

    def benchmark_series(self, ticker, history_weeks):
        return pd.DataFrame()

    def daily_ohlcv(self, tickers, history_days):
        return {t: self._daily_panels[t] for t in tickers if t in self._daily_panels}


def _setup(tmp_path, monkeypatch):
    closes = np.linspace(100.0, 160.0, 25)  # entry week 14, horizons 1-3 all gradable
    panel = make_panel(closes, start="2024-01-01")
    ticker = "T.NS"
    as_of = panel["date"].iloc[14]
    ep = float(panel["close"].iloc[14])

    rule_spec = {
        "signals": [{"id": "vstop_flip", "params": {"length": 10, "mult": 2.0, "source": "close"}}],
        "sector": {"benchmark_ticker": "^NSEI"},
        "data": {"history_weeks": 260},
        "validation": {"horizons_weeks": [1, 2, 3]},
    }
    uni = pd.DataFrame([{"ticker": ticker, "name": ticker, "sector": "Test"}])
    shares = {ticker: 3e8}
    panels = {ticker: panel}
    adapter = _FakeAdapter()

    monkeypatch.setattr(tl, "env_literal", lambda: (rule_spec, adapter, uni, panels, shares))
    monkeypatch.setattr(tl, "OUT", tmp_path)
    monkeypatch.setattr(tl, "HORIZONS_OUT", tmp_path / "horizons")

    rec = {
        "record_id": "lit_2024-04-08",
        "signal_week_start": str(as_of.date()),
        "picks": [{"ticker": ticker, "EP": ep, "SL": ep - 10.0}],
    }
    (tmp_path / f"picks_{as_of.date()}.json").write_text(json.dumps(rec))
    return tmp_path / "horizons" / "lit_2024-04-08.jsonl"


def test_maturity_loop_writes_graded_rows(tmp_path, monkeypatch):
    out_path = _setup(tmp_path, monkeypatch)
    tl.maturity_loop()
    assert out_path.exists()
    rows = [json.loads(line) for line in out_path.read_text().splitlines() if line.strip()]
    assert len(rows) == 6  # 3 horizons x 2 views, all gradable in this fixture
    assert all(r["status"] == "graded" for r in rows)


def test_maturity_loop_never_edits_the_original_pick_record(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    pick_path = tmp_path / "picks_2024-04-08.json"
    before = pick_path.read_text()
    tl.maturity_loop()
    assert pick_path.read_text() == before


def test_maturity_loop_is_idempotent(tmp_path, monkeypatch):
    out_path = _setup(tmp_path, monkeypatch)
    tl.maturity_loop()
    first = out_path.read_text()
    tl.maturity_loop()
    second = out_path.read_text()
    assert first == second, "running maturity_loop() twice must not duplicate or reorder rows"
