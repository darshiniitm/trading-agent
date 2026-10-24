"""The engine's first request crashed with "Unexpected end of stream: Page was smaller than expected": one thread read
the weekly parquet cache while another was still writing it. These pin the fix (atomic writes, unreadable files treated
as a cache miss) at the file level and through the adapter."""
from __future__ import annotations

import sys
import threading
import time
import types

import numpy as np
import pandas as pd

from src.data.atomic import atomic_write_json, atomic_write_parquet, read_json_or_none, read_parquet_or_none


def _frame(n: int) -> pd.DataFrame:
    return pd.DataFrame({"ticker": ["A.NS"] * n, "date": pd.date_range("2020-01-01", periods=n, freq="W"),
                         "close": np.random.default_rng(n).random(n)})


def test_reader_never_sees_a_partial_file(tmp_path):
    path = tmp_path / "w.parquet"
    atomic_write_parquet(_frame(10), path)
    stop, errors, sizes = threading.Event(), [], set()

    def writer():
        i = 0
        while not stop.is_set():
            atomic_write_parquet(_frame(200_000 if i % 2 else 10), path)   # big writes are slow enough to overlap a read
            i += 1

    def reader():
        while not stop.is_set():
            try:
                sizes.add(len(pd.read_parquet(path)))   # plain read on purpose: the point is the file is always whole
            except Exception as e:   # noqa: BLE001
                errors.append(repr(e))

    ts = [threading.Thread(target=writer)] + [threading.Thread(target=reader) for _ in range(3)]
    [t.start() for t in ts]
    time.sleep(2.0)
    stop.set()
    [t.join() for t in ts]
    assert errors == []
    assert sizes <= {10, 200_000}
    assert not list(tmp_path.glob("*.tmp.*"))   # no temp files left behind


def test_truncated_parquet_is_a_cache_miss_and_is_kept_aside(tmp_path):
    path = tmp_path / "w.parquet"
    atomic_write_parquet(_frame(1000), path)
    path.write_bytes(path.read_bytes()[:200])   # what a crashed write used to leave
    assert read_parquet_or_none(path) is None
    assert not path.exists()
    assert len(list(tmp_path.glob("w.parquet.corrupt-*"))) == 1


def test_missing_and_bad_json_are_misses(tmp_path):
    assert read_json_or_none(tmp_path / "nope.json") is None
    p = tmp_path / "m.json"
    p.write_text('{"fetched_at": 12')
    assert read_json_or_none(p) is None
    atomic_write_json(p, {"fetched_at": 1})
    assert read_json_or_none(p) == {"fetched_at": 1}


def _fake_yf(calls: list):
    def download(tickers, **kw):
        calls.append(list(tickers))
        idx = pd.date_range("2024-01-05", periods=5, freq="W-FRI", name="Date")
        cols = pd.MultiIndex.from_product([tickers, ["Open", "High", "Low", "Close", "Volume"]])
        return pd.DataFrame(np.ones((5, len(cols))), index=idx, columns=cols)
    return types.SimpleNamespace(download=download)


def test_adapter_refetches_instead_of_failing_on_a_corrupt_weekly_cache(tmp_path, monkeypatch):
    from src.data.adapter import OpenSourceAdapter
    calls: list = []
    monkeypatch.setitem(sys.modules, "yfinance", _fake_yf(calls))
    a = OpenSourceAdapter(cache_dir=tmp_path, index_lists=[])
    (tmp_path / "weekly_ohlcv_52w.parquet").write_bytes(b"PAR1 not really a parquet file")
    (tmp_path / "weekly_ohlcv_52w.meta.json").write_text('{"fetched_at": %f}' % time.time())   # looks fresh
    out = a.weekly_ohlcv(["X.NS", "Y.NS"], 52)   # used to raise OSError
    assert set(out) == {"X.NS", "Y.NS"}
    assert calls == [["X.NS", "Y.NS"]]
    assert len(list(tmp_path.glob("weekly_ohlcv_52w.parquet.corrupt-*"))) == 1
    assert read_parquet_or_none(tmp_path / "weekly_ohlcv_52w.parquet") is not None   # rewritten whole
