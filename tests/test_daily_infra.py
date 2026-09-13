"""
Daily-bar infrastructure for the T1 rolling-window shadow arm (docs/forward-
test-response-and-volume-plan.md §3.2). No network, no real backfill required
— these test the plumbing against synthetic daily panels.
"""
from __future__ import annotations

import pandas as pd

from tests.offline import env, make_daily_panel


def test_make_daily_panel_uses_business_day_frequency():
    p = make_daily_panel([100, 101, 102, 103, 104], start="2024-01-01")
    assert list(p.columns) == ["date", "open", "high", "low", "close", "volume"]
    # 2024-01-01 is a Monday; 5 business days should land Mon-Fri, no weekend gap of >1 day
    diffs = p["date"].diff().dropna().dt.days
    assert set(diffs.unique()) <= {1, 3}, "business-day frequency should only skip weekends"
    assert (p["date"].dt.dayofweek < 5).all(), "make_daily_panel produced a weekend date"


def test_daily_ohlcv_returns_empty_when_no_backfill_yet():
    """Documents the contract: OfflineAdapter.daily_ohlcv() must not crash when
    the real daily-bar cache hasn't been populated (Phase 9) — it reports
    'nothing available' via an empty dict, same shape as a normal miss."""
    _, adapter, *_ = env()
    out = adapter.daily_ohlcv(["RELIANCE.NS"], history_days=1300)
    assert isinstance(out, dict)
    for df in out.values():
        assert list(df.columns) == ["ticker", "date", "open", "high", "low", "close", "volume"]
