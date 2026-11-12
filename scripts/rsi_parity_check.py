"""
RSI(14) TradingView parity check -- diagnose only, per Dharmin's 2026-09-29 decision.

Companion to scripts/vstop_parity_check.py, same discipline: this script does NOT
modify src/indicators/rsi.py or any other production code, and it does not conclude
a fix on its own.

Motivating gap: for URBANCO.NS, week of 2026-09-21, the underlying weekly OHLC bar
is already confirmed identical to TradingView's own candle (raw-data mismatch ruled
out) -- yet TradingView's RSI(14) reads 64.57 and ours reads 62.99. Unlike the VStop
parity gap (which turned out to be two comparison errors, not a bug), this smells
like a genuine methodology difference:

  src/indicators/rsi.py:compute_rsi() smooths average gain/loss with
  `gain.ewm(alpha=1/period, adjust=False, min_periods=period).mean()`, started from
  bar 1 of whatever series it's given -- no separate SMA-seed step. A textbook
  Wilder RSI instead seeds avg_gain[13]/avg_loss[13] with a plain average of the
  first 14 gains/losses, then recurses avg[i] = (avg[i-1]*(period-1) + x[i])/period
  from bar 14 onward. This script implements that variant HERE ONLY (not in src/)
  and re-runs it over the identical panel for direct comparison.

Also checks history-window-length sensitivity, same as the VStop script -- for
VStop, an analogous seeding difference had already fully decayed to 0.0000 after
201 weeks; RSI decays at a similar rate (alpha=1/14 vs VStop's alpha=1/10), so this
needs the same empirical check, not an assumption either way.

usage:
  python3 -m scripts.rsi_parity_check [TICKER]
  (defaults to URBANCO.NS against data_cache_literal/weekly_ohlcv_260w.parquet)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.indicators.rsi import compute_rsi  # noqa: E402

PERIOD = 14


def rsi_sma_seeded(close: pd.Series, period: int = PERIOD) -> pd.Series:
    """Textbook Wilder RSI: seed avg_gain/avg_loss at bar `period` with a simple
    average of the first `period` gains/losses, then recurse
    avg[i] = (avg[i-1]*(period-1) + x[i]) / period. Diagnostic-only variant of
    compute_rsi() in src/indicators/rsi.py -- not used anywhere in production."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    n = len(close)
    avg_gain = np.full(n, np.nan)
    avg_loss = np.full(n, np.nan)
    # delta[0] is NaN (no prior close), so the first `period` real changes are
    # indices 1..period -- seed lands at index `period`.
    if n <= period:
        return pd.Series(avg_gain, index=close.index)

    avg_gain[period] = gain.iloc[1:period + 1].mean()
    avg_loss[period] = loss.iloc[1:period + 1].mean()
    for i in range(period + 1, n):
        avg_gain[i] = (avg_gain[i - 1] * (period - 1) + gain.iloc[i]) / period
        avg_loss[i] = (avg_loss[i - 1] * (period - 1) + loss.iloc[i]) / period

    avg_gain_s = pd.Series(avg_gain, index=close.index)
    avg_loss_s = pd.Series(avg_loss, index=close.index)
    rs = avg_gain_s / avg_loss_s.replace(0, float("nan"))
    rsi = 100 - (100 / (1 + rs))
    rsi = rsi.where(avg_loss_s != 0, 100.0)
    flat = (avg_gain_s == 0) & (avg_loss_s == 0)
    rsi = rsi.mask(flat, 50.0)
    return rsi


def main(ticker: str = "URBANCO.NS", cache_dir: str = "data_cache_literal"):
    root = Path(__file__).resolve().parents[1]
    weekly = pd.read_parquet(root / cache_dir / "weekly_ohlcv_260w.parquet")
    panel_full = weekly[weekly["ticker"] == ticker].sort_values("date").reset_index(drop=True)
    if panel_full.empty:
        print(f"no cached weekly bars for {ticker} in {cache_dir}")
        return

    print(f"=== RSI({PERIOD}) parity check: {ticker} ===")
    print(f"cached weekly bars: {len(panel_full)} (from {panel_full['date'].min().date()} to {panel_full['date'].max().date()})\n")

    print("-- 1. baseline: current compute_rsi() (src/indicators/rsi.py, unmodified) --")
    base = compute_rsi(panel_full["close"], period=PERIOD)
    tail = panel_full[["date", "close"]].tail(8).copy()
    tail["rsi_baseline"] = base.tail(8).values
    print(tail.to_string(index=False))
    b_val = float(base.iloc[-1])
    b_date = panel_full["date"].iloc[-1]
    print(f"  current bar ({pd.Timestamp(b_date).date()}): rsi={b_val:.4f}\n")

    print("-- 2. seeding hypothesis: SMA-seeded Wilder RSI instead of ewm-from-bar-1 --")
    seeded = rsi_sma_seeded(panel_full["close"], period=PERIOD)
    s_val = float(seeded.iloc[-1])
    print(f"  current bar ({pd.Timestamp(b_date).date()}): rsi={s_val:.4f}")
    print(f"  delta vs baseline: {s_val - b_val:+.4f}\n")

    print("-- 3. history-window-length sensitivity (same seeding as baseline, different start) --")
    for weeks in (260, 130, 104):
        sliced = panel_full.tail(weeks).reset_index(drop=True)
        if len(sliced) < PERIOD + 1:
            continue
        r = compute_rsi(sliced["close"], period=PERIOD)
        w_val = float(r.iloc[-1])
        print(f"  last {weeks:>3}w window: rsi={w_val:.4f}  delta vs 260w baseline: {w_val - b_val:+.4f}")
    print()

    print("-- summary (no conclusion / no fix -- diagnose only) --")
    print(f"  baseline (current code):   {b_val:.4f}")
    print(f"  SMA-seeded RSI variant:    {s_val:.4f}  (delta {s_val - b_val:+.4f})")
    print("  See the per-window deltas above for history-length sensitivity.")
    print("  Compare all of the above to your TradingView reading by hand.")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tk = args[0] if args else "URBANCO.NS"
    main(tk)
