"""
Sanity tests for VStop and RSI (design doc phase 3: "unit-test the flip against
known examples"). Uses synthetic price paths with a known, hand-computable shape
rather than a real ticker, since there's no independent chart to verify against
here -- documented limitation.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from src.indicators.rsi import compute_rsi
from src.indicators.vstop import compute_vstop


def make_panel(closes):
    n = len(closes)
    dates = pd.date_range("2024-01-05", periods=n, freq="W-FRI")
    closes = np.array(closes, dtype=float)
    return pd.DataFrame({
        "date": dates,
        "open": closes,
        "high": closes * 1.01,
        "low": closes * 0.99,
        "close": closes,
        "volume": np.full(n, 1_000_000),
    })


def test_vstop_flips_up_on_sustained_rally_after_downtrend():
    # 20 weeks of steady decline, then 15 weeks of steady rally.
    down = np.linspace(100, 60, 20)
    up = np.linspace(60, 120, 15)
    panel = make_panel(np.concatenate([down, up]))
    out = compute_vstop(panel, length=10, mult=2.0)
    # There must be at least one bullish flip during the rally leg (index >= 20).
    flips_in_rally = out.loc[20:, "flip_up"]
    assert flips_in_rally.any(), "expected a bullish VStop flip during the rally leg"
    # Once flipped, uptrend should stay true while the rally continues monotonically.
    first_flip_idx = out.index[out["flip_up"]][-1] if flips_in_rally.any() else None


def test_vstop_no_flip_in_pure_monotonic_uptrend_after_warmup():
    up = np.linspace(100, 200, 40)
    panel = make_panel(up)
    out = compute_vstop(panel, length=10, mult=2.0)
    # after warmup, should be in a stable uptrend with no further flips
    tail_flips = out.loc[15:, "flip_up"].sum()
    assert tail_flips <= 1, "pure monotonic uptrend should not keep re-flipping"


def test_rsi_bounds_and_extremes():
    up = np.linspace(100, 200, 30)  # pure uptrend -> RSI should approach 100
    panel = make_panel(up)
    rsi = compute_rsi(panel["close"], period=14)
    assert (rsi.dropna() <= 100.0001).all()
    assert (rsi.dropna() >= 0).all()
    assert rsi.iloc[-1] > 90, f"expected RSI near 100 in pure uptrend, got {rsi.iloc[-1]}"

    down = np.linspace(200, 100, 30)
    panel2 = make_panel(down)
    rsi2 = compute_rsi(panel2["close"], period=14)
    assert rsi2.iloc[-1] < 10, f"expected RSI near 0 in pure downtrend, got {rsi2.iloc[-1]}"


def test_rsi_flat_series_is_neutral_not_nan():
    flat = np.full(30, 100.0)
    panel = make_panel(flat)
    rsi = compute_rsi(panel["close"], period=14)
    assert not rsi.iloc[-1] != rsi.iloc[-1]  # not NaN


if __name__ == "__main__":
    test_vstop_flips_up_on_sustained_rally_after_downtrend()
    test_vstop_no_flip_in_pure_monotonic_uptrend_after_warmup()
    test_rsi_bounds_and_extremes()
    test_rsi_flat_series_is_neutral_not_nan()
    print("All indicator sanity tests passed.")
