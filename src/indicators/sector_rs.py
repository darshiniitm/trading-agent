"""Sector relative strength + breadth (design doc §5)."""
from __future__ import annotations

import pandas as pd


def pct_return(close: pd.Series, lookback: int) -> float:
    if len(close) <= lookback:
        return float("nan")
    a, b = close.iloc[-lookback - 1], close.iloc[-1]
    if a == 0 or pd.isna(a) or pd.isna(b):
        return float("nan")
    return (b / a) - 1.0


def sector_index_series(sector_tickers: list[str], weekly_panels: dict[str, pd.DataFrame], as_of_idx: dict[str, int]) -> pd.Series:
    """Equal-weight sector proxy index: mean of normalized close prices across constituents."""
    normed = []
    for t in sector_tickers:
        panel = weekly_panels.get(t)
        if panel is None or panel.empty:
            continue
        idx = as_of_idx.get(t)
        sub = panel.iloc[: idx + 1] if idx is not None else panel
        if sub.empty or sub["close"].iloc[0] == 0:
            continue
        normed.append(sub["close"] / sub["close"].iloc[0])
    if not normed:
        return pd.Series(dtype=float)
    max_len = max(len(s) for s in normed)
    aligned = [s.reindex(range(max_len - len(s), max_len)).reset_index(drop=True) for s in normed]
    return pd.concat(aligned, axis=1).mean(axis=1)


def compute_sector_rs(
    sector_map: pd.DataFrame,
    weekly_panels: dict[str, pd.DataFrame],
    benchmark_close: pd.Series,
    lookbacks: list[int],
) -> pd.DataFrame:
    """Returns one row per sector: {sector, ret_<lb>, rs_<lb>, n_constituents}."""
    rows = []
    bench_rets = {lb: pct_return(benchmark_close, lb) for lb in lookbacks}
    for sector, group in sector_map.groupby("sector"):
        tickers = [t for t in group["ticker"] if t in weekly_panels]
        idx_map = {t: len(weekly_panels[t]) - 1 for t in tickers}
        proxy = sector_index_series(tickers, weekly_panels, idx_map)
        row = {"sector": sector, "n_constituents": len(tickers)}
        for lb in lookbacks:
            r = pct_return(proxy, lb) if not proxy.empty else float("nan")
            row[f"ret_{lb}w"] = r
            row[f"rs_{lb}w"] = (r - bench_rets[lb]) if pd.notna(r) and pd.notna(bench_rets[lb]) else float("nan")
        rows.append(row)
    return pd.DataFrame(rows)


def flag_outperforming(sector_rs_df: pd.DataFrame, primary_lookback_col: str, rs_gt: float, top_k: int) -> pd.DataFrame:
    df = sector_rs_df.copy()
    df = df.sort_values(primary_lookback_col, ascending=False)
    df["rs_rank"] = range(1, len(df) + 1)
    df["outperforming"] = (df[primary_lookback_col] > rs_gt) & (df["rs_rank"] <= top_k)
    return df
