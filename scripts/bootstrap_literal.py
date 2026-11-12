"""
One-off runner: populate data_cache_literal/ with the real full-NSE universe list,
weekly OHLCV, and shares outstanding, via the same building blocks as
scripts/common.py:bootstrap() (config-driven, HARNESS §2) -- with chunked, retried
fetches instead of one giant call, since a single yf.download() for ~2300 tickers
at once reliably trips Yahoo's rate limiter (confirmed: first attempt got only
1474/2317 tickers and 0 shares before being rate-limited).

Safe to re-run: each chunk only fetches tickers not already cached on disk, so a
partial/interrupted run picks up where it left off.

Needs network; run on your Mac, not inside a test.

usage:
    .venv/bin/python scripts/bootstrap_literal.py [--chunk 40] [--pause 8]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.config import load_rule_spec  # noqa: E402
from src.data.adapter import build_adapter  # noqa: E402


def _cached_weekly_tickers(cache_dir: Path, history_weeks: int) -> set[str]:
    p = cache_dir / f"weekly_ohlcv_{history_weeks}w.parquet"
    if not p.exists():
        return set()
    return set(pd.read_parquet(p, columns=["ticker"])["ticker"].unique())


def _cached_shares(cache_dir: Path) -> dict[str, float]:
    import json
    p = cache_dir / "shares_outstanding.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chunk", type=int, default=40)
    ap.add_argument("--pause", type=float, default=8.0)
    args = ap.parse_args()

    rule_spec = load_rule_spec("config/rules_literal.yaml")
    adapter = build_adapter(rule_spec)
    cache_dir = Path(rule_spec["data"]["cache_dir"])
    history_weeks = rule_spec["data"]["history_weeks"]

    universe_df = adapter.nse_equities_pit(as_of=None)
    tickers = universe_df["ticker"].tolist()
    print(f"universe size: {len(universe_df)}")

    cached = _cached_weekly_tickers(cache_dir, history_weeks)
    missing = [t for t in tickers if t not in cached]
    print(f"weekly OHLCV: {len(cached)}/{len(tickers)} already cached, "
          f"fetching {len(missing)} remaining in chunks of {args.chunk}...")

    for i in range(0, len(missing), args.chunk):
        batch = missing[i:i + args.chunk]
        for attempt in range(4):
            try:
                adapter.weekly_ohlcv(batch, history_weeks)
                break
            except Exception as e:
                wait = args.pause * (attempt + 1)
                print(f"  batch {i // args.chunk + 1}: attempt {attempt + 1} failed ({e}); sleeping {wait:.0f}s")
                time.sleep(wait)
        got_so_far = len(_cached_weekly_tickers(cache_dir, history_weeks))
        print(f"  {min(i + args.chunk, len(missing))}/{len(missing)} attempted "
              f"({got_so_far}/{len(tickers)} total cached)")
        time.sleep(args.pause)

    final_cached = _cached_weekly_tickers(cache_dir, history_weeks)
    still_missing = sorted(set(tickers) - final_cached)
    print(f"\nweekly panels: {len(final_cached)}/{len(tickers)} tickers "
          f"(still missing {len(still_missing)})")

    print("\nFetching shares outstanding...")
    have_shares = _cached_shares(cache_dir)
    shares_tickers = sorted(final_cached)
    shares_missing = [t for t in shares_tickers if t not in have_shares]
    for i in range(0, len(shares_missing), args.chunk):
        batch = shares_missing[i:i + args.chunk]
        adapter.shares_outstanding(batch)
        n = len(_cached_shares(cache_dir))
        print(f"  {min(i + args.chunk, len(shares_missing))}/{len(shares_missing)} attempted "
              f"({n} total with shares)")
        time.sleep(args.pause / 2)

    final_shares = _cached_shares(cache_dir)
    print(f"\nshares outstanding: {len(final_shares)}/{len(shares_tickers)} tickers")
    if still_missing:
        print(f"missing weekly data for {len(still_missing)} tickers "
              f"(first 20: {still_missing[:20]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
