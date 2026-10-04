import numpy as np
import pandas as pd

from engine.schemas import SelectionPoint
from engine.selection import resolve_ep
from tests.offline import make_panel


def test_session_1_open_uses_next_weekly_bar_open():
    panel = make_panel([100.0] * 10, opens=[100.0] * 9 + [105.0])
    as_of = panel["date"].iloc[-2]  # the signal week, one row before the selection week
    ep, status = resolve_ep("AAA.NS", {"AAA.NS": panel}, None, as_of, SelectionPoint(session_of_week=1, at="open"))
    assert status == "ok"
    assert ep == 105.0


def test_no_next_week_bar_is_no_point_data():
    panel = make_panel([100.0] * 10)
    as_of = panel["date"].iloc[-1]  # the LATEST bar -- next week hasn't happened
    ep, status = resolve_ep("AAA.NS", {"AAA.NS": panel}, None, as_of, SelectionPoint(session_of_week=1, at="open"))
    assert status == "no_point_data"
    assert ep is None


def test_non_monday_session_without_daily_data_is_no_point_data():
    panel = make_panel([100.0] * 10)
    as_of = panel["date"].iloc[-3]
    ep, status = resolve_ep("AAA.NS", {"AAA.NS": panel}, None, as_of, SelectionPoint(session_of_week=3, at="close"))
    assert status == "no_point_data"
    assert ep is None


from engine.env import Environment
from engine.schemas import Condition, ScreenSpec, Stop
from engine.screen import run_screen_spec
from engine.selection import select_candidates


def _spec_without_selection_point():
    return ScreenSpec(
        spec_version=4, structure="literal", timeframe="1W", selection_point=None,
        conditions=[
            Condition(id="C3", role="event", kind="indicator", name="vstop",
                      params={"length": 10, "mult": 2.0, "source": "close"}, op="flip", dir="long"),
        ],
        stop=Stop(**{"from": "C3"}), risk_cap_pct=None, near_miss=None,
    )


# Deviation from the brief's literal test data (same class of issue as Task 6/8/9, documented
# the same way): the brief's panel (closes = [100 + i for i in range(40)], a pure monotonic
# rise from bar 0) never produces a VStop flip_up. Root cause: src/indicators/vstop.py
# seeds prev_uptrend=True (line 43) and, with no prior downtrend, the trailing stop never
# gets a chance to sit above price -- uptrend is True from the first post-warmup bar onward,
# so flip_up (a False->True transition) can never fire, and the ticker never reaches
# full_match at all (it is dropped entirely, not merely non-full_match), which would make
# this test's "entered == [] and AAA.NS in no_point_data" assertion vacuous.
# Fix (mirrors tests/engine/test_screen_t1_literal.py's _warmup_downtrend): a genuine
# declining warmup (130 -> 100 over 25 bars) establishes uptrend=False, 10 flat bars hold
# it there past the length=10 warmup window, then a single sharp jump on the LAST bar
# flips uptrend True exactly at that bar -- confirmed against the real, unmodified
# compute_vstop() (flip_up True only at the final index) before using it here.
def _decline_then_flip_on_last_bar() -> list[float]:
    decline = list(np.linspace(130.0, 100.0, 25))
    flat = [100.0] * 10
    jump = [140.0]
    return decline + flat + jump  # 36 bars total; flip_up fires only on the final bar


def test_full_match_without_selection_point_is_no_point_data_not_entered():
    panel = make_panel(_decline_then_flip_on_last_bar())
    universe_df = pd.DataFrame([{"ticker": "AAA.NS", "name": "AAA", "sector": "Tech"}])
    env = Environment(
        rule_spec={"data": {"history_weeks": 260},
                   "sector": {"benchmark_ticker": "", "rs_lookbacks_weeks": [4], "outperforming": {"rs_gt": 0, "top_k": 5}}},
        adapter=None, universe_df=universe_df, panels={"AAA.NS": panel}, shares={"AAA.NS": 1_000_000}, daily_panels={},
    )
    spec = _spec_without_selection_point()
    as_of = panel["date"].iloc[-1]
    screen_result = run_screen_spec(spec, as_of, env)
    assert any(c["ticker"] == "AAA.NS" and c["membership"] == "full_match" for c in screen_result["candidates"])

    result = select_candidates(spec, as_of, env, screen_result)

    assert result["entered"] == []
    assert any(c["ticker"] == "AAA.NS" for c in result["no_point_data"])
