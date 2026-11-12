"""
Statistics for the week-over-week study (docs/wow-arm-history-analysis-plan.md §4.2, §5.3).

Weekly baskets share market factors, so every interval here is a week-level block
bootstrap (moving block, default length 4, 10,000 replicates, seeded) — never
member-level resampling (§5.3). Trend tests report both OLS+Newey-West and the
non-parametric Mann-Kendall check side by side; disagreement is reported, not resolved
(§4.2.3).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

DEFAULT_BLOCK_LEN = 4
DEFAULT_N_BOOT = 10_000
DEFAULT_SEED = 42

MIN_TREND_WEEKS = 26
MIN_PAIRED_WEEKS = 13

SUPPRESSED = "insufficient history"


def suppress(n: int, floor: int) -> str:
    return f"{SUPPRESSED} (n={n}, floor={floor})"


def _block_bootstrap_replicate_means(values: np.ndarray, block_len: int, n_boot: int, seed: int) -> np.ndarray:
    """Moving-block bootstrap: n_boot replicate means, each built from blocks of
    `block_len` consecutive weeks drawn with replacement and concatenated to series
    length — preserves short-range autocorrelation the plain iid bootstrap would erase."""
    values = np.asarray(values, dtype=float)
    values = values[~np.isnan(values)]
    n = len(values)
    if n == 0:
        return np.array([])
    rng = np.random.default_rng(seed)
    if n < block_len:
        # Too few observations for a block of this length — fall back to iid resampling.
        return np.array([rng.choice(values, size=n, replace=True).mean() for _ in range(n_boot)])
    n_blocks_needed = int(np.ceil(n / block_len))
    starts = np.arange(0, n - block_len + 1)
    means = np.empty(n_boot)
    for b in range(n_boot):
        chosen = rng.choice(starts, size=n_blocks_needed, replace=True)
        resample = np.concatenate([values[s:s + block_len] for s in chosen])[:n]
        means[b] = resample.mean()
    return means


def moving_block_bootstrap_mean_ci(values: np.ndarray, block_len: int = DEFAULT_BLOCK_LEN,
                                    n_boot: int = DEFAULT_N_BOOT, alpha: float = 0.05,
                                    seed: int = DEFAULT_SEED) -> tuple[float, float, float]:
    """Moving-block bootstrap CI on the mean of a weekly series."""
    values = np.asarray(values, dtype=float)
    clean = values[~np.isnan(values)]
    if len(clean) == 0:
        return (np.nan, np.nan, np.nan)
    means = _block_bootstrap_replicate_means(clean, block_len, n_boot, seed)
    lo, hi = np.percentile(means, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return (float(clean.mean()), float(lo), float(hi))


def moving_block_bootstrap_diff_ci(a: np.ndarray, b: np.ndarray, block_len: int = DEFAULT_BLOCK_LEN,
                                    n_boot: int = DEFAULT_N_BOOT, alpha: float = 0.05,
                                    seed: int = DEFAULT_SEED) -> tuple[float, float, float]:
    """CI on mean(a) - mean(b) for two PAIRED weekly series (same week index), via a
    block bootstrap on the paired difference series (equivalent to bootstrapping both
    arms with the same block draws, which preserves the pairing)."""
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    diff = a - b
    return moving_block_bootstrap_mean_ci(diff, block_len, n_boot, alpha, seed)


def ols_newey_west_trend(values: np.ndarray, lag: int = 4) -> dict:
    """OLS slope of the weekly series on week index (0..n-1), Newey-West (HAC) SE."""
    import statsmodels.api as sm

    values = np.asarray(values, dtype=float)
    mask = ~np.isnan(values)
    y = values[mask]
    x = np.arange(len(values))[mask]
    n = len(y)
    if n < 3:
        return {"n": n, "slope": None, "se": None, "t": None, "p": None}
    X = sm.add_constant(x)
    model = sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": lag})
    return {
        "n": n,
        "slope": float(model.params[1]),
        "se": float(model.bse[1]),
        "t": float(model.tvalues[1]),
        "p": float(model.pvalues[1]),
    }


def mann_kendall(values: np.ndarray) -> dict:
    """Non-parametric trend test — sign of pairwise differences, normal approximation
    for the p-value (ties handled via the standard variance correction)."""
    values = np.asarray(values, dtype=float)
    x = values[~np.isnan(values)]
    n = len(x)
    if n < 3:
        return {"n": n, "tau": None, "s": None, "z": None, "p": None}

    s = 0
    for i in range(n - 1):
        s += np.sum(np.sign(x[i + 1:] - x[i]))

    _, counts = np.unique(x, return_counts=True)
    tie_term = np.sum(counts * (counts - 1) * (2 * counts + 5))
    var_s = (n * (n - 1) * (2 * n + 5) - tie_term) / 18.0

    if s > 0:
        z = (s - 1) / np.sqrt(var_s) if var_s > 0 else 0.0
    elif s < 0:
        z = (s + 1) / np.sqrt(var_s) if var_s > 0 else 0.0
    else:
        z = 0.0
    from scipy.stats import norm
    p = 2 * (1 - norm.cdf(abs(z)))
    tau = s / (0.5 * n * (n - 1))
    return {"n": n, "tau": float(tau), "s": int(s), "z": float(z), "p": float(p)}


def half_split_bootstrap(values: np.ndarray, block_len: int = DEFAULT_BLOCK_LEN,
                          n_boot: int = DEFAULT_N_BOOT, alpha: float = 0.05,
                          seed: int = DEFAULT_SEED) -> dict:
    """First-half vs second-half mean, with a block-bootstrap CI on the difference
    (second half minus first half — positive means improving). The two halves are
    independent samples (different weeks), so each is block-bootstrapped on its own
    and the replicate means are differenced — not a paired bootstrap."""
    values = np.asarray(values, dtype=float)
    n = len(values)
    mid = n // 2
    first, second = values[:mid], values[mid:]
    first_clean, second_clean = first[~np.isnan(first)], second[~np.isnan(second)]
    f_mean = float(first_clean.mean()) if len(first_clean) else None
    s_mean = float(second_clean.mean()) if len(second_clean) else None

    if len(first_clean) == 0 or len(second_clean) == 0:
        diff_mean = lo = hi = None
    else:
        first_means = _block_bootstrap_replicate_means(first_clean, block_len, n_boot, seed)
        second_means = _block_bootstrap_replicate_means(second_clean, block_len, n_boot, seed + 1)
        diffs = second_means - first_means
        diff_mean = float(diffs.mean())
        lo, hi = (float(v) for v in np.percentile(diffs, [100 * alpha / 2, 100 * (1 - alpha / 2)]))

    return {"n_first": len(first), "n_second": len(second), "first_half_mean": f_mean,
            "second_half_mean": s_mean, "diff_mean": diff_mean, "diff_ci_lo": lo, "diff_ci_hi": hi}


def equity_curve(weekly_net_pct: pd.Series) -> pd.Series:
    """Compound weekly basket returns; a null (cash) week compounds at 1.0 (§4.2.1)."""
    factors = weekly_net_pct.fillna(0.0) / 100.0 + 1.0
    return factors.cumprod()


def max_drawdown(curve: pd.Series) -> float:
    if curve.empty:
        return np.nan
    running_max = curve.cummax()
    dd = curve / running_max - 1.0
    return float(dd.min())


def rolling_mean(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window, min_periods=window).mean()
