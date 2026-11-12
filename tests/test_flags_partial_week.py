"""T-08: a Wed-of-week clock with a Monday-dated "current" bar must refuse to record
(G4 — no partial weekly bars)."""
from __future__ import annotations

from datetime import datetime

import pandas as pd

from src.flags.timing import IST, week_has_closed


def test_wednesday_mid_week_bar_is_not_closed():
    # Monday-dated weekly bar for the week currently in progress -- Wednesday of
    # that same week has not seen Friday's close yet.
    as_of = pd.Timestamp("2026-09-14")  # Monday-dated bar for week of 14-18 Sep
    wednesday_clock = datetime(2026, 9, 16, 12, 0, tzinfo=IST)
    assert week_has_closed(as_of, wednesday_clock) is False


def test_friday_after_close_is_closed():
    as_of = pd.Timestamp("2026-09-14")
    friday_clock = datetime(2026, 9, 18, 15, 31, tzinfo=IST)
    assert week_has_closed(as_of, friday_clock) is True


def test_record_refuses_on_partial_week(monkeypatch, tmp_path):
    import tests.track_flags as tf

    monkeypatch.setattr(tf, "OUT", tmp_path)
    monkeypatch.setattr(tf, "week_has_closed", lambda as_of: False)
    result = tf.record("2026-09-14")
    assert result is None
    assert not list(tmp_path.glob("flags_*.csv"))
