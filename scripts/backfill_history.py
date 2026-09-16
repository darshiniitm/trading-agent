"""
Backfill daily OHLCV from a fixed start date (default 2019-01-01) for the whole universe plus the
benchmark, into data_cache/daily_ohlcv_since_<start>.parquet
(docs/open-decisions-implementation-plan.md §4, decision D1: "fetch from 2019 onwards").

Weekly history for the dev and holdout_ext segments is then built from these daily bars with
src/data/resample.py:daily_to_weekly — NOT from yfinance interval="1wk", whose bars in weeks with
a Monday holiday report the previous Friday's close as the week's open (see findings 2026-09-16).

Needs network (run on your Mac):
    .venv/bin/python scripts/backfill_history.py [--start 2019-01-01] [--chunk 50]

Does not touch data_cache/weekly_ohlcv_260w.parquet or daily_ohlcv_1820d.parquet (the live and
forward-test caches).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.config import load_rule_spec  # noqa: E402
from src.data.adapter import build_adapter  # noqa: E402


def _download(tickers: list[str], start: str) -> pd.DataFrame:
    import yfinance as yf

    raw = yf.download(tickers=tickers, start=start, interval="1d", auto_adjust=False,
                      group_by="ticker", threads=True, progress=False)
    frames = []
    for t in tickers:
        try:
            sub = raw[t].dropna(how="all")
        except KeyError:
            continue
        if sub.empty:
            continue
        sub = sub.reset_index().rename(columns=str.lower)
        sub["ticker"] = t
        frames.append(sub[["ticker", "date", "open", "high", "low", "close", "volume"]])
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2019-01-01")
    ap.add_argument("--chunk", type=int, default=50)
    args = ap.parse_args()

    rule_spec = load_rule_spec(str(ROOT / "config" / "rules.yaml"))
    adapter = build_adapter(rule_spec)
    tickers = adapter.nse_equities_pit(as_of=None)["ticker"].tolist()
    tickers.append(rule_spec["sector"]["benchmark_ticker"])

    out = ROOT / rule_spec["data"]["cache_dir"] / f"daily_ohlcv_since_{args.start}.parquet"
    frames, missing = [], []
    for i in range(0, len(tickers), args.chunk):
        chunk = tickers[i:i + args.chunk]
        for attempt in range(3):
            try:
                df = _download(chunk, args.start)
                break
            except Exception as e:  # network hiccup: back off and retry the chunk
                print(f"  chunk {i // args.chunk + 1}: attempt {attempt + 1} failed ({e}); retrying")
                time.sleep(5 * (attempt + 1))
        else:
            df = pd.DataFrame()
        got = set(df["ticker"]) if not df.empty else set()
        missing += [t for t in chunk if t not in got]
        frames.append(df)
        print(f"  {min(i + args.chunk, len(tickers))}/{len(tickers)} tickers fetched")

    panel = pd.concat(frames, ignore_index=True).drop_duplicates(["ticker", "date"]).sort_values(["ticker", "date"])
    panel.to_parquet(out, index=False)
    firsts = panel.groupby("ticker")["date"].min()
    meta = {"fetched_at": time.time(), "start": args.start, "n_tickers": int(panel["ticker"].nunique()),
            "missing": missing, "first_date_min": str(firsts.min()), "first_date_median": str(firsts.median()),
            "tickers_starting_after_start_plus_90d": int((firsts > pd.Timestamp(args.start) + pd.Timedelta(days=90)).sum())}
    out.with_suffix(".meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
