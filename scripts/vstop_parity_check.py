"""
VStop(10,2) TradingView parity check -- docs/literal-spec-plan.md's "decision 6"
(VStop parity chart-check), owed since 27 Sep 2026 and never done until now.

Diagnose-only, per Dharmin's 2026-09-28 decision: this script does NOT modify
src/indicators/vstop.py or any other production code, and it does not conclude
a fix. It isolates two non-exclusive hypotheses for why our computed VStop can
diverge from a TradingView reading (observed on KAYNES.NS: our 3383.48 vs
TradingView's 3311.7, ~2.5% gap):

  1. ATR seeding: wilder_atr() in src/indicators/vstop.py smooths True Range
     with `tr.ewm(alpha=1/length, adjust=False, min_periods=length).mean()`,
     started from bar 1 of whatever panel it's given -- no separate SMA-seed
     step. A textbook Wilder ATR instead seeds the first value as a simple
     average of the first `length` TRs, then recurses. This script implements
     that SMA-seeded variant here ONLY (not in src/) and re-runs the identical
     VStop recursion (copied from compute_vstop(), not imported with a shim,
     so the two runs are directly comparable) over the same panel.
  2. History-window length: compute_vstop() is a path-dependent recursion --
     trend flips anchor max_/min_ for everything after -- so a different
     starting bar can cascade into a different current stop line even with
     identical OHLC data downstream. This script re-runs the baseline over a
     few different history depths (full cache, last 130w, last 104w) to see
     how sensitive the current reading is to where the recursion starts.

A third check (raw OHLC spot-check) just prints our cached bars for the most
recent weeks so they can be eyeballed against a chart.

usage:
  python3 -m scripts.vstop_parity_check [TICKER] [--cache data_cache_literal]
  (defaults to KAYNES.NS against data_cache_literal/weekly_ohlcv_260w.parquet)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.indicators.vstop import compute_vstop  # noqa: E402

LENGTH, MULT, SOURCE = 10, 2.0, "close"


def wilder_atr_sma_seeded(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    """Textbook Wilder ATR: seed with a simple average of the first `length`
    true ranges, then recurse atr[i] = (atr[i-1]*(length-1) + tr[i]) / length.
    Diagnostic-only variant of wilder_atr() in src/indicators/vstop.py -- not
    used anywhere in production."""
    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)

    n = len(tr)
    atr = np.full(n, np.nan)
    if n < length:
        return pd.Series(atr, index=tr.index)
    atr[length - 1] = tr.iloc[:length].mean()
    for i in range(length, n):
        atr[i] = (atr[i - 1] * (length - 1) + tr.iloc[i]) / length
    return pd.Series(atr, index=tr.index)


def compute_vstop_with_atr(df: pd.DataFrame, atr: pd.Series, length: int, mult: float, source: str) -> pd.DataFrame:
    """Same recursion as compute_vstop() in src/indicators/vstop.py, copied
    here so an externally-supplied ATR series can be swapped in for the
    seeding-hypothesis check -- not a production fork, diagnostic only."""
    df = df.reset_index(drop=True).copy()
    src = df[source]

    n = len(df)
    stop = np.full(n, np.nan)
    uptrend = np.full(n, False)
    max_ = np.nan
    min_ = np.nan
    prev_stop = np.nan
    prev_uptrend = True

    for i in range(n):
        band = mult * atr.iloc[i]
        s = src.iloc[i]
        if np.isnan(band):
            stop[i] = np.nan
            uptrend[i] = prev_uptrend
            continue

        if np.isnan(max_):
            max_, min_ = s, s
            prev_stop = s - band if prev_uptrend else s + band

        max_ = max(max_, s)
        min_ = min(min_, s)

        candidate = max(prev_stop, max_ - band) if prev_uptrend else min(prev_stop, min_ + band)
        new_uptrend = (s - candidate) >= 0

        if new_uptrend != prev_uptrend:
            max_, min_ = s, s
            candidate = (max_ - band) if new_uptrend else (min_ + band)

        stop[i] = candidate
        uptrend[i] = new_uptrend
        prev_stop = candidate
        prev_uptrend = new_uptrend

    df["atr"] = atr
    df["vstop_line"] = stop
    df["uptrend"] = uptrend
    return df


def _last_bar(df: pd.DataFrame) -> tuple[float, bool, pd.Timestamp]:
    last = df.iloc[-1]
    return float(last["vstop_line"]), bool(last["uptrend"]), pd.Timestamp(last["date"])


def main(ticker: str = "KAYNES.NS", cache_dir: str = "data_cache_literal"):
    root = Path(__file__).resolve().parents[1]
    weekly = pd.read_parquet(root / cache_dir / "weekly_ohlcv_260w.parquet")
    panel_full = weekly[weekly["ticker"] == ticker].sort_values("date").reset_index(drop=True)
    if panel_full.empty:
        print(f"no cached weekly bars for {ticker} in {cache_dir}")
        return

    print(f"=== VStop({LENGTH},{MULT}) parity check: {ticker} ===")
    print(f"cached weekly bars: {len(panel_full)} (from {panel_full['date'].min().date()} to {panel_full['date'].max().date()})\n")

    print("-- raw data spot-check (most recent 3 cached weekly bars) --")
    print(panel_full[["date", "open", "high", "low", "close", "volume"]].tail(3).to_string(index=False))
    print()

    print("-- 1. baseline: current compute_vstop() (src/indicators/vstop.py, unmodified) --")
    base = compute_vstop(panel_full, length=LENGTH, mult=MULT, source=SOURCE)
    b_sl, b_up, b_date = _last_bar(base)
    print(base[["date", "close", "atr", "vstop_line", "uptrend"]].tail(8).to_string(index=False))
    print(f"  current bar ({b_date.date()}): vstop_line={b_sl:.4f}  uptrend={b_up}\n")

    print("-- 2. seeding hypothesis: SMA-seeded Wilder ATR instead of ewm-from-bar-1 --")
    atr_seeded = wilder_atr_sma_seeded(panel_full["high"], panel_full["low"], panel_full["close"], LENGTH)
    seeded = compute_vstop_with_atr(panel_full, atr_seeded, LENGTH, MULT, SOURCE)
    s_sl, s_up, s_date = _last_bar(seeded)
    print(f"  current bar ({s_date.date()}): vstop_line={s_sl:.4f}  uptrend={s_up}")
    print(f"  delta vs baseline: {s_sl - b_sl:+.4f}\n")

    print("-- 3. history-window-length sensitivity (same seeding as baseline, different start) --")
    for weeks in (260, 130, 104):
        sliced = panel_full.tail(weeks).reset_index(drop=True)
        if len(sliced) < LENGTH + 1:
            continue
        v = compute_vstop(sliced, length=LENGTH, mult=MULT, source=SOURCE)
        w_sl, w_up, w_date = _last_bar(v)
        print(f"  last {weeks:>3}w window: vstop_line={w_sl:.4f}  uptrend={w_up}  delta vs 260w baseline: {w_sl - b_sl:+.4f}")
    print()

    print("-- 4. current in-progress week, extended with elapsed daily bars --")
    print("   (TradingView plots VStop live against the CURRENT (unclosed) week's own")
    print("    open/high-so-far/low-so-far/close-so-far, not last Friday's closed bar --")
    print("    most of what looks like a parity gap is usually this, not a data or")
    print("    algorithm defect. Needs network access; skipped gracefully if unavailable.)")
    partial_sl = partial_up = partial_date = None
    try:
        last_cached = panel_full["date"].max()
        this_week_start = last_cached + pd.Timedelta(days=7)
        daily = yf.Ticker(ticker).history(start=this_week_start.strftime("%Y-%m-%d"),
                                           end=(this_week_start + pd.Timedelta(days=6)).strftime("%Y-%m-%d"),
                                           interval="1d", auto_adjust=False)
        if daily.empty:
            print("   no daily bars yet for the current week -- nothing to extend with.")
        else:
            daily = daily.reset_index()
            new_row = pd.DataFrame([{
                "date": this_week_start,
                "open": float(daily.iloc[0]["Open"]),
                "high": float(daily["High"].max()),
                "low": float(daily["Low"].min()),
                "close": float(daily.iloc[-1]["Close"]),
                "volume": float(daily["Volume"].sum()),
            }])
            print(f"   elapsed days so far this week: {len(daily)}  "
                  f"partial bar: O={new_row['open'][0]:.2f} H={new_row['high'][0]:.2f} "
                  f"L={new_row['low'][0]:.2f} C(latest)={new_row['close'][0]:.2f}")
            ext = pd.concat([panel_full, new_row], ignore_index=True)
            partial = compute_vstop(ext, length=LENGTH, mult=MULT, source=SOURCE)
            partial_sl, partial_up, partial_date = _last_bar(partial)
            print(f"   current bar ({partial_date.date()}): vstop_line={partial_sl:.4f}  uptrend={partial_up}")
    except Exception as e:
        print(f"   skipped (no network or fetch error): {e}")
    print()

    print("-- summary (no conclusion / no fix -- diagnose only) --")
    print(f"  baseline, last CLOSED week (current code):  {b_sl:.4f}")
    print(f"  SMA-seeded ATR variant, last closed week:   {s_sl:.4f}  (delta {s_sl - b_sl:+.4f})")
    if partial_sl is not None:
        print(f"  extended with current IN-PROGRESS week:     {partial_sl:.4f}")
    print("  See the per-window deltas above for history-length sensitivity.")
    print("  Compare all of the above to your TradingView reading by hand -- if TradingView")
    print("  was read while the current week was still open, compare against line 4, not line 1.")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tk = args[0] if args else "KAYNES.NS"
    main(tk)
