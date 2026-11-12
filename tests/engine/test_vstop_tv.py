"""The v5 VStop is a statement-for-statement port of TradingView's Pine v6 'Volatility Stop'."""
import numpy as np
import pandas as pd

from src.indicators.vstop_tv import compute_vstop_tv


def _bars(closes, spread=1.0):
    c = np.asarray(closes, float)
    return pd.DataFrame({"open": c, "high": c + spread, "low": c - spread, "close": c})


def test_hand_computed_series_matches_the_pine_recurrence():
    # length 3, mult 2, TR = 2 on bars 0-2; ATR (RMA seeded by the SMA of the first 3 TRs) = 2 at bar 2.
    # Bar 3 drops to 5: TR = 8, ATR = (2*2+8)/3 = 4 -> band 8; the old stop (10) is broken, so VStop flips
    # down and re-seeds from the source: stop = min + band = 5 + 8 = 13.
    v = compute_vstop_tv(_bars([10, 11, 12, 5]), length=3, mult=2.0)
    assert v["vstop_line"].tolist() == [10, 10, 10, 13]
    assert v["uptrend"].tolist() == [True, True, True, False]
    assert v["flip_down"].tolist() == [False, False, False, True]
    assert not v["flip_up"].any()
    assert np.isnan(v["atr"].iloc[1]) and v["atr"].iloc[2] == 2.0 and v["atr"].iloc[3] == 4.0


def test_first_bar_stop_is_the_source_and_the_trend_starts_up():
    v = compute_vstop_tv(_bars([100, 101, 99]), length=2, mult=2.0)
    assert v["vstop_line"].iloc[0] == 100 and bool(v["uptrend"].iloc[0]) and not v["flip_up"].iloc[0]


def test_runs_from_bar_one_using_raw_true_range_until_atr_exists():
    # warm-up band = raw TR (not TR * mult), as in nz(ta.atr(len) * factor, ta.tr)
    v = compute_vstop_tv(_bars([10, 11, 9], spread=1.0), length=5, mult=4.0)
    assert v["atr"].isna().all()
    assert v["vstop_line"].notna().all()


def test_stop_only_ratchets_up_in_an_uptrend_and_flips_are_consistent():
    rng = np.random.default_rng(3)
    v = compute_vstop_tv(_bars(100 + np.cumsum(rng.normal(0, 1.5, 300)), 0.8), length=10, mult=2.0)
    up, line = v["uptrend"].to_numpy(), v["vstop_line"].to_numpy()
    for i in range(1, len(v)):
        if up[i] and up[i - 1] and not v["flip_up"].iloc[i]:
            assert line[i] >= line[i - 1] - 1e-12
        assert v["flip_up"].iloc[i] == (up[i] and not up[i - 1])
        assert v["flip_down"].iloc[i] == (not up[i] and up[i - 1])


def test_the_v5_registry_uses_it():
    from engine.v5.registry import INDICATORS
    out = INDICATORS["vstop"].compute(_bars([10, 11, 12, 5]), {"length": 3, "mult": 2.0, "source": "close"})
    assert out["stop_line"].tolist() == [10, 10, 10, 13]


def test_is_a_drop_in_for_the_original_returns_the_input_columns_too():
    v = compute_vstop_tv(_bars([10, 11, 12, 5]), length=3, mult=2.0)
    assert {"open", "high", "low", "close", "vstop_line", "uptrend", "flip_up", "flip_down"} <= set(v.columns)
