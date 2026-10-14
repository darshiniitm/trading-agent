import numpy as np
import pandas as pd

from engine.env import Environment
from engine.schemas import Condition, ScreenSpec, Stop, T1Window
from engine.screen import run_screen_spec
from tests.offline import make_daily_panel

# Deviation from the brief's literal test data (documented per the brief's own instruction
# to root-cause and fix the TEST ONLY, never src/indicators/*, mirroring how Task 6/8 handled
# the RSI(14)-saturates-at-100 synthetic-data collision):
#
# The brief's closes = [100.0] * 30 + [...rise...] never produces a VStop flip_up anywhere,
# for any as_of/window choice. Root cause: src/indicators/vstop.py:compute_vstop seeds
# `prev_uptrend = True` (line 43, "arbitrary seed; first `length` bars are warmup and
# unreliable anyway"). With 30 *flat* bars at 100, the ATR-based stop line (~96) never
# exceeds price, so `uptrend` stays True from bar 0 straight through the later rise --
# `flip_up` (a False->True transition) can never fire because the series is never in a
# downtrend to begin with. This is a property of the indicator's documented seed behavior
# on degenerate (flat) input, not a bug in it or in the window logic under test.
# Fix: prepend a genuine declining warmup (130 -> 100 over 25 sessions, then 5 flat) so the
# ticker is verifiably in a downtrend (uptrend=False) going into the window, same as real
# data would be after a prior down-move. The window-specific closes from the brief (the
# rise/drop shapes that each test is actually about) are kept as-is, just appended after
# this corrected warmup instead of after 30 flat bars.
def _warmup_downtrend() -> list[float]:
    decline = list(np.linspace(130.0, 100.0, 25))
    flat = [100.0] * 5
    return decline + flat  # 30 bars total, ends with uptrend=False at index 29


def _t1_spec(offsets=(0, 1, 2, 3, 4)):
    return ScreenSpec(
        spec_version=4, structure="t1_literal", timeframe="1W", selection_point=None,
        conditions=[
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long"),
            Condition(id="C4", role="filter", kind="indicator", name="rsi",
                      params={"length": 14}, op="between", value=[0, 100]),  # wide band: isolates the event logic
        ],
        stop=Stop(**{"from": "C3"}), risk_cap_pct=None, near_miss=None,
        t1_window=T1Window(length_sessions=5, offsets=list(offsets)),
    )


def _env_with_one_ticker(closes: list[float]) -> Environment:
    panel = make_daily_panel(closes, start="2024-01-01")
    universe_df = pd.DataFrame([{"ticker": "AAA.NS", "name": "AAA", "sector": "Tech"}])
    rule_spec = {
        "data": {"history_weeks": 260},
        "sector": {"benchmark_ticker": "", "rs_lookbacks_weeks": [4], "outperforming": {"rs_gt": 0, "top_k": 5}},
    }
    return Environment(rule_spec=rule_spec, adapter=None, universe_df=universe_df,
                        panels={}, shares={"AAA.NS": 1_000_000}, daily_panels={"AAA.NS": panel})


def test_t1_literal_catches_a_midweek_flip_control_would_miss():
    # Declining-then-flat warmup (VStop downtrend established), then a sharp rise
    # starting mid-window that flips VStop to an uptrend on day 4 of 5 (see the
    # module-level deviation note on _warmup_downtrend for why plain-flat warmup
    # from the brief never produces a flip at all).
    closes = _warmup_downtrend() + [100, 101, 103, 106, 110]
    env = _env_with_one_ticker(closes)
    as_of = env.daily_panels["AAA.NS"]["date"].iloc[30]  # the window's own Monday

    result = run_screen_spec(_t1_spec(), as_of, env)
    tickers = {c["ticker"] for c in result["candidates"] if c["membership"] == "full_match"}
    assert "AAA.NS" in tickers


def test_t1_literal_honors_a_non_default_window_length():
    # Backend plan §10 'Open parameters': a 3-session window, not the worked example's
    # 5-session one -- guards against length_sessions being ignored.
    # (Same declining warmup as above, for the same reason; the rise/drop shape -- flip
    # within the first 3 sessions, hard drop in sessions 4-5 -- is the brief's own.)
    closes = _warmup_downtrend() + [100, 101, 110]  # the rise only exists in the first 3 sessions
    env = _env_with_one_ticker(closes + [90, 80])  # sessions 4-5 drop hard
    as_of = env.daily_panels["AAA.NS"]["date"].iloc[30]

    spec_3 = _t1_spec(offsets=(0, 1, 2))
    spec_3 = spec_3.model_copy(update={"t1_window": spec_3.t1_window.model_copy(update={"length_sessions": 3})})
    result = run_screen_spec(spec_3, as_of, env)
    tickers = {c["ticker"] for c in result["candidates"] if c["membership"] == "full_match"}
    assert "AAA.NS" in tickers  # within the first 3 sessions, uptrend holds


def test_t1_literal_excludes_a_flip_that_reversed_by_window_end():
    # Flips up mid-window, then drops hard before the window's last day -- VStop flips
    # back down, so uptrend is False on the final session and the ticker must NOT
    # qualify (mirrors scan_t1_week's "extra_reversed" case).
    # (Same declining warmup as above, for the same reason.)
    closes = _warmup_downtrend() + [100, 101, 103, 106, 90]
    env = _env_with_one_ticker(closes)
    as_of = env.daily_panels["AAA.NS"]["date"].iloc[30]

    result = run_screen_spec(_t1_spec(), as_of, env)
    tickers = {c["ticker"] for c in result["candidates"] if c["membership"] == "full_match"}
    assert "AAA.NS" not in tickers
