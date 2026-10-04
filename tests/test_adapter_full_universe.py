"""
Literal spec (Phase 1): full-NSE-equity-list universe loading in src/data/adapter.py.

Hermetic per HARNESS.md rule 8 — everything is served from a pre-written cache file,
never a live NSE/yfinance call. Covers: SERIES filtering, sector backfill from the
index-CSV union with an explicit "Unknown" fallback, ticker suffixing, and that
build_adapter() defaults to Control's index_lists path when universe.source is absent.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.data.adapter import (  # noqa: E402
    FULL_LIST_KNOWN_CAVEATS,
    KNOWN_CAVEATS,
    OpenSourceAdapter,
    build_adapter,
)


@pytest.fixture
def cache_dir(tmp_path):
    d = tmp_path / "cache"
    d.mkdir()
    # Fake full equity master list — same column names NSE's real EQUITY_L.csv uses.
    full = pd.DataFrame({
        "SYMBOL": ["ABCIND", "XYZCO", "NOTEQ"],
        "NAME OF COMPANY": ["ABC Industries Ltd.", "XYZ Company Ltd.", "Not An Equity Ltd."],
        "SERIES": ["EQ", "EQ", "BE"],
        "ISIN NUMBER": ["INE001", "INE002", "INE003"],
    })
    full.to_csv(d / "universe_full_equity_list.csv", index=False)
    # Fake index-constituent CSV (Control's format) — only ABCIND overlaps, for sector backfill.
    idx = pd.DataFrame({
        "Symbol": ["ABCIND"],
        "Company Name": ["ABC Industries Ltd."],
        "Industry": ["Chemicals"],
        "Series": ["EQ"],
        "ISIN Code": ["INE001"],
    })
    idx.to_csv(d / "universe_midcap150.csv", index=False)
    return d


def test_series_filter_drops_non_eq(cache_dir):
    a = OpenSourceAdapter(cache_dir=cache_dir, index_lists=["midcap150"], universe_source="full_nse_equity_list")
    out = a.nse_equities_pit(as_of="2026-09-26")
    assert set(out["symbol"]) == {"ABCIND", "XYZCO"}  # NOTEQ (series=BE) excluded


def test_sector_backfill_and_unknown_fallback(cache_dir):
    a = OpenSourceAdapter(cache_dir=cache_dir, index_lists=["midcap150"], universe_source="full_nse_equity_list")
    out = a.sector_map_pit(as_of="2026-09-26").set_index("symbol")
    assert out.loc["ABCIND", "sector"] == "Chemicals"   # backfilled from the index CSV
    assert out.loc["XYZCO", "sector"] == "Unknown"       # not in any index list -> explicit, not silent


def test_ticker_suffix_added(cache_dir):
    a = OpenSourceAdapter(cache_dir=cache_dir, index_lists=["midcap150"], universe_source="full_nse_equity_list")
    out = a.nse_equities_pit(as_of="2026-09-26")
    assert set(out["ticker"]) == {"ABCIND.NS", "XYZCO.NS"}


def test_caveats_flag_full_list_scope(cache_dir):
    a = OpenSourceAdapter(cache_dir=cache_dir, index_lists=["midcap150"], universe_source="full_nse_equity_list")
    assert a.caveats() == FULL_LIST_KNOWN_CAVEATS
    b = OpenSourceAdapter(cache_dir=cache_dir, index_lists=["midcap150"])
    assert b.caveats() == KNOWN_CAVEATS


def test_build_adapter_defaults_to_index_lists_when_source_absent(tmp_path):
    # Control's rules.yaml has no universe.source key at all — must not require one.
    rule_spec = {
        "data_source": "opensource",
        "data": {"cache_dir": str(tmp_path)},
        "universe": {"index_lists": ["midcap150", "nifty500"]},
    }
    a = build_adapter(rule_spec)
    assert a.universe_source == "index_lists"
    assert a.index_lists == ["midcap150", "nifty500"]


def test_build_adapter_wires_full_list_source(tmp_path):
    rule_spec = {
        "data_source": "opensource",
        "data": {"cache_dir": str(tmp_path)},
        "universe": {"source": "full_nse_equity_list", "index_lists": ["midcap150"]},
    }
    a = build_adapter(rule_spec)
    assert a.universe_source == "full_nse_equity_list"
