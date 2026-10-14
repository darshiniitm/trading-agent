"""
Step 5 extended (27 Sep 2026): block_bootstrap_ci / nonoverlapping_sanity
(src/backtest/stats.py) -- reported side by side over the horizon grades'
per-week aggregates, never merged into one number.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.backtest.stats import block_bootstrap_ci, nonoverlapping_sanity


def _weekly_df(values):
    weeks = pd.date_range("2024-01-01", periods=len(values), freq="W-MON")
    return pd.DataFrame({"signal_week_start": weeks.strftime("%Y-%m-%d"), "v": values})


def test_block_bootstrap_ci_on_constant_series_collapses_to_that_constant():
    df = _weekly_df([2.0] * 20)
    mean, lo, hi = block_bootstrap_ci(df, "v", block_weeks=3, n_boot=200, seed=1)
    assert mean == pytest.approx(2.0)
    assert lo == pytest.approx(2.0)
    assert hi == pytest.approx(2.0)


def test_block_bootstrap_ci_mean_matches_plain_mean():
    rng = np.random.default_rng(0)
    vals = rng.normal(1.0, 0.5, size=60)
    df = _weekly_df(vals)
    mean, lo, hi = block_bootstrap_ci(df, "v", block_weeks=3, n_boot=2000, seed=7)
    assert mean == pytest.approx(float(vals.mean()), abs=1e-9)
    assert lo <= mean <= hi


def test_block_bootstrap_ci_falls_back_below_one_block():
    df = _weekly_df([1.0, 3.0])  # fewer weeks than block_weeks=3
    mean, lo, hi = block_bootstrap_ci(df, "v", block_weeks=3, n_boot=500, seed=1)
    assert mean == pytest.approx(2.0)
    assert not np.isnan(lo) and not np.isnan(hi)


def test_block_bootstrap_ci_empty_returns_nan():
    df = _weekly_df([])
    mean, lo, hi = block_bootstrap_ci(df, "v")
    assert np.isnan(mean) and np.isnan(lo) and np.isnan(hi)


def test_block_bootstrap_ci_drops_nan_rows():
    df = _weekly_df([1.0, np.nan, 3.0, np.nan, 5.0])
    mean, lo, hi = block_bootstrap_ci(df, "v", block_weeks=2, n_boot=200, seed=1)
    assert mean == pytest.approx(3.0)  # mean of [1, 3, 5], NaNs excluded


def test_nonoverlapping_sanity_uses_every_stride_th_week_only():
    df = _weekly_df(list(range(9)))  # 0..8, 9 weeks
    result = nonoverlapping_sanity(df, "v", stride_weeks=3, n_boot=200, seed=1)
    # rows at positions 0, 3, 6 -> values 0, 3, 6
    assert result["n_weeks_used"] == 3
    assert result["mean"] == pytest.approx(3.0)
