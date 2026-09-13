"""Shared bootstrap: load rule spec, pull universe + weekly data + shares outstanding."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd

from src.config import load_rule_spec
from src.data.adapter import build_adapter


def bootstrap(rule_spec_path: str = "config/rules.yaml", ticker_limit: int | None = None):
    rule_spec = load_rule_spec(rule_spec_path)
    adapter = build_adapter(rule_spec)

    universe_df = adapter.nse_equities_pit(as_of=None)
    if ticker_limit:
        universe_df = universe_df.head(ticker_limit)

    tickers = universe_df["ticker"].tolist()
    history_weeks = rule_spec["data"]["history_weeks"]

    print(f"Fetching weekly OHLCV for {len(tickers)} tickers ({history_weeks} weeks each)...")
    weekly_panels = adapter.weekly_ohlcv(tickers, history_weeks)
    print(f"  got data for {len(weekly_panels)}/{len(tickers)} tickers")

    print("Fetching shares outstanding (current; PIT caveat — see adapter.KNOWN_CAVEATS)...")
    shares_map = adapter.shares_outstanding(list(weekly_panels.keys()))
    print(f"  got shares for {len(shares_map)}/{len(weekly_panels)} tickers")

    return rule_spec, adapter, universe_df, weekly_panels, shares_map


def trading_fridays(weekly_panels: dict, min_history_weeks: int) -> list[pd.Timestamp]:
    """Canonical as-of date calendar: union of all bar dates across tickers, sorted,
    trimmed to dates that have at least `min_history_weeks` of prior history somewhere."""
    all_dates = sorted(set(d for p in weekly_panels.values() for d in p["date"]))
    all_dates = [pd.Timestamp(d) for d in all_dates]
    if len(all_dates) <= min_history_weeks:
        return all_dates
    return all_dates[min_history_weeks:]
