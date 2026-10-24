"""P6 watchlist-view metrics: hand-computed fixtures (docs/watchlist-views-implementation-plan.md §3)."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from engine import metrics as m


def bars(closes, start="2026-01-01", high_pad=0.0, low_pad=0.0, vol=100):
    idx = pd.bdate_range(start, periods=len(closes))
    c = np.array(closes, dtype=float)
    return pd.DataFrame({"date": idx, "open": c, "high": c + high_pad, "low": c - low_pad, "close": c,
                         "volume": [vol] * len(c) if np.isscalar(vol) else vol})


def test_avg_vol_is_mean_of_last_n_completed_sessions():
    df = bars([10] * 12, vol=list(range(1, 13)))
    assert m.avg_vol(df, 10) == pytest.approx(sum(range(3, 13)) / 10)
    assert m.avg_vol(bars([10] * 5), 10) is None  # short history is unknown, not a partial mean


def test_volatility_is_mean_high_low_range_pct_over_sessions():
    # every bar: low=100, high=101 -> (101-100)/100*100 = 1.0
    df = bars([100.5] * 30, high_pad=0.5, low_pad=0.5)
    assert m.volatility(df, 1) == pytest.approx(1.0)
    assert m.volatility(df, 21) == pytest.approx(1.0)
    assert m.volatility(bars([100.0] * 3, high_pad=1, low_pad=0), 5) is None


def test_perf_uses_close_on_or_before_target_date_and_none_without_history():
    idx = pd.to_datetime(["2026-01-02", "2026-01-09", "2026-02-02", "2026-03-02"])
    df = pd.DataFrame({"date": idx, "close": [100.0, 110.0, 121.0, 150.0]})
    p = m.perf(df)
    # 1M back from 2026-03-02 -> 2026-02-02 (121); 1W back -> 2026-02-23 -> last close on/before is 2026-02-02 (121)
    assert p["perf_1m"] == pytest.approx((150 / 121 - 1) * 100)
    assert p["perf_1w"] == pytest.approx((150 / 121 - 1) * 100)
    assert p["perf_3m"] is None  # 3M back = 2025-12-02, before first bar
    # YTD: no prior-year close in data -> None; All time vs first close
    assert p["perf_ytd"] is None
    assert p["perf_all"] == pytest.approx(50.0)
    assert p["first_close_date"] == "2026-01-02"


def test_perf_ytd_vs_last_close_of_previous_year():
    idx = pd.to_datetime(["2025-12-30", "2025-12-31", "2026-01-05", "2026-02-02"])
    df = pd.DataFrame({"date": idx, "close": [90.0, 100.0, 105.0, 120.0]})
    assert m.perf(df)["perf_ytd"] == pytest.approx(20.0)


def test_beta_is_cov_over_var_on_common_dates():
    n = 300
    rng = np.random.default_rng(1)
    bm_ret = rng.normal(0, 0.01, n)
    bm = pd.DataFrame({"date": pd.bdate_range("2025-01-01", periods=n + 1), "close": 100 * np.cumprod(np.r_[1, 1 + bm_ret])})
    sym = bm.copy()
    sym["close"] = 100 * np.cumprod(np.r_[1, 1 + 1.5 * bm_ret])
    b = m.beta(sym, bm, years=1)
    assert b == pytest.approx(1.5, abs=0.02)
    assert m.beta(sym.head(10), bm, years=1) is None  # fewer than 20 aligned returns


def test_rsi_mom_ao_cci_basic_properties():
    up = bars(list(range(1, 61)), high_pad=1, low_pad=1)
    ind = m.indicators(up)
    assert ind["rsi14"] == pytest.approx(100.0)
    assert ind["mom10"] == pytest.approx(10.0)
    assert ind["ao"] > 0
    assert ind["cci20"] > 0
    down = bars(list(range(60, 0, -1)), high_pad=1, low_pad=1)
    d = m.indicators(down)
    assert d["rsi14"] == pytest.approx(0.0)
    assert d["ao"] < 0 and d["cci20"] < 0


def test_ao_hand_computed():
    # closes 1..40, high=low=close -> hl2 = close; SMA5(36..40)=38, SMA34(7..40)=23.5 -> AO=14.5
    assert m.indicators(bars(list(range(1, 41))))["ao"] == pytest.approx(14.5)


def test_indicators_none_on_short_history():
    ind = m.indicators(bars([10, 11, 12]))
    assert ind["rsi14"] is None and ind["mom10"] is None and ind["ao"] is None and ind["cci20"] is None


def test_rating_label_bands():
    L = m.rating_label
    assert L(-1) == "Strong sell" and L(-0.5001) == "Strong sell"
    assert L(-0.5) == "Sell" and L(-0.11) == "Sell"
    assert L(-0.1) == "Neutral" and L(0) == "Neutral" and L(0.1) == "Neutral"
    assert L(0.11) == "Buy" and L(0.5) == "Buy"
    assert L(0.51) == "Strong buy" and L(1) == "Strong buy"
    assert L(None) is None


def test_ma_rating_all_above_is_plus_one_and_votes_recorded():
    up = bars(list(np.geomspace(10, 400, 300)), high_pad=0.5, low_pad=0.5)
    r, votes = m.ma_rating(up)
    # HMA is a zero-lag filter, so on a smooth ramp it may sit on the price (vote 0); every other average votes +1
    assert r >= 14 / 15 - 1e-9
    assert votes["SMA200"] == 1 and votes["EMA10"] == 1 and votes["VWMA20"] == 1 and votes["ICHIMOKU"] == 1
    down = bars(list(np.geomspace(400, 10, 300)), high_pad=0.5, low_pad=0.5)
    assert m.ma_rating(down)[0] <= -13 / 15 + 1e-9  # HMA9 leads (sits below) a convex decline


def test_ma_rating_short_history_votes_zero_for_unavailable_averages():
    r, votes = m.ma_rating(bars(list(np.linspace(10, 40, 40)), high_pad=0.5, low_pad=0.5))
    assert votes["SMA200"] == 0 and votes["EMA100"] == 0 and votes["SMA10"] == 1
    assert 0 < r < 1


def test_os_rating_votes_follow_published_rules():
    up = bars(list(np.geomspace(10, 400, 300)), high_pad=0.5, low_pad=0.5)
    r, votes = m.os_rating(up)
    # an accelerating uptrend: MACD > signal, Mom rising, AO>0 and rising -> buys; RSI=100 >70 and not falling -> neutral
    assert votes["MACD"] == 1 and votes["MOM"] == 1 and votes["AO"] == 1
    assert votes["RSI"] == 0
    assert set(votes) == {"RSI", "STOCH", "CCI", "ADX", "AO", "MOM", "MACD", "STOCHRSI", "WR", "BBP", "UO"}
    assert -1 <= r <= 1


def test_compute_symbol_metrics_shape_and_1w_uses_only_completed_weeks():
    df = bars(list(np.linspace(100, 200, 400)), start="2024-06-03", high_pad=1, low_pad=1)
    bm = bars(list(np.linspace(1000, 1500, 400)), start="2024-06-03")
    out = m.compute_symbol_metrics(df, bm, "1D")
    for key in ["avg_vol_10", "perf_1w", "perf_1m", "perf_3m", "perf_ytd", "perf_1y", "perf_5y", "perf_all", "first_close_date",
                "beta_1y", "beta_3y", "beta_5y", "vol_1d", "vol_1w", "vol_1m", "rsi14", "mom10", "ao", "cci20",
                "ma_rating", "os_rating", "tech_rating", "votes", "as_of"]:
        assert key in out, key
    assert out["tech_rating"] == pytest.approx((out["ma_rating"] + out["os_rating"]) / 2)
    assert out["perf_5y"] is None
    wk = m.compute_symbol_metrics(df, bm, "1W")
    # last bar is a Friday-complete week or the partial current week is dropped
    assert wk["as_of"] <= out["as_of"]
    assert math.isfinite(wk["rsi14"])


def test_nan_inputs_never_leak_as_nan():
    df = bars(list(np.linspace(100, 200, 100)))
    df.loc[50, "close"] = np.nan
    out = m.compute_symbol_metrics(df, None, "1D")
    for k, v in out.items():
        assert not (isinstance(v, float) and math.isnan(v)), k
