"""
Validation harness — single-week check + rolling walk-forward (design doc §8).

Both loops call the exact same `run_screen` used for the live screen; only
`as_of` moves back in time. No separate backtest logic exists (design doc's
load-bearing "one shared code path" choice).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from src.indicators.vstop import compute_vstop
from src.screen.engine import run_screen
from src.trade.builder import build_trades

COST_FRACTION_DEFAULT = 0.005  # 0.5% round trip, design doc §8.4
DEFAULT_MAX_HOLD_WEEKS = 26  # trend-hold safety cap (design doc §8.5 "B")


def _next_week_row(panel: pd.DataFrame, as_of: pd.Timestamp) -> pd.Series | None:
    future = panel[panel["date"] > as_of].sort_values("date")
    return future.iloc[0] if not future.empty else None


def simulate_week_forward(trades_df: pd.DataFrame, weekly_panels: dict[str, pd.DataFrame],
                           as_of: pd.Timestamp, cost_pct: float) -> pd.DataFrame:
    """For each trade, simulate the following week: SL hit (intraweek low) or close-out at week close."""
    if trades_df.empty:
        return trades_df.assign(exit_price=[], exit_reason=[], ret_pct=[], ret_pct_net=[], r_multiple=[])

    rows = []
    for _, t in trades_df.iterrows():
        panel = weekly_panels.get(t["ticker"])
        if panel is None:
            continue
        nxt = _next_week_row(panel, as_of)
        if nxt is None:
            continue  # no forward data yet (e.g. this week's live screen) -> can't grade

        EP = float(nxt["open"])  # actual fill at next week's open
        SL = t["SL"]
        stopped = nxt["low"] <= SL
        exit_price = SL if stopped else float(nxt["close"])
        exit_reason = "stop_hit" if stopped else "week_close"

        ret_pct = (exit_price - EP) / EP
        ret_pct_net = ret_pct - cost_pct
        r_multiple = (exit_price - EP) / (EP - SL) if (EP - SL) > 0 else np.nan

        rows.append({**t.to_dict(), "EP": EP, "exit_price": exit_price, "exit_reason": exit_reason,
                     "ret_pct": ret_pct, "ret_pct_net": ret_pct_net, "r_multiple": r_multiple,
                     "week_start": as_of, "week_end": nxt["date"]})

    return pd.DataFrame(rows)


def simulate_trend_hold(trades_df: pd.DataFrame, weekly_panels: dict[str, pd.DataFrame], rule_spec: dict,
                         as_of: pd.Timestamp, cost_pct: float, max_hold_weeks: int = DEFAULT_MAX_HOLD_WEEKS) -> pd.DataFrame:
    """
    Secondary exit horizon (design doc §8.5, "B"): hold the position, trailing the
    VStop line, until either an intraweek low pierces the current trailing stop
    (stop_hit, filled at that week's stop level) or the indicator flips down on a
    weekly close (trend_flip_down, filled at that week's close). Capped at
    `max_hold_weeks` (horizon_cap) so aggregation stays finite.

    Recomputing VStop over the FULL historical panel (not re-sliced per week) is
    safe here: the recurrence only ever depends on bars at or before each index,
    so the value at week w is identical whether you slice-then-compute up to w or
    compute once over the whole panel and read off index w. This is a backtest
    grading step over already-realized future prices, not a live decision — no
    look-ahead is introduced.
    """
    if trades_df.empty:
        return trades_df.assign(exit_price=[], exit_reason=[], hold_weeks=[], ret_pct=[],
                                 ret_pct_net=[], r_multiple=[], mae_pct=[])

    vstop_params = next(s["params"] for s in rule_spec["signals"] if s["id"] == "vstop_flip")
    rows = []
    for _, t in trades_df.iterrows():
        panel = weekly_panels.get(t["ticker"])
        if panel is None:
            continue
        vdf = compute_vstop(panel, length=vstop_params["length"], mult=vstop_params["mult"],
                             source=vstop_params["source"]).reset_index(drop=True)
        as_of_matches = vdf.index[vdf["date"] == as_of]
        if len(as_of_matches) == 0:
            continue
        entry_idx = as_of_matches[0] + 1
        if entry_idx >= len(vdf):
            continue  # no forward data yet -> can't grade

        EP = float(vdf.loc[entry_idx, "open"])
        exit_idx, exit_reason, exit_price = None, None, None
        last_possible = min(entry_idx + max_hold_weeks - 1, len(vdf) - 1)

        for i in range(entry_idx, last_possible + 1):
            row = vdf.loc[i]
            trailing_stop = row["vstop_line"]
            if pd.notna(trailing_stop) and row["low"] <= trailing_stop:
                exit_idx, exit_reason, exit_price = i, "stop_hit", float(trailing_stop)
                break
            if bool(row["flip_down"]):
                exit_idx, exit_reason, exit_price = i, "trend_flip_down", float(row["close"])
                break

        if exit_idx is None:
            exit_idx, exit_reason, exit_price = last_possible, "horizon_cap", float(vdf.loc[last_possible, "close"])

        initial_SL = t["SL"]
        hold_weeks = exit_idx - entry_idx + 1
        ret_pct = (exit_price - EP) / EP
        ret_pct_net = ret_pct - cost_pct
        r_multiple = (exit_price - EP) / (EP - initial_SL) if (EP - initial_SL) > 0 else np.nan
        path = vdf.loc[entry_idx:exit_idx]
        mae_pct = (path["low"].min() - EP) / EP  # max adverse excursion vs EP over the hold

        rows.append({**t.to_dict(), "EP": EP, "exit_price": exit_price, "exit_reason": exit_reason,
                     "hold_weeks": hold_weeks, "ret_pct": ret_pct, "ret_pct_net": ret_pct_net,
                     "r_multiple": r_multiple, "mae_pct": mae_pct,
                     "week_start": as_of, "week_end": vdf.loc[exit_idx, "date"]})

    return pd.DataFrame(rows)


def rolling_walk_forward_trend_hold(as_of_dates: list[pd.Timestamp], rule_spec: dict, adapter, universe_df: pd.DataFrame,
                                     weekly_panels: dict, shares_map: dict, max_hold_weeks: int = DEFAULT_MAX_HOLD_WEEKS,
                                     progress_every: int = 10) -> pd.DataFrame:
    """Same fold loop as rolling_walk_forward, graded with the trend-hold exit instead of fixed-1-week."""
    cost_pct = rule_spec["validation"]["costs_pct_round_trip"] / 100
    all_graded = []
    for i, as_of in enumerate(as_of_dates):
        screen_result = run_screen(as_of, rule_spec, adapter, universe_df, weekly_panels, shares_map)
        trades = build_trades(screen_result["survivors"], rule_spec)
        graded = simulate_trend_hold(trades, weekly_panels, rule_spec, as_of, cost_pct, max_hold_weeks)
        if not graded.empty:
            all_graded.append(graded)
        if progress_every and (i + 1) % progress_every == 0:
            print(f"  trend-hold fold {i + 1}/{len(as_of_dates)} ({as_of.date()}): {len(graded)} graded trades")
    if not all_graded:
        return pd.DataFrame()
    return pd.concat(all_graded, ignore_index=True)


def single_week_check(as_of: pd.Timestamp, rule_spec: dict, adapter, universe_df: pd.DataFrame,
                       weekly_panels: dict, shares_map: dict) -> dict:
    screen_result = run_screen(as_of, rule_spec, adapter, universe_df, weekly_panels, shares_map)
    trades = build_trades(screen_result["survivors"], rule_spec)
    cost_pct = rule_spec["validation"]["costs_pct_round_trip"] / 100
    graded = simulate_week_forward(trades, weekly_panels, as_of, cost_pct)
    return {"as_of": as_of, "screen": screen_result, "trades": trades, "graded": graded}


def rolling_walk_forward(as_of_dates: list[pd.Timestamp], rule_spec: dict, adapter, universe_df: pd.DataFrame,
                          weekly_panels: dict, shares_map: dict, progress_every: int = 10) -> pd.DataFrame:
    cost_pct = rule_spec["validation"]["costs_pct_round_trip"] / 100
    all_graded = []
    for i, as_of in enumerate(as_of_dates):
        screen_result = run_screen(as_of, rule_spec, adapter, universe_df, weekly_panels, shares_map)
        trades = build_trades(screen_result["survivors"], rule_spec)
        graded = simulate_week_forward(trades, weekly_panels, as_of, cost_pct)
        if not graded.empty:
            all_graded.append(graded)
        if progress_every and (i + 1) % progress_every == 0:
            print(f"  walk-forward fold {i + 1}/{len(as_of_dates)} ({as_of.date()}): "
                  f"{len(graded)} graded trades")
    if not all_graded:
        return pd.DataFrame()
    return pd.concat(all_graded, ignore_index=True)


def bootstrap_ci(values: np.ndarray, n_boot: int = 5000, alpha: float = 0.05, seed: int = 42) -> tuple[float, float, float]:
    if len(values) == 0:
        return (np.nan, np.nan, np.nan)
    rng = np.random.default_rng(seed)
    means = np.array([rng.choice(values, size=len(values), replace=True).mean() for _ in range(n_boot)])
    lo, hi = np.percentile(means, [100 * alpha / 2, 100 * (1 - alpha / 2)])
    return (float(values.mean()), float(lo), float(hi))


def summarize_trades(graded: pd.DataFrame) -> dict:
    if graded.empty:
        return {"n_trades": 0}
    rets = graded["ret_pct_net"].to_numpy()
    wins = graded[graded["ret_pct_net"] > 0]
    losses = graded[graded["ret_pct_net"] <= 0]
    hit_rate = len(wins) / len(graded)
    avg_win = wins["ret_pct_net"].mean() if not wins.empty else 0.0
    avg_loss = -losses["ret_pct_net"].mean() if not losses.empty else 0.0
    expectancy = hit_rate * avg_win - (1 - hit_rate) * avg_loss
    mean_ret, ci_lo, ci_hi = bootstrap_ci(rets)
    return {
        "n_trades": len(graded),
        "n_weeks": graded["week_start"].nunique(),
        "hit_rate": hit_rate,
        "avg_win_pct": avg_win,
        "avg_loss_pct": avg_loss,
        "expectancy_pct": expectancy,
        "mean_ret_pct": mean_ret,
        "mean_ret_ci95_lo": ci_lo,
        "mean_ret_ci95_hi": ci_hi,
        "avg_r_multiple": graded["r_multiple"].mean(),
        "median_r_multiple": graded["r_multiple"].median(),
    }


def weekly_portfolio_returns(graded: pd.DataFrame) -> pd.DataFrame:
    """Equal-weight all of a week's picks into one portfolio return per week (design doc §8.2)."""
    if graded.empty:
        return pd.DataFrame(columns=["week_start", "portfolio_ret_net"])
    g = graded.groupby("week_start")["ret_pct_net"].mean().reset_index()
    g = g.rename(columns={"ret_pct_net": "portfolio_ret_net"})
    return g.sort_values("week_start")


def portfolio_metrics(weekly_rets: pd.DataFrame, benchmark_weekly_rets: pd.Series | None = None) -> dict:
    if weekly_rets.empty:
        return {}
    r = weekly_rets["portfolio_ret_net"]
    n_weeks = len(r)
    cagr = (1 + r).prod() ** (52 / n_weeks) - 1 if n_weeks > 0 else np.nan
    vol_annual = r.std() * np.sqrt(52)
    sharpe = (r.mean() * 52) / vol_annual if vol_annual and vol_annual > 0 else np.nan
    cum = (1 + r).cumprod()
    drawdown = (cum / cum.cummax() - 1).min()
    out = {
        "n_weeks": n_weeks, "cagr": cagr, "vol_annual": vol_annual,
        "sharpe": sharpe, "max_drawdown": drawdown,
    }
    if benchmark_weekly_rets is not None and not benchmark_weekly_rets.empty:
        aligned = weekly_rets.merge(
            benchmark_weekly_rets.rename("bench_ret").reset_index(), on="week_start", how="inner"
        )
        if not aligned.empty:
            out["pct_weeks_beat_benchmark"] = (aligned["portfolio_ret_net"] > aligned["bench_ret"]).mean()
    return out


def trend_hold_return_stats(graded: pd.DataFrame) -> dict:
    """
    Per-trade annualized return for variable-length trend-hold trades.

    NOT a portfolio Sharpe/CAGR: trend-hold trades overlap in time and have
    different holding periods, so there is no single non-overlapping weekly
    return series the way there is for the fixed-1-week exit. Treating each
    trade's multi-week return as if it were one week's return (what naively
    reusing weekly_portfolio_returns/portfolio_metrics would do) massively
    overstates annualized figures. This instead annualizes EACH trade by ITS
    OWN holding period, then reports the distribution -- a "return on capital
    while deployed in that trade" statistic, not a backtested equity curve.
    A true concurrent-capital portfolio simulation (marking overlapping
    positions to market weekly) is out of scope for this POC.
    """
    if graded.empty or "hold_weeks" not in graded.columns:
        return {}
    hw = graded["hold_weeks"].clip(lower=1)
    ann_ret = (1 + graded["ret_pct_net"]) ** (52 / hw) - 1
    return {
        "n_trades": len(graded),
        "mean_annualized_ret_per_trade": ann_ret.mean(),
        "median_annualized_ret_per_trade": ann_ret.median(),
        "std_annualized_ret_per_trade": ann_ret.std(),
        "pct_trades_positive": (graded["ret_pct_net"] > 0).mean(),
    }


def confidence_calibration(graded: pd.DataFrame, n_buckets: int = 5) -> pd.DataFrame:
    if graded.empty or "confidence" not in graded.columns:
        return pd.DataFrame()
    g = graded.copy()
    g["bucket"] = pd.qcut(g["confidence"], q=min(n_buckets, g["confidence"].nunique()), duplicates="drop")
    return g.groupby("bucket", observed=True).agg(
        n=("ret_pct_net", "size"),
        hit_rate=("ret_pct_net", lambda x: (x > 0).mean()),
        mean_ret_net=("ret_pct_net", "mean"),
        avg_confidence=("confidence", "mean"),
    ).reset_index()


def confidence_rank_ic(graded: pd.DataFrame) -> dict:
    """Spearman rank-IC of confidence vs realized net return (B6's planned validation
    of the confidence score as an ordering signal). Needs >=3 rows and non-constant
    confidence to be defined."""
    from scipy.stats import spearmanr

    if graded.empty or "confidence" not in graded.columns or len(graded) < 3:
        return {"n": len(graded), "rank_ic": None, "p_value": None}
    if graded["confidence"].nunique() < 2:
        return {"n": len(graded), "rank_ic": None, "p_value": None}
    rho, p = spearmanr(graded["confidence"], graded["ret_pct_net"])
    return {"n": len(graded), "rank_ic": float(rho), "p_value": float(p)}
