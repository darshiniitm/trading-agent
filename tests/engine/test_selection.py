import numpy as np
import pandas as pd

from engine.selection import SelectionPoint, resolve_ep
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
