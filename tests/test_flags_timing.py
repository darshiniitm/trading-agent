"""T-07: frozen-clock timing / mode resolution / IST-UTC conversion."""
from __future__ import annotations

from datetime import datetime

import pandas as pd

from src.flags.timing import IST, monday_open_deadline, resolve_mode, week_has_closed

AS_OF = pd.Timestamp("2026-09-07")  # signal week Mon 7 - Fri 11 Sep; holding week opens Mon 14 Sep


def test_deadline_is_holding_monday_0915_ist():
    d = monday_open_deadline(AS_OF)
    assert d == datetime(2026, 9, 14, 9, 15, tzinfo=IST)


def test_saturday_after_signal_week_is_forward():
    clock = datetime(2026, 9, 19, 10, 0, tzinfo=IST)  # before the 21 Sep deadline for as_of=14 Sep... use as_of=14
    as_of = pd.Timestamp("2026-09-14")
    assert resolve_mode(as_of, clock) == "forward"


def test_monday_after_deadline_is_late_backfill():
    as_of = pd.Timestamp("2026-09-14")
    clock = datetime(2026, 9, 21, 9, 16, tzinfo=IST)
    assert resolve_mode(as_of, clock) == "late_backfill"


def test_monday_before_deadline_is_forward():
    as_of = pd.Timestamp("2026-09-14")
    clock = datetime(2026, 9, 21, 9, 14, tzinfo=IST)
    assert resolve_mode(as_of, clock) == "forward"


def test_utc_input_converts_correctly():
    # 2026-09-21 03:46 UTC == 2026-09-21 09:16 IST (UTC+5:30) -> late
    from datetime import timezone
    clock_utc = datetime(2026, 9, 21, 3, 46, tzinfo=timezone.utc)
    as_of = pd.Timestamp("2026-09-14")
    assert resolve_mode(as_of, clock_utc.astimezone(IST)) == "late_backfill"


def test_week_has_closed_before_friday_1530_ist_is_false():
    as_of = AS_OF  # Monday-dated bar; that week's Friday is 2026-09-11
    before_close = datetime(2026, 9, 11, 15, 0, tzinfo=IST)
    after_close = datetime(2026, 9, 11, 15, 31, tzinfo=IST)
    assert week_has_closed(as_of, before_close) is False
    assert week_has_closed(as_of, after_close) is True
