"""T-02: each rule type on synthetic rows, including boundary values and downtrend -> 0 cases."""
from __future__ import annotations

from src.flags.registry import load_registry
from src.flags.rules import evaluate_flag

CTX = {
    "rsi_lo": 50.0, "rsi_hi": 65.0, "max_r_pct": 0.15, "sector_outperforming_rs_gt": 0.0,
    "guardrail_consts": {"HEADROOM_FULL_CREDIT_PCT": 5.0, "LIQUIDITY_FULL_CREDIT_MULTIPLE": 2.0,
                          "BAND_POSITION_FULL_CREDIT": 0.5},
}


def _flag(fid):
    reg = load_registry()
    return next(f for f in reg["flags"] if f["id"] == fid)


def test_a01_bool_field():
    f = _flag("A01_vstop_flip_up")
    assert evaluate_flag(f, {"flip_up": True}, CTX) == 1
    assert evaluate_flag(f, {"flip_up": False}, CTX) == 0
    assert evaluate_flag(f, {"flip_up": None}, CTX) is None


def test_a03_rsi_in_band_boundaries_inclusive():
    f = _flag("A03_rsi_in_band")
    assert evaluate_flag(f, {"rsi": 49.999}, CTX) == 0
    assert evaluate_flag(f, {"rsi": 50.0}, CTX) == 1
    assert evaluate_flag(f, {"rsi": 65.0}, CTX) == 1
    assert evaluate_flag(f, {"rsi": 65.001}, CTX) == 0
    assert evaluate_flag(f, {"rsi": None}, CTX) is None


def test_a04_risk_cap_ok_downtrend_is_zero_not_blank():
    f = _flag("A04_risk_cap_ok")
    assert evaluate_flag(f, {"uptrend": False, "close": 100, "vstop_line": 90}, CTX) == 0


def test_a04_risk_cap_ok_boundary_exactly_at_cap():
    f = _flag("A04_risk_cap_ok")
    # R/close == 0.15 exactly -> still ok (<=)
    row = {"uptrend": True, "close": 100.0, "vstop_line": 85.0}
    assert evaluate_flag(f, row, CTX) == 1
    row2 = {"uptrend": True, "close": 100.0, "vstop_line": 84.9}
    assert evaluate_flag(f, row2, CTX) == 0
    row3 = {"uptrend": True, "close": 100.0, "vstop_line": 100.0}
    assert evaluate_flag(f, row3, CTX) == 0  # R <= 0


def test_b04_volume_expansion_boundary_exactly_1_5():
    f = _flag("B04_volume_expansion")
    assert evaluate_flag(f, {"volume": 150.0, "avg_vol_8w": 100.0}, CTX) == 1
    assert evaluate_flag(f, {"volume": 149.999, "avg_vol_8w": 100.0}, CTX) == 0
    assert evaluate_flag(f, {"volume": 150.0, "avg_vol_8w": None}, CTX) is None
    assert evaluate_flag(f, {"volume": 150.0, "avg_vol_8w": 0}, CTX) is None


def test_b05_trend_quality_downtrend_is_zero():
    f = _flag("B05_trend_quality_strong")
    assert evaluate_flag(f, {"uptrend": False, "close": 100, "vstop_line": 90, "atr": 2}, CTX) == 0


def test_b05_trend_quality_boundary_exactly_2_atr():
    f = _flag("B05_trend_quality_strong")
    row = {"uptrend": True, "close": 100.0, "vstop_line": 96.0, "atr": 2.0}  # (100-96)/2 = 2.0
    assert evaluate_flag(f, row, CTX) == 1
    row2 = {"uptrend": True, "close": 100.0, "vstop_line": 96.1, "atr": 2.0}
    assert evaluate_flag(f, row2, CTX) == 0


def test_b06_rsi_sweetspot_core():
    f = _flag("B06_rsi_sweetspot_core")
    assert evaluate_flag(f, {"rsi": 57.5}, CTX) == 1  # band centre, kernel=1.0
    assert evaluate_flag(f, {"rsi": 50.0}, CTX) == 0  # kernel=0 at edge


def test_c01_headroom_downtrend_forced_zero_even_if_value_would_pass():
    f = _flag("C01_risk_headroom_5pp")
    assert evaluate_flag(f, {"uptrend": False, "risk_cap_headroom_pct": 10.0}, CTX) == 0


def test_c01_headroom_boundary_exactly_5pp():
    f = _flag("C01_risk_headroom_5pp")
    assert evaluate_flag(f, {"uptrend": True, "risk_cap_headroom_pct": 5.0}, CTX) == 1
    assert evaluate_flag(f, {"uptrend": True, "risk_cap_headroom_pct": 4.999}, CTX) == 0
    assert evaluate_flag(f, {"uptrend": True, "risk_cap_headroom_pct": None}, CTX) is None


def test_c02_liquidity_boundary_exactly_2x():
    f = _flag("C02_liquidity_2x")
    assert evaluate_flag(f, {"liquidity_multiple": 2.0}, CTX) == 1
    assert evaluate_flag(f, {"liquidity_multiple": 1.999}, CTX) == 0


def test_c03_band_position_boundary_exactly_half():
    f = _flag("C03_cap_band_central")
    assert evaluate_flag(f, {"band_position": 0.5}, CTX) == 1
    assert evaluate_flag(f, {"band_position": 0.4999}, CTX) == 0


def test_b01_sector_rs_uses_control_threshold():
    f = _flag("B01_sector_rs_4w_pos")
    assert evaluate_flag(f, {"rs_4w": 0.0001}, CTX) == 1
    assert evaluate_flag(f, {"rs_4w": 0.0}, CTX) == 0
    assert evaluate_flag(f, {"rs_4w": None}, CTX) is None


def test_diagnostics_never_counted_but_still_evaluate():
    f = _flag("D_rsi_above_band")
    assert not f["countable"]
    assert evaluate_flag(f, {"rsi": 70.0}, CTX) == 1
    assert evaluate_flag(f, {"rsi": 60.0}, CTX) == 0
