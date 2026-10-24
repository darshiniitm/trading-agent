"""The TradingView-exact maths in src/indicators/tv.py against the independent oracle in tests/golden/ref_indicators.py
(the oracle never imports app code; this is the only place the two meet)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "golden"))
import ref_indicators as ref  # noqa: E402
from src.indicators import tv  # noqa: E402


def series(n=400, seed=7):
    r = np.random.default_rng(seed)
    c = 100 + np.cumsum(r.normal(0, 1.2, n))
    h = c + r.uniform(0.2, 2.0, n)
    l = c - r.uniform(0.2, 2.0, n)
    return h, l, c


def same(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    assert np.array_equal(np.isnan(a), np.isnan(b)), "NaN warm-up differs"
    ok = ~np.isnan(a)
    assert np.allclose(a[ok], b[ok], rtol=1e-9, atol=1e-9)


def test_ema_and_atr_match_the_oracle():
    h, l, c = series()
    for n in (9, 20, 50, 200):
        same(tv.ema(c, n), ref.ema(c, n))
    same(tv.atr(h, l, c, 14), ref.atr(h, l, c, 14))


def test_macd_matches_the_oracle():
    _, _, c = series()
    m = ref.ema(c, 12) - ref.ema(c, 26)
    line, sig, _ = tv.macd(c, 12, 26, 9)
    same(line, m)
    same(sig, ref.ema_skipna(m, 9))


def test_adx_and_supertrend_match_the_oracle():
    h, l, c = series()
    adx, pdi, mdi = tv.dmi(h, l, c, 14)
    radx, rp, rm = ref.adx(h, l, c, 14)
    same(adx, radx); same(pdi, rp); same(mdi, rm)
    line, up = tv.supertrend(h, l, c, 3.0, 10)
    rline, rdir = ref.supertrend(h, l, c, 3.0, 10)
    same(line, rline)
    ok = ~np.isnan(rdir)
    assert np.array_equal(up[ok], (rdir[ok] == -1))
