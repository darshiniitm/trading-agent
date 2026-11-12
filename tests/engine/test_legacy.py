"""The app's persistence layer speaks in candidates / entered / watching / graded rows; these check the
v5 -> legacy-shape endpoints (/screen, /select, /validate) it now calls."""
import copy

import pandas as pd
import pytest

from tests.engine.v5_fixtures import literal_program


def _last(env):
    return sorted({pd.Timestamp(d) for p in env.panels.values() for d in p["date"]})


def test_screen_returns_candidates_in_the_stored_shape(client, literal_env):
    as_of = str(_last(literal_env)[-10].date())
    out = client.post("/screen", json={"program": literal_program(), "as_of": as_of}).json()
    assert out["funnel"][0]["stage"] == "universe" and out["applied_steps"]
    assert out["candidates"], "pick a week with real candidates"
    c = out["candidates"][0]
    assert c["membership"] == "full_match" and c["failed_ids"] == []
    assert {"ticker", "values", "ep", "sl", "r"} <= set(c) and "entry_price" not in c
    assert c["sl"] < c["ep"] and c["r"] == pytest.approx(c["ep"] - c["sl"])
    assert c["values"]["C3"]["uptrend"] is True          # an event condition reports its own state
    assert set(c["values"]) == {"C1", "C2", "C3", "C4"}  # every condition's value, by id


def test_select_enters_only_with_a_real_entry_price_and_never_fabricates_one(client, literal_env):
    dates = _last(literal_env)
    early = client.post("/select", json={"program": literal_program(next_open=True), "as_of": str(dates[-10].date())}).json()
    assert early["entered"] and all(e["entry_price"] for e in early["entered"])
    # the newest week has no following bar yet, so a next-open entry can't be priced: no_point_data, never a guess
    latest_prog = literal_program(next_open=True)
    latest_prog["conditions"][3]["value"] = [0, 100]   # loosen RSI so the newest week has matches too
    latest = client.post("/select", json={"program": latest_prog, "as_of": str(dates[-1].date())}).json()
    assert latest["entered"] == [] and all(r["reason"] for r in latest["no_point_data"])


def test_select_with_signal_close_entry_uses_the_signal_close(client, literal_env):
    as_of = str(_last(literal_env)[-10].date())
    out = client.post("/select", json={"program": literal_program(next_open=False), "as_of": as_of}).json()
    assert out["entered"] and all(e["entry_price"] == pytest.approx(e["ep"]) for e in out["entered"])


def test_near_misses_come_back_as_watching(client, literal_env):
    prog = copy.deepcopy(literal_program())
    prog["sets"][0]["near_miss"] = {"max_failed": 1}
    out = client.post("/select", json={"program": prog, "as_of": str(_last(literal_env)[-10].date())}).json()
    assert out["watching"] and all(w["membership"] == "near_miss" and w["failed_ids"] for w in out["watching"])


def test_unanswered_program_is_a_422_not_a_500(client):
    bad = copy.deepcopy(literal_program())
    bad["needs_input"] = [{"path": "conditions.C4.params.length", "reason": "missing"}]
    r = client.post("/screen", json={"program": bad, "as_of": "2026-08-03"})
    assert r.status_code == 422


def test_validate_maturity_gate_and_stop_requirements(client):
    prog = literal_program()
    picks = [{"ticker": "AAA.NS", "entry_price": 100.0, "sl": 90.0}]
    body = {"prompt_id": 1, "program": prog, "as_of": "2026-01-05", "picks": picks}
    early = client.post("/validate", json={**body, "graded_weeks_so_far": 3}).json()
    assert early == {"graded_weeks": 3, "maturity": "not_first_look", "rows": []}
    ok = client.post("/validate", json={**body, "graded_weeks_so_far": 13}).json()
    assert ok["maturity"] == "first_look" and ok["rows"]          # a ticker with no bars -> pending rows, not a crash
    assert {r["status"] for r in ok["rows"]} == {"pending"}
    no_stop = copy.deepcopy(prog); no_stop["actions"][0].pop("stop")
    r = client.post("/validate", json={**body, "program": no_stop, "graded_weeks_so_far": 26})
    assert r.status_code == 422 and "stop" in r.json()["detail"]


def test_validate_grades_real_picks_with_the_tradingview_vstop(client, literal_env):
    from tests.engine.v5_fixtures import literal_program as lp
    dates = _last(literal_env)
    as_of = dates[-10]
    sel = client.post("/select", json={"program": lp(next_open=True), "as_of": str(as_of.date())}).json()["entered"]
    picks = [{"ticker": e["ticker"], "entry_price": e["entry_price"], "sl": e["sl"]} for e in sel]
    out = client.post("/validate", json={"prompt_id": 1, "program": lp(), "as_of": str(as_of.date()), "picks": picks, "graded_weeks_so_far": 30}).json()
    assert out["maturity"] == "real_read"
    graded = [r for r in out["rows"] if r["status"] == "graded"]
    assert graded and {r["view"] for r in graded} == {"signal", "trade"}
    assert all(isinstance(r["r_Nw"], float) for r in graded)
