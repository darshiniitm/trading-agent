"""M4: tri-state evaluation, stock outcomes (spec §5), coverage and run status (§7), acceptance #4, #5, #7, #8, #9."""
from __future__ import annotations

import dataclasses
from datetime import date

import numpy as np
import pandas as pd
import pytest

from engine.resolution.coverage import compute_coverage, is_scored
from engine.resolution.types import ResolvedData
from engine.v5.run import run_program
from tests.engine.test_v5_engine import ind, prog
from tests.engine.v5_fixtures import ctx_for, daily

SMA = {"id": "C1", "lhs": ind("sma", length=6, source="close"), "op": ">", "rhs": ind("sma", length=30, source="close")}
RSI = {"id": "C2", "lhs": ind("rsi", length=14), "op": ">", "value": 0}
PRICE = {"id": "C3", "lhs": {"field": "price"}, "op": "<", "value": 50}
AS_OF = "2023-06-30"
UP = np.linspace(100, 160, 80)


def rows(out, sid="S1"):
    return out["sets"][sid]


def test_new_listing_is_unevaluated_insufficient_history():           # acceptance #4
    ctx = ctx_for({"OLD.NS": daily(UP), "NEW.NS": daily(UP[:20])})
    out = run_program(prog([SMA]), AS_OF, ctx)
    assert [m["ticker"] for m in rows(out)["members"]] == ["OLD.NS"]
    un = rows(out)["unevaluated"]
    assert [u["ticker"] for u in un] == ["NEW.NS"] and un[0]["reasons"] == ["insufficient_history"]
    assert un[0]["conditions"]["C1"]["state"] == "?"


def test_zero_beats_unknown():                                         # acceptance #5
    # NEW fails the (known) price condition and cannot compute SMA30 -> rejected, not unevaluated
    ctx = ctx_for({"OK.NS": daily(np.full(80, 10.0)), "NEW.NS": daily(np.full(20, 500.0))})
    out = run_program(prog([PRICE, SMA], where=("C3", "C1")), AS_OF, ctx)
    assert "NEW.NS" not in [u["ticker"] for u in rows(out)["unevaluated"]]
    assert out["run_coverage"]["fully_evaluated"] == 2


def test_unknown_on_one_and_pass_on_other_is_unevaluated_not_rejected():
    ctx = ctx_for({"NEW.NS": daily(np.full(20, 10.0))})
    out = run_program(prog([PRICE, SMA], where=("C3", "C1")), AS_OF, ctx)
    u = rows(out)["unevaluated"][0]
    assert u["unknown_count"] == 1 and u["met_count"] == 1


def test_any_node_true_beats_unknown_and_not_of_unknown_is_unknown():
    ctx = ctx_for({"NEW.NS": daily(np.full(20, 10.0))})
    out = run_program(prog([PRICE, SMA], sets=[{"id": "S1", "from": "universe", "where": {"any": ["C3", "C1"]}}]), AS_OF, ctx)
    assert [m["ticker"] for m in rows(out)["members"]] == ["NEW.NS"]
    out = run_program(prog([SMA], sets=[{"id": "S1", "from": "universe", "where": {"not": ["C1"]}}]), AS_OF, ctx)
    assert rows(out)["members"] == [] and len(rows(out)["unevaluated"]) == 1


def test_no_panel_at_all_is_no_data():
    ctx = ctx_for({"A.NS": daily(UP)})
    ctx.universe_df.loc[len(ctx.universe_df)] = {"ticker": "GHOST.NS", "name": "g", "sector": "Tech"}
    out = run_program(prog([SMA]), AS_OF, ctx)
    ghost = [u for u in rows(out)["unevaluated"] if u["ticker"] == "GHOST.NS"][0]
    assert ghost["reasons"] == ["no_data"]


def prov(fields=None, quality="ok", reason=None, source="yahoo"):
    return ResolvedData(None, source, date(2023, 6, 30), pd.Timestamp.now(), quality, reason, meta={"fields": fields} if fields else {})


def test_close_only_source_sma_evaluates_vstop_is_partial_fields():   # acceptance #7
    ctx = ctx_for({"G.NS": daily(UP)}, provenance={"G.NS": prov(["close"], "fallback", "partial_fields", "google_finance")})
    vstop = {"id": "C4", "lhs": ind("vstop", tf="1W", length=10, mult=2, source="close"), "op": "flip", "dir": "long", "within_bars": 1}
    out = run_program(prog([SMA, vstop], where=("C1", "C4")), AS_OF, ctx, full_table=True)
    cells = out["table"]["rows"][0]["conditions"]
    assert cells["C1"]["state"] in (0, 1) and cells["C4"]["state"] == "?" and cells["C4"]["reason"] == "partial_fields"
    assert cells["C1"]["input_quality"] == "fallback"
    assert rows(out)["unevaluated"][0]["reasons"] == ["partial_fields"]


def test_stale_and_approx_inputs_still_produce_state_with_warnings():
    ctx = ctx_for({"S.NS": daily(UP)}, provenance={"S.NS": prov(None, "stale", "stale_data")})
    out = run_program(prog([SMA]), AS_OF, ctx, full_table=True)
    cell = out["table"]["rows"][0]["conditions"]["C1"]
    assert cell["state"] in (0, 1) and "stale_data" in cell["warnings"] and cell["input_quality"] == "stale"


def test_unfeedable_sector_condition_is_not_applied_run_partial():   # acceptance #8 + #9
    sector = {"id": "C5", "lhs": {"field": "sector"}, "op": "==", "value": "Tech"}
    ctx = ctx_for({"A.NS": daily(UP), "B.NS": daily(UP)}, sector_available=False)
    out = run_program(prog([SMA, sector], where=("C1", "C5")), AS_OF, ctx, full_table=True)
    cov = out["run_coverage"]
    assert cov["unfeedable_conditions"] == ["C5"] and cov["status"] == "partial" and cov["per_condition"]["C5"] == 0.0
    assert {m["ticker"] for m in rows(out)["members"]} == {"A.NS", "B.NS"}        # still screened on the remaining condition
    assert out["table"]["rows"][0]["conditions"]["C5"]["reason"] == "condition_unfeedable"
    assert out["feasibility"]["conditions"]["C5"]["status"] == "unavailable"
    assert out["feasibility"]["conditions"]["C1"]["status"] == "ready"
    assert set(out["table"]["conditions"]) == {"C1", "C5"}                         # nothing substituted or added


def test_all_conditions_unfeedable_means_everything_unevaluated():
    sector = {"id": "C5", "lhs": {"field": "sector"}, "op": "==", "value": "Tech"}
    ctx = ctx_for({"A.NS": daily(UP)}, sector_available=False)
    out = run_program(prog([sector], where=("C5",)), AS_OF, ctx)
    assert rows(out)["members"] == [] and rows(out)["unevaluated"][0]["reasons"] == ["condition_unfeedable"]


# ---------------------------------------------------------------- coverage / status / scoring
def oc(q, r, u): return {**{f"q{i}": {"outcome": "qualified"} for i in range(q)}, **{f"r{i}": {"outcome": "rejected"} for i in range(r)},
                         **{f"u{i}": {"outcome": "unevaluated"} for i in range(u)}}


@pytest.mark.parametrize("q,r,u,uq,unf,status", [
    (50, 45, 5, "ok", [], "complete"),            # 95%
    (50, 44, 6, "ok", [], "partial"),             # 94%
    (50, 20, 30, "ok", [], "low_coverage"),       # 70% exactly -> partial; 20 -> <0.70
    (50, 50, 0, "approx", [], "partial"),
    (50, 50, 0, "stale", [], "partial"),
    (50, 50, 0, "fallback", [], "complete"),
    (50, 50, 0, "ok", ["C5"], "partial"),
])
def test_status_rules(q, r, u, uq, unf, status):
    cov = compute_coverage(q + r + u, oc(q, r, u), {}, uq, unf)
    if (q, r, u) == (50, 20, 30):
        assert cov["coverage"] == 0.70 and cov["status"] == "partial"        # boundary: >= partial_min
        cov = compute_coverage(100, oc(50, 19, 31), {}, uq, unf)
    assert cov["status"] == status


def test_only_complete_runs_are_scored():                               # acceptance #10 (engine side)
    assert is_scored("complete") and not is_scored("partial") and not is_scored("low_coverage")
    assert is_scored("partial", {"scoring": {"exclude_partial_runs": False}})


def test_default_run_is_complete_with_full_coverage():
    ctx = ctx_for({"A.NS": daily(UP), "B.NS": daily(UP)})
    out = run_program(prog([SMA]), AS_OF, ctx)
    assert out["run_coverage"]["status"] == "complete" and out["run_coverage"]["scored"] is True
