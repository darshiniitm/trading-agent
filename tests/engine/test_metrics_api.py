"""P6: /metrics and /fundamentals endpoints + their data loaders (no network: factories are injected)."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from engine import fundamentals as fund
from engine import metrics_service as svc
from engine.app import create_app


def frame(n=400, start=100.0, end=200.0, first="2024-06-03"):
    idx = pd.bdate_range(first, periods=n)
    c = np.linspace(start, end, n)
    return pd.DataFrame({"date": idx, "open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 1000})


def test_benchmark_for_picks_nifty_for_nse_and_sp500_for_us():
    assert svc.benchmark_for("RELIANCE.NS") == "^NSEI"
    assert svc.benchmark_for("500325.BO") == "^NSEI"
    assert svc.benchmark_for("^NSEBANK") == "^NSEI"
    assert svc.benchmark_for("AAPL") == "^GSPC"
    assert svc.benchmark_for("^GSPC") == "^GSPC"


def test_compute_batch_isolates_errors_and_sets_beta_benchmark():
    calls = []

    def history(sym):
        calls.append(sym)
        if sym == "BAD.NS":
            raise RuntimeError("no data")
        return frame()

    out = svc.compute_batch(["A.NS", "BAD.NS", "AAPL"], "1D", history)
    assert out["BAD.NS"] == {"error": "no data"}
    assert out["A.NS"]["beta_benchmark"] == "^NSEI" and out["AAPL"]["beta_benchmark"] == "^GSPC"
    assert out["A.NS"]["rsi14"] is not None
    # benchmarks are loaded once each, not once per symbol
    assert calls.count("^NSEI") == 1 and calls.count("^GSPC") == 1


def test_compute_batch_empty_history_is_an_error_not_a_blank_row():
    out = svc.compute_batch(["X.NS"], "1D", lambda s: pd.DataFrame())
    assert "error" in out["X.NS"]


class FakeTicker:
    def __init__(self, sym, info=None, boom=False):
        self.sym, self._info, self.boom = sym, info or {}, boom

    @property
    def info(self):
        if self.boom:
            raise RuntimeError("rate limited")
        return self._info

    @property
    def quarterly_income_stmt(self):
        cols = pd.to_datetime(["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"])
        return pd.DataFrame({c: {"Total Revenue": r, "Diluted EPS": e} for c, r, e in
                             zip(cols, [10, 20, 30, 40, 999], [1.0, 2.0, 3.0, 4.0, 99.0])})

    @property
    def income_stmt(self):
        return pd.DataFrame()

    @property
    def dividends(self):
        idx = pd.to_datetime(["2020-01-01", pd.Timestamp.now().normalize() - pd.Timedelta(days=30),
                              pd.Timestamp.now().normalize() - pd.Timedelta(days=200)])
        return pd.Series([50.0, 3.0, 4.0], index=idx)


def test_fetch_fundamentals_ttm_sums_last_four_quarters_and_trailing_year_dividends():
    out = fund.fetch_fundamentals(["A.NS"], lambda s: FakeTicker(s, {"marketCap": 5e12, "sharesOutstanding": 1e9, "currency": "INR"}))
    row = out["A.NS"]
    assert row["revenue_ttm"] == 100 and row["eps_ttm"] == pytest.approx(10.0)
    assert row["dividend_ttm"] == pytest.approx(7.0)
    assert row["market_cap"] == 5e12 and row["shares_out"] == 1e9 and row["currency"] == "INR"


def test_fetch_fundamentals_failure_is_isolated_per_symbol():
    def factory(s):
        return FakeTicker(s, boom=(s == "B.NS"))

    out = fund.fetch_fundamentals(["A.NS", "B.NS"], factory)
    assert "error" in out["B.NS"] and "error" not in out["A.NS"]


def test_endpoints():
    app = create_app(offline=True, history_fn=lambda s: frame(), fundamentals_fn=lambda syms: {s: {"market_cap": 1.0} for s in syms})
    c = TestClient(app)
    r = c.get("/metrics", params={"symbols": "A.NS,B.NS", "tf": "1D"})
    assert r.status_code == 200 and set(r.json()) == {"A.NS", "B.NS"}
    assert c.get("/metrics", params={"symbols": "A.NS", "tf": "1M"}).status_code == 422
    assert c.get("/metrics", params={"symbols": ""}).status_code == 422
    assert c.get("/fundamentals", params={"symbols": "A.NS"}).json() == {"A.NS": {"market_cap": 1.0}}


def test_display_metrics_are_not_imported_by_screening_selection_or_grading():
    """Plan §9: no view value may reach the screen, selection or grading code."""
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    banned = re.compile(r"\b(engine\.metrics|engine\.metrics_service|engine\.fundamentals|from engine import [^\n]*\b(metrics|metrics_service|fundamentals))\b")
    allowed = {root / "engine" / "app.py", root / "engine" / "metrics_service.py", root / "engine" / "metrics.py", root / "engine" / "fundamentals.py"}
    offenders = [str(p) for d in ("engine", "src") for p in (root / d).rglob("*.py") if p not in allowed and banned.search(p.read_text())]
    assert offenders == []


def test_history_endpoint_returns_weekly_closes_for_a_benchmark_chart():
    c = TestClient(create_app(offline=True, history_fn=lambda s: frame(n=400)))
    body = c.get("/history/^NSEI", params={"weeks": 10}).json()
    assert body["symbol"] == "^NSEI" and len(body["closes"]) == 10 == len(body["dates"])
    assert body["closes"] == sorted(body["closes"])          # the fixture is a rising ramp
    empty = TestClient(create_app(offline=True, history_fn=lambda s: pd.DataFrame()))
    assert empty.get("/history/^NSEI").status_code == 404
