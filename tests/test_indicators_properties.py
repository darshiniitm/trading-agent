"""
Indicator property + edge-case tests — test plan section 4.

Properties that must hold for ANY input, plus the edge cases where a wrong
value would silently pass a band check rather than raise.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.indicators.rsi import compute_rsi
from src.indicators.vstop import compute_vstop, wilder_atr
from tests.offline import env, make_panel

RNG = np.random.default_rng(7)


def random_panel(n=120, seed=0):
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.03, n)))
    spread = np.abs(rng.normal(0, 0.015, n)) * close
    high = close + spread
    low = close - spread
    open_ = close + rng.normal(0, 0.005, n) * close
    return make_panel(close, highs=high, lows=np.minimum(low, close), opens=open_)


# ---------------------------------------------------------------- properties

@pytest.mark.parametrize("seed", range(8))
def test_rsi_bounds(seed):
    p = random_panel(seed=seed)
    rsi = compute_rsi(p["close"], 14).dropna()
    assert ((rsi >= 0) & (rsi <= 100)).all(), "RSI escaped [0,100]"


@pytest.mark.parametrize("seed", range(8))
def test_atr_non_negative(seed):
    p = random_panel(seed=seed)
    atr = wilder_atr(p["high"], p["low"], p["close"], 10).dropna()
    assert (atr >= 0).all()


@pytest.mark.parametrize("seed", range(8))
def test_stop_on_correct_side_of_price(seed):
    p = random_panel(seed=seed)
    out = compute_vstop(p, 10, 2.0).dropna(subset=["vstop_line"])
    up = out[out["uptrend"]]
    dn = out[~out["uptrend"]]
    assert (up["vstop_line"] <= up["close"] + 1e-9).all(), "stop above price during an uptrend"
    assert (dn["vstop_line"] >= dn["close"] - 1e-9).all(), "stop below price during a downtrend"


@pytest.mark.parametrize("seed", range(8))
def test_stop_ratchets_monotonically_within_a_trend_leg(seed):
    """
    The defining VStop property: inside one trend leg the stop only ever moves
    in the favourable direction. Catches most implementation errors.
    """
    p = random_panel(seed=seed)
    out = compute_vstop(p, 10, 2.0)
    prev_stop, prev_up = None, None
    for _, r in out.iterrows():
        if pd.isna(r["vstop_line"]):
            continue
        if prev_stop is not None and r["uptrend"] == prev_up:  # same leg
            if r["uptrend"]:
                assert r["vstop_line"] >= prev_stop - 1e-9, "uptrend stop moved DOWN inside a leg"
            else:
                assert r["vstop_line"] <= prev_stop + 1e-9, "downtrend stop moved UP inside a leg"
        prev_stop, prev_up = r["vstop_line"], r["uptrend"]


@pytest.mark.parametrize("seed", range(6))
def test_flip_up_definition(seed):
    """flip_up[t] iff uptrend[t] and not uptrend[t-1] (outside the warmup blank)."""
    p = random_panel(seed=seed)
    out = compute_vstop(p, 10, 2.0)
    expected = out["uptrend"] & ~out["uptrend"].shift(1).fillna(False).astype(bool)
    expected.iloc[:10] = False
    pd.testing.assert_series_equal(out["flip_up"].astype(bool), expected.astype(bool),
                                   check_names=False)


@pytest.mark.parametrize("seed", range(6))
def test_streaming_equals_batch(seed):
    """
    Recurrence integrity: computing bar-by-bar must equal computing over the whole
    frame. A vectorised indicator that peeks at the full history fails here.
    """
    p = random_panel(n=80, seed=seed)
    batch = compute_vstop(p, 10, 2.0)
    for k in (40, 60, 80):
        prefix = compute_vstop(p.iloc[:k].copy(), 10, 2.0)
        b = batch.iloc[:k]
        np.testing.assert_allclose(
            prefix["vstop_line"].to_numpy(dtype=float),
            b["vstop_line"].to_numpy(dtype=float),
            rtol=1e-12, equal_nan=True,
            err_msg=f"vstop_line differs when history is truncated at {k}",
        )
        assert (prefix["uptrend"].to_numpy() == b["uptrend"].to_numpy()).all()
        assert (prefix["flip_up"].to_numpy() == b["flip_up"].to_numpy()).all()


@pytest.mark.parametrize("seed", range(4))
def test_rsi_streaming_equals_batch(seed):
    p = random_panel(n=80, seed=seed)
    batch = compute_rsi(p["close"], 14)
    for k in (40, 60, 80):
        prefix = compute_rsi(p["close"].iloc[:k], 14)
        np.testing.assert_allclose(prefix.to_numpy(dtype=float),
                                   batch.iloc[:k].to_numpy(dtype=float),
                                   rtol=1e-12, equal_nan=True)


# ---------------------------------------------------------------- edge cases

def test_rsi_flat_series_is_neutral_not_100():
    """
    A perfectly flat series has no gains AND no losses. RSI is conventionally
    undefined -> 50 (neutral), never 100. Returning 100 is wrong, and 100 is a
    value that a '>= 50' half-band would accept.
    """
    flat = np.full(40, 100.0)
    rsi = compute_rsi(pd.Series(flat), 14)
    val = rsi.iloc[-1]
    assert not pd.isna(val), "flat series produced NaN RSI"
    assert val == pytest.approx(50.0, abs=1e-9), (
        f"flat series RSI should be neutral 50, got {val}"
    )


def test_rsi_warmup_is_nan_not_zero():
    """A 0 during warmup would silently fail a '>=50' check; a NaN is honest."""
    p = random_panel(n=40, seed=1)
    rsi = compute_rsi(p["close"], 14)
    assert rsi.iloc[:13].isna().all(), "RSI produced values before warmup completed"


def test_vstop_warmup_produces_no_flips():
    p = random_panel(n=60, seed=2)
    out = compute_vstop(p, 10, 2.0)
    assert not out["flip_up"].iloc[:10].any()
    assert not out["flip_down"].iloc[:10].any()


def test_zero_range_series_does_not_crash():
    flat = np.full(40, 100.0)
    p = make_panel(flat, highs=flat, lows=flat, opens=flat)
    out = compute_vstop(p, 10, 2.0)
    assert len(out) == 40
    assert out["atr"].dropna().eq(0).all(), "zero-range series should have zero ATR"


def test_insufficient_history_is_refused_not_guessed():
    from src.screen.engine import compute_features_for_ticker
    rule_spec, *_ = env()
    short = random_panel(n=5, seed=3)
    assert compute_features_for_ticker(short, rule_spec) is None


def test_real_ticker_indicator_sanity():
    """On real cached data, indicator outputs must be finite and in-range."""
    rule_spec, adapter, uni, panels, shares = env()
    checked = 0
    for t, p in list(panels.items())[:40]:
        if len(p) < 60:
            continue
        out = compute_vstop(p, 10, 2.0)
        rsi = compute_rsi(p["close"], 14)
        tail = out.dropna(subset=["vstop_line"])
        assert np.isfinite(tail["vstop_line"].to_numpy()).all(), f"{t}: non-finite stop"
        r = rsi.dropna()
        assert ((r >= 0) & (r <= 100)).all(), f"{t}: RSI out of bounds"
        checked += 1
    assert checked > 10
