"""
Threshold experiment (docs/threshold-experiment-plan.md) — TX-01..TX-09.
Hermetic: synthetic picks records + the offline data_cache only, no network.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.config import load_rule_spec
from src.experiments import threshold as tx
from src.flags.timing import IST
from tests import track_threshold as tt

ROOT = Path(__file__).resolve().parents[1]
RULES = load_rule_spec(str(ROOT / "config" / "rules.yaml"))
CAPS = [15, 17.5, 20, 22.5, 25, 30, 40, 50]


def _registry():
    return tx.load_registry(rule_spec=RULES)


def _pick(ticker, close, sl, status=None, cap=0.15):
    ratio = (close - sl) / close
    return {"ticker": ticker, "name": ticker, "sector": "S", "signal_close": close, "vstop_line_SL": sl,
            "status": status or ("TRADE" if ratio <= cap else "SHADOW_rejected_by_risk_cap"),
            "confidence": 50.0}


def _picks_record(picks, week="2026-09-07", created="2026-09-13T19:36:41+00:00"):
    return {"record_id": f"fwd_{week}", "created_utc": created, "signal_week_start": week,
            "picks": picks, "near_miss": [], "graded": None}


# TX-01 ---------------------------------------------------------------------
def test_tx01_registry_loads_with_expected_arms():
    reg = _registry()
    assert [float(c) for c in reg["caps_pct"]] == CAPS
    assert [tx.arm_name(c) for c in reg["caps_pct"]][:2] == ["threshold-experiment_15", "threshold-experiment_17.5"]


def test_tx01_control_cap_must_match_rules_yaml():
    reg = _registry()
    bad = copy.deepcopy(RULES)
    bad["trade"]["max_r_pct"] = 0.20
    with pytest.raises(ValueError):
        tx.validate_registry(reg, bad)


def test_tx01_edit_after_lock_is_refused(tmp_path):
    p = tmp_path / "reg.yaml"
    p.write_text((ROOT / "config" / "threshold_experiment.yaml").read_text())
    tx.write_checksum(p)
    tx.load_registry(p, RULES)
    p.write_text(p.read_text().replace("caps_pct: [15, 17.5,", "caps_pct: [15, 18,"))
    with pytest.raises(ValueError):
        tx.load_registry(p, RULES)


def test_tx01_unsorted_or_duplicate_caps_rejected():
    reg = _registry()
    for caps in ([20, 15], [15, 15, 20], []):
        with pytest.raises(ValueError):
            tx.validate_registry({**reg, "caps_pct": caps})


# TX-02 ---------------------------------------------------------------------
def test_tx02_cap_boundary_is_inclusive_like_build_trades():
    assert tx.is_selected(tx.r_ratio({"signal_close": 100.0, "vstop_line_SL": 80.0}), 20)
    assert not tx.is_selected(tx.r_ratio({"signal_close": 100.0, "vstop_line_SL": 79.99}), 20)
    assert tx.is_selected(tx.r_ratio({"signal_close": 200.0, "vstop_line_SL": 165.0}), 17.5)


# TX-03 ---------------------------------------------------------------------
def test_tx03_real_2026_09_07_record():
    path = ROOT / "results" / "forward_test" / "picks_2026-09-07.json"
    if not path.exists():
        pytest.skip("picks_2026-09-07.json not on disk")
    rows, arms = tx.build_membership(json.loads(path.read_text())["picks"], _registry())
    assert arms["threshold-experiment_15"]["selected"] == ["JUBLPHARMA.NS", "SPLPETRO.NS"]
    assert arms["threshold-experiment_17.5"]["rejected"] == ["PINELABS.NS"]
    for c in (20, 22.5, 25, 30, 40, 50):
        assert arms[tx.arm_name(c)]["selected"] == ["JUBLPHARMA.NS", "PINELABS.NS", "SPLPETRO.NS"]


# TX-04 ---------------------------------------------------------------------
def test_tx04_control_arm_equals_build_trades_on_cached_weeks():
    from src.screen.engine import run_screen
    from src.trade.builder import build_trades
    from tests.offline import all_dates, env

    rule_spec, adapter, uni, panels, shares = env()
    reg = _registry()
    for as_of in all_dates(panels)[-4:]:
        res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
        surv = res["survivors"]
        trades = build_trades(surv, rule_spec)
        traded = set(trades["ticker"]) if not trades.empty else set()
        picks = [{"ticker": s["ticker"], "signal_close": float(s["close"]), "vstop_line_SL": float(s["vstop_line"]),
                  "status": "TRADE" if s["ticker"] in traded else "SHADOW_rejected_by_risk_cap"}
                 for _, s in surv.iterrows()]
        rows, arms = tx.build_membership(picks, reg)
        assert set(arms["threshold-experiment_15"]["selected"]) == traded, as_of
        assert all(c["status"] == "PASS" for c in tx.check_record(rows, arms, picks, reg)), as_of


# TX-05 ---------------------------------------------------------------------
def test_tx05_arms_nested_and_partition_survivors():
    picks = [_pick("A", 100, 90), _pick("B", 100, 82), _pick("C", 100, 76), _pick("D", 100, 55),
             {"ticker": "E", "signal_close": 100, "vstop_line_SL": None, "status": "NEAR"}]
    reg = _registry()
    rows, arms = tx.build_membership(picks, reg)
    checks = {c["id"]: c["status"] for c in tx.check_record(rows, arms, picks, reg)}
    assert checks == {"X1": "PASS", "X2": "PASS", "X3": "PASS"}
    assert arms["threshold-experiment_20"]["selected"] == ["A", "B"]
    assert arms["threshold-experiment_25"]["selected"] == ["A", "B", "C"]
    assert arms["threshold-experiment_50"]["selected"] == ["A", "B", "C", "D"]
    assert "E" not in arms["threshold-experiment_50"]["rejected"]


def test_tx05_x1_fails_if_control_status_disagrees():
    picks = [_pick("A", 100, 90, status="SHADOW_rejected_by_risk_cap")]
    reg = _registry()
    rows, arms = tx.build_membership(picks, reg)
    assert {c["id"]: c["status"] for c in tx.check_record(rows, arms, picks, reg)}["X1"] == "FAIL"


# TX-06 ---------------------------------------------------------------------
def _graded(picks_rec, rets):
    detail = [{"ticker": t, "ret_pct_net": r} for t, r in rets.items()]
    traded = [rets[p["ticker"]] for p in picks_rec["picks"] if p["status"] == "TRADE"]
    rec = copy.deepcopy(picks_rec)
    rec["graded"] = {"basket_net_pct": round(float(np.mean(traded)), 3) if traded else None,
                     "benchmark_week_pct": 0.5, "detail": detail}
    return rec


def test_tx06_grading_selected_rejected_and_zero_weeks(tmp_path):
    picks = [_pick("A", 100, 90), _pick("B", 100, 82), _pick("C", 100, 76)]
    prec = _picks_record(picks)
    ppath = tmp_path / "picks_2026-09-07.json"
    ppath.write_text(json.dumps(prec))
    rec = tt.record(str(ppath), tmp_path, created_at=datetime(2026, 9, 13, 10, 0, tzinfo=IST))
    ppath.write_text(json.dumps(_graded(prec, {"A": 2.0, "B": -4.0, "C": 10.0})))
    block = tt.grade(str(tmp_path / "threshold_2026-09-07.json"), tmp_path)
    pa = block["per_arm"]
    assert pa["threshold-experiment_15"]["selected_basket_net_pct"] == 2.0
    assert pa["threshold-experiment_15"]["rejected_basket_net_pct"] == 3.0
    assert pa["threshold-experiment_20"]["selected_basket_net_pct"] == -1.0
    assert pa["threshold-experiment_20"]["selected_minus_control_pct"] == -3.0
    assert pa["threshold-experiment_50"]["rejected_n"] == 0
    assert pa["threshold-experiment_50"]["rejected_basket_net_pct"] is None
    assert all(c["status"] == "PASS" for c in block["checks"])
    ledger = pd.read_csv(tmp_path / tt.LEDGER)
    assert len(ledger) == len(CAPS)


def test_tx06_zero_selected_week_counts_as_zero_not_dropped(tmp_path):
    picks = [_pick("D", 100, 55)]
    prec = _picks_record(picks)
    ppath = tmp_path / "picks_2026-09-07.json"
    ppath.write_text(json.dumps(prec))
    tt.record(str(ppath), tmp_path, created_at=datetime(2026, 9, 13, 10, 0, tzinfo=IST))
    ppath.write_text(json.dumps(_graded(prec, {"D": -7.0})))
    pa = tt.grade(str(tmp_path / "threshold_2026-09-07.json"), tmp_path)["per_arm"]
    assert pa["threshold-experiment_15"]["selected_n"] == 0
    assert pa["threshold-experiment_15"]["selected_basket_net_pct"] == 0.0
    assert pa["threshold-experiment_50"]["selected_basket_net_pct"] == -7.0


# TX-07 ---------------------------------------------------------------------
def test_tx07_record_is_immutable_and_tamper_is_detected(tmp_path, capsys):
    picks = [_pick("A", 100, 90), _pick("B", 100, 82)]
    prec = _picks_record(picks)
    ppath = tmp_path / "picks_2026-09-07.json"
    ppath.write_text(json.dumps(prec))
    assert tt.record(str(ppath), tmp_path) is not None
    assert tt.record(str(ppath), tmp_path) is None
    assert "REFUSING" in capsys.readouterr().out
    tampered = _graded(prec, {"A": 1.0, "B": 1.0})
    tampered["picks"][0]["vstop_line_SL"] = 91.0
    ppath.write_text(json.dumps(tampered))
    block = tt.grade(str(tmp_path / "threshold_2026-09-07.json"), tmp_path)
    assert {c["id"]: c["status"] for c in block["checks"]}["X4"] == "FAIL"


def test_tx07_ungraded_control_is_not_graded(tmp_path):
    ppath = tmp_path / "picks_2026-09-07.json"
    ppath.write_text(json.dumps(_picks_record([_pick("A", 100, 90)])))
    tt.record(str(ppath), tmp_path)
    assert tt.grade(str(tmp_path / "threshold_2026-09-07.json"), tmp_path) is None


# TX-08 ---------------------------------------------------------------------
def test_tx08_mode_needs_both_records_before_monday_open(tmp_path):
    before = datetime(2026, 9, 13, 10, 0, tzinfo=IST)
    after = datetime(2026, 9, 14, 9, 16, tzinfo=IST)
    as_of = pd.Timestamp("2026-09-07")
    early = {"created_utc": "2026-09-13T04:00:00+00:00"}
    late = {"created_utc": "2026-09-14T04:00:00+00:00"}   # 09:30 IST Monday
    assert tt._mode(early, as_of, before) == "forward"
    assert tt._mode(early, as_of, after) == "late_backfill"
    assert tt._mode(late, as_of, before) == "late_backfill"


# TX-09 ---------------------------------------------------------------------
def test_tx09_summary_counts_weeks_and_corrects_only_differing_arms():
    reg = _registry()
    rows = []
    rng = np.random.default_rng(0)
    for w in range(14):
        ctrl = float(rng.normal(0, 2))
        for c in CAPS:
            name = tx.arm_name(c)
            diff = 0.0 if c < 20 else (1.0 if w % 2 else 0.0)
            rows.append({"experiment": reg["experiment"], "recording_mode": "forward",
                         "signal_week": f"2026-{w:02d}", "arm": name, "cap_pct": c,
                         "selected_n": 1, "selected_basket_net_pct": ctrl + diff, "selected_winners": 1,
                         "selected_worst_trade_pct": -1.0, "rejected_n": 0 if c >= 20 else 1,
                         "rejected_basket_net_pct": None if c >= 20 else 0.3,
                         "selected_minus_control_pct": diff})
    res = tx.summarize(pd.DataFrame(rows), reg)
    ctrl = res[res["is_control"]].iloc[0]
    assert ctrl["weeks"] == 14 and ctrl["maturity"] == "FIRST_LOOK"
    assert pd.isna(ctrl["minus_control_q_bh"])
    assert pd.isna(res[res["arm"] == "threshold-experiment_17.5"].iloc[0]["minus_control_q_bh"])
    assert res[res["arm"] == "threshold-experiment_20"].iloc[0]["weeks_differing_from_control"] == 7
    assert not pd.isna(res[res["arm"] == "threshold-experiment_50"].iloc[0]["minus_control_q_bh"])
