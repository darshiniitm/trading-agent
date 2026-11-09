"""The 2 GB VM changes (scripts/measure_engine_memory.py): batched/incremental Yahoo fetches, the daily history floor,
compact panels, no-copy DataContext, day-file pruning. Each must leave the bars the engine computes on unchanged
(except the deliberate retain_since floor)."""
from __future__ import annotations

import os
import time
from datetime import date

import numpy as np
import pandas as pd

from engine.resolution.ohlcv import OhlcvCache, YahooProvider, compact_panel
from engine.resolution.ops import prune_dated_files
from engine.resolution.types import DataRequest, DataType
from engine.v5.data import DataContext
from src.data.adapter import _download_long, _split_by_ticker

COLS = ["ticker", "date", "open", "high", "low", "close", "volume"]


def bars(t: str, start: str, n: int, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    c = 100 + rng.standard_normal(n).cumsum()
    return pd.DataFrame({"ticker": t, "date": pd.bdate_range(start, periods=n), "open": c, "high": c + 1, "low": c - 1,
                         "close": c, "volume": rng.integers(1, 10_000, n).astype(float)})


class FakeYF:
    """yf.download(group_by='ticker') shape: MultiIndex columns (ticker, field), DatetimeIndex 'Date'."""

    def __init__(self, data: dict[str, pd.DataFrame]):
        self.data, self.calls = data, []

    def download(self, tickers, start=None, **_kw):
        self.calls.append((list(tickers), start))
        cols = {}
        for t in tickers:
            b = self.data[t].set_index("date")
            if start is not None:
                b = b[b.index >= pd.Timestamp(start)]
            for c in ("open", "high", "low", "close", "volume"):
                cols[(t, c.capitalize())] = b[c]
        wide = pd.DataFrame(cols)
        wide.index.name = "Date"
        wide.columns = pd.MultiIndex.from_tuples(wide.columns)
        return wide


def test_groupby_split_matches_the_old_per_ticker_mask():
    panel = pd.concat([bars(f"T{i}.NS", "2024-01-01", 50 + i, seed=i) for i in range(7)]).sample(frac=1, random_state=1)
    panel = panel.sort_values(["ticker", "date"])
    tickers = [f"T{i}.NS" for i in (3, 0, 6, 99)]
    new = _split_by_ticker(panel, tickers)
    assert list(new) == ["T3.NS", "T0.NS", "T6.NS"]
    for t in new:
        old = panel[panel["ticker"] == t].sort_values("date").reset_index(drop=True)
        pd.testing.assert_frame_equal(new[t], old)
    assert _split_by_ticker(pd.DataFrame(), tickers) == {} and _split_by_ticker(None, tickers) == {}


def test_batched_download_equals_one_bulk_call():
    data = {f"T{i}.NS": bars(f"T{i}.NS", "2024-01-01", 30 + 3 * i, seed=i) for i in range(9)}
    yf = FakeYF(data)
    batched = _download_long(yf, list(data), chunk=4)
    bulk = _download_long(FakeYF(data), list(data), chunk=1000)
    assert [len(c[0]) for c in yf.calls] == [4, 4, 1]
    key = ["ticker", "date"]
    pd.testing.assert_frame_equal(batched.sort_values(key).reset_index(drop=True), bulk.sort_values(key).reset_index(drop=True))
    for t, b in _split_by_ticker(batched.sort_values(key), list(data)).items():
        pd.testing.assert_frame_equal(b[COLS], data[t][COLS], check_names=False, check_freq=False)


class Adapter:
    def __init__(self, data):
        self.data, self.full, self.since = data, [], []

    def daily_ohlcv(self, tickers, days):
        self.full.append(list(tickers))
        return {t: self.data[t] for t in tickers if t in self.data}

    def daily_ohlcv_since(self, tickers, start):
        self.since.append((list(tickers), start))
        return {t: self.data[t][self.data[t]["date"] >= pd.Timestamp(start)].reset_index(drop=True) for t in tickers}


def test_yahoo_tops_up_a_cached_symbol_from_its_last_bar_and_fetches_new_symbols_in_full(tmp_path):
    full = {"OLD.NS": bars("OLD.NS", "2025-01-01", 300, 1), "NEW.NS": bars("NEW.NS", "2025-01-01", 300, 2)}
    cache = OhlcvCache(tmp_path)
    cache.save("OLD.NS", full["OLD.NS"].iloc[:-10], "yahoo")              # cache is 10 sessions behind
    adapter = Adapter(full)
    as_of = full["OLD.NS"]["date"].iloc[-1].date()
    res = YahooProvider(adapter, 400, cache).fetch(DataRequest(DataType.OHLCV, as_of, symbols=["OLD.NS", "NEW.NS"]))
    last_cached = full["OLD.NS"]["date"].iloc[-11]
    assert adapter.since == [(["OLD.NS"], str((last_cached - pd.Timedelta(days=7)).date()))]
    assert adapter.full == [["NEW.NS"]]
    for s in full:   # cached history + new days == what a full refetch returns
        pd.testing.assert_frame_equal(res.value[s][COLS], full[s][COLS], check_dtype=False, check_categorical=False, check_freq=False)
        assert cache.meta(s)["as_of"] == str(as_of)


def test_retain_since_drops_older_bars_on_load_and_save(tmp_path):
    b = bars("A.NS", "2021-06-01", 400)
    OhlcvCache(tmp_path).save("A.NS", b, "yahoo")                         # written with no floor: all 400 rows on disk
    floored = OhlcvCache(tmp_path, date(2022, 1, 1))
    loaded = floored.load("A.NS")
    assert loaded["date"].min() >= pd.Timestamp("2022-01-01")
    assert len(loaded) == int((b["date"] >= pd.Timestamp("2022-01-01")).sum())
    floored.save("A.NS", b.iloc[-5:], "yahoo")                            # next write shrinks the file too
    assert pd.read_parquet(tmp_path / "A.NS.parquet")["date"].min() >= pd.Timestamp("2022-01-01")


def test_compact_panel_keeps_every_value():
    b = bars("A.NS", "2024-01-01", 80).iloc[::-1].reset_index(drop=True)
    b["date"] = b["date"].dt.strftime("%Y-%m-%d")
    c = compact_panel(b)
    assert isinstance(c["ticker"].dtype, pd.CategoricalDtype) and pd.api.types.is_datetime64_any_dtype(c["date"])
    assert c["date"].is_monotonic_increasing and (c["ticker"] == "A.NS").all()
    ref = b.assign(date=pd.to_datetime(b["date"])).sort_values("date").reset_index(drop=True)
    pd.testing.assert_frame_equal(c, ref, check_dtype=False, check_categorical=False)
    assert c.memory_usage(deep=True)["ticker"] < ref.memory_usage(deep=True)["ticker"] / 4


def test_datacontext_caches_normalized_panels_without_copying_and_stays_isolated():
    daily = compact_panel(bars("A.NS", "2024-01-01", 120))
    weekly = compact_panel(bars("A.NS", "2024-01-01", 30).assign(date=lambda x: pd.date_range("2024-01-01", periods=30, freq="W-MON")))
    ctx = DataContext(pd.DataFrame({"ticker": ["A.NS"]}), daily_panels={"A.NS": daily}, weekly_panels={"A.NS": weekly})
    assert ctx._full("A.NS", "1D") is daily and ctx._full("A.NS", "1W") is weekly
    before = daily.copy()
    out = ctx.bars("A.NS", "1D", pd.Timestamp("2024-03-01"))              # what callers get, and may edit
    out.loc[0, "close"] = -1.0
    out["close"] *= 2                                                     # copy-on-write: the cached panel never changes
    w = ctx.bars("A.NS", "1W", pd.Timestamp("2024-06-01"))
    w.loc[0, "open"] = -1.0
    pd.testing.assert_frame_equal(ctx._full("A.NS", "1D"), before)
    assert ctx._full("A.NS", "1W")["open"].iloc[0] != -1.0
    pd.testing.assert_frame_equal(daily, before)


def test_datacontext_still_normalizes_unsorted_string_dated_input():
    raw = bars("A.NS", "2024-01-01", 60).iloc[::-1].reset_index(drop=True)
    raw["date"] = raw["date"].dt.strftime("%Y-%m-%d")
    ctx = DataContext(pd.DataFrame({"ticker": ["A.NS"]}), daily_panels={"A.NS": raw})
    got = ctx._full("A.NS", "1D")
    assert got is not raw and got["date"].is_monotonic_increasing and pd.api.types.is_datetime64_any_dtype(got["date"])


def test_prune_removes_only_old_day_files(tmp_path):
    bhav, master, views = tmp_path / "b", tmp_path / "m", tmp_path / "v"
    for d in (bhav, master, views):
        d.mkdir()
    (bhav / "2026-09-01.parquet").write_bytes(b"x")
    (bhav / "2026-11-01.parquet").write_bytes(b"x")
    (bhav / "notes.txt").write_bytes(b"x")
    (master / "2026-08-01.csv").write_bytes(b"x")
    old_view, new_view = views / "OLD.parquet", views / "NEW.parquet"
    old_view.write_bytes(b"x"); new_view.write_bytes(b"x")
    os.utime(old_view, (time.time() - 10 * 86400,) * 2)
    cfg = {"ohlcv": {"bhavcopy_dir": str(bhav)}, "ops": {"equity_master_dir": str(master), "keep_day_files_days": 30,
                                                        "views_cache_dir": str(views)}}
    assert prune_dated_files(cfg, date(2026, 11, 9)) == 3
    assert sorted(p.name for p in tmp_path.rglob("*.*")) == ["2026-11-01.parquet", "NEW.parquet", "notes.txt"]
