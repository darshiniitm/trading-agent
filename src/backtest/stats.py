"""
Step 5 extended (docs/literal-spec-plan.md, added 27 Sep 2026): statistics for the
1-/2-/3-week horizon grades (src/backtest/horizons.py). 2- and 3-week windows from
consecutive Fridays overlap (this week's 2-week window shares a week with next week's),
so their per-week values are not independent -- src/backtest/harness.py:bootstrap_ci's
plain i.i.d. resampling would understate the true uncertainty. `block_bootstrap_ci`
resamples contiguous 3-week BLOCKS of weeks instead of individual weeks, so within-block
dependence survives the resample; `nonoverlapping_sanity` is a second, independent check
over every 3rd Friday only (genuinely non-overlapping, at the cost of most of the data),
reusing the plain `bootstrap_ci` unchanged. Report both side by side, never merged into
one number.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.backtest.harness import bootstrap_ci

DEFAULT_BLOCK_WEEKS = 3


def block_bootstrap_ci(rows_df: pd.DataFrame, value_col: str, week_col: str = "signal_week_start",
                        block_weeks: int = DEFAULT_BLOCK_WEEKS, n_boot: int = 5000, alpha: float = 0.05,
                        seed: int = 42) -> tuple[float, float, float]:
    """Moving block bootstrap: one row per week (already aggregated -- e.g. that
    week's mean r_Nw across picks), sorted chronologically. Each resample concatenates
    ceil(n/block_weeks) contiguous blocks of `block_weeks` weeks drawn with
    replacement, truncated to n, so overlap between neighbouring weeks' horizon
    windows is preserved inside a block instead of averaged away. Same (mean, lo, hi)
    shape as bootstrap_ci -- a drop-in for wherever that's read today.

    Fewer weeks than one block falls back to the plain i.i.d. bootstrap_ci (nothing to
    block yet), never crashes or fabricates a CI.
    """
    df = rows_df.dropna(subset=[value_col]).sort_values(week_col)
    values = df[value_col].to_numpy(dtype=float)
    n = len(values)
    if n == 0:
        return (np.nan, np.nan, np.nan)
    if n < block_weeks:
        return bootstrap_ci(values, n_boot=n_boot, alpha=alpha, seed=seed)

    rng = np.random.default_rng(seed)
    n_blocks_needed = int(np.ceil(n / block_weeks))
    max_start = n - block_weeks  # inclusive -- last index a full block can start at
    means = np.empty(n_boot)
    for b in range(n_boot):
        starts = rng.integers(0, max_start + 1, size=n_blocks_needed)
        resampled = np.concatenate([values[s:s + block_weeks] for s in starts])[:n]
        means[b] = resampled.mean()
    lo, hi = np.percentile(means, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return (float(values.mean()), float(lo), float(hi))


def nonoverlapping_sanity(rows_df: pd.DataFrame, value_col: str, week_col: str = "signal_week_start",
                           stride_weeks: int = DEFAULT_BLOCK_WEEKS, n_boot: int = 5000, alpha: float = 0.05,
                           seed: int = 42) -> dict:
    """Every `stride_weeks`-th week only (genuinely independent, non-overlapping
    horizon windows), plain i.i.d. bootstrap_ci over just those. Costs most of the
    data -- this is a sanity check on block_bootstrap_ci's answer, not a replacement
    for it (n_weeks_used is reported precisely so the tradeoff is visible)."""
    df = rows_df.dropna(subset=[value_col]).sort_values(week_col).reset_index(drop=True)
    sub = df.iloc[::stride_weeks]
    values = sub[value_col].to_numpy(dtype=float)
    mean, lo, hi = bootstrap_ci(values, n_boot=n_boot, alpha=alpha, seed=seed)
    return {"n_weeks_used": int(len(values)), "mean": mean, "ci_low": lo, "ci_high": hi}
