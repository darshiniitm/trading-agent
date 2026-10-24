"""M3: OHLCV chain — acceptance #6 (Yahoo down -> bhavcopy), #7 (Google close-only), #11 (price mismatch)."""
from __future__ import annotations

import io
import zipfile
from datetime import date

import pandas as pd

from engine.resolution.calendar import TradingCalendar
from engine.resolution.ohlcv import OhlcvCache, OhlcvService, build_ohlcv_resolver, parse_bhavcopy
from engine.resolution.config import load_config

DAY = date(2026, 10, 6)


def frame(sym, last=DAY, close=100.0, n=40):
    d = pd.bdate_range(end=pd.Timestamp(last), periods=n)
    return pd.DataFrame({"ticker": sym, "date": d, "open": close, "high": close + 1, "low": close - 1, "close": close, "volume": 1000.0})


class Adapter:
    def __init__(self, data=None, boom=False): self.data, self.boom, self.calls = data or {}, boom, 0
    def daily_ohlcv(self, tickers, days):
        self.calls += 1
        if self.boom: raise OSError("yahoo down")
        return {t: self.data[t] for t in tickers if t in self.data}


def bhav_zip(rows):
    csv = "TradDt,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol\n" + "".join(f"{DAY},{s},EQ,{c},{c},{c},{c},500\n" for s, c in rows)
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z: z.writestr("x.csv", csv)
    return b.getvalue()


def service(tmp_path, adapter, fetcher, network=True):
    cfg = load_config()
    cfg["ohlcv"] = {**cfg["ohlcv"], "cache_dir": str(tmp_path / "c"), "bhavcopy_dir": str(tmp_path / "b")}
    cfg["providers"] = {**cfg["providers"], "retries": 0, "backoff_s": 0, "timeout_s": 2}
    gaps = []
    r, cache, cal = build_ohlcv_resolver(adapter, 400, cfg, network, fetcher, TradingCalendar(), gap_log=gaps.append, sleep=lambda s: None)
    return OhlcvService(r, cache, cal, cfg, gaps.append), cache, gaps


def nofetch(url, t): raise OSError("offline")


def test_parse_bhavcopy():
    df = parse_bhavcopy(bhav_zip([("AAA", 10.0)]))
    assert df.iloc[0]["ticker"] == "AAA.NS" and df.iloc[0]["close"] == 10.0


def test_yahoo_happy_path_is_ok_and_writes_cache(tmp_path):
    svc, cache, _ = service(tmp_path, Adapter({"A.NS": frame("A.NS")}), nofetch)
    panels, prov = svc.daily_panels(["A.NS"], DAY, 30)
    assert prov["A.NS"].quality == "ok" and prov["A.NS"].source == "yahoo" and len(panels["A.NS"]) == 40
    assert cache.load("A.NS") is not None
    svc2, _, _ = service(tmp_path, Adapter(boom=True), nofetch)          # now served from the fresh cache
    _, prov2 = svc2.daily_panels(["A.NS"], DAY, 30)
    assert prov2["A.NS"].quality == "ok" and prov2["A.NS"].source == "cache:yahoo"


def test_yahoo_down_bhavcopy_fills_as_fallback(tmp_path):
    fetch = lambda url, t: bhav_zip([("A", 55.0)])
    svc, _, gaps = service(tmp_path, Adapter(boom=True), fetch)
    panels, prov = svc.daily_panels(["A.NS"], DAY, 1)
    assert prov["A.NS"].quality == "fallback" and prov["A.NS"].source == "nse_bhavcopy"
    assert panels["A.NS"].iloc[-1]["close"] == 55.0
    assert any(g["provider"] == "yahoo" for g in gaps)


def test_google_close_only_flags_partial_fields(tmp_path):
    fetch = lambda url, t: (_ for _ in ()).throw(OSError()) if "nsearchives" in url else "<div>₹1,207.50</div>".encode()
    svc, _, _ = service(tmp_path, Adapter(boom=True), fetch)
    panels, prov = svc.daily_panels(["A.NS"], DAY, 1)
    r = prov["A.NS"]
    assert r.source == "google_finance" and r.quality == "fallback" and r.reason == "partial_fields" and r.meta["fields"] == ["close"]
    assert panels["A.NS"].iloc[-1]["close"] == 1207.5 and pd.isna(panels["A.NS"].iloc[-1]["high"])


def test_everything_down_uses_stale_cache_then_missing(tmp_path):
    svc, cache, _ = service(tmp_path, Adapter(boom=True), nofetch)
    cache.save("OLD.NS", frame("OLD.NS", last=date(2026, 9, 1)), "yahoo")
    panels, prov = svc.daily_panels(["OLD.NS", "NONE.NS"], DAY, 1)
    assert prov["OLD.NS"].quality == "stale" and prov["OLD.NS"].reason == "stale_data"
    assert prov["NONE.NS"].missing and "NONE.NS" not in panels


def test_live_source_lagging_the_calendar_is_stale(tmp_path):
    svc, _, _ = service(tmp_path, Adapter({"A.NS": frame("A.NS", last=date(2026, 9, 25))}), nofetch)
    _, prov = svc.daily_panels(["A.NS"], DAY, 1)
    assert prov["A.NS"].quality == "stale"


def test_price_mismatch_prefers_bhavcopy_and_logs(tmp_path):
    fetch = lambda url, t: bhav_zip([("A", 101.0)])
    svc, _, gaps = service(tmp_path, Adapter({"A.NS": frame("A.NS", close=100.0)}), fetch)
    bp = next(p for p in svc.resolver.chain(__import__("engine.resolution.types", fromlist=["DataType"]).DataType.OHLCV) if p.name == "nse_bhavcopy")
    bp.day(DAY)                                                     # prefetch put today's bhavcopy on disk
    panels, prov = svc.daily_panels(["A.NS"], DAY, 1)               # Yahoo says 100, bhavcopy says 101 (1%)
    assert panels["A.NS"].iloc[-1]["close"] == 101.0 and prov["A.NS"].reason == "price_mismatch"
    assert any(g["reason"] == "price_mismatch" for g in gaps)


def test_small_difference_is_not_a_mismatch(tmp_path):
    fetch = lambda url, t: bhav_zip([("A", 100.2)])
    svc, _, gaps = service(tmp_path, Adapter({"A.NS": frame("A.NS", close=100.0)}), fetch)
    next(p for p in svc.resolver.chain(list(svc.resolver._chains)[0]) if p.name == "nse_bhavcopy").day(DAY)
    panels, prov = svc.daily_panels(["A.NS"], DAY, 1)
    assert panels["A.NS"].iloc[-1]["close"] == 100.0 and prov["A.NS"].quality == "ok" and not gaps


def test_regression_full_data_returns_adapter_frames_unchanged(tmp_path):
    data = {f"S{i}.NS": frame(f"S{i}.NS", close=50 + i, n=60) for i in range(5)}
    svc, _, _ = service(tmp_path, Adapter(data), nofetch)
    panels, prov = svc.daily_panels(list(data), DAY)
    assert set(panels) == set(data) and all(p.quality == "ok" for p in prov.values())
    for s in data:
        pd.testing.assert_frame_equal(panels[s].reset_index(drop=True), data[s].reset_index(drop=True))
    panels2, _ = service(tmp_path, Adapter(boom=True), nofetch)[0].daily_panels(list(data), DAY)   # from the written cache
    for s in data:
        pd.testing.assert_frame_equal(panels2[s].reset_index(drop=True), data[s].reset_index(drop=True), check_dtype=False)
