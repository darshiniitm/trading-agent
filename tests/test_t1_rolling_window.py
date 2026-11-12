"""
T1 redefined (27 Sep 2026, tests/track_literal.py module docstring): the rolling
ledger + rolling_stats() that replace the old mid-week scan as "T1" -- each Friday's
grade() appends one row (item 3), and replay() builds the identical row shape and
calls the identical rolling_stats() over historical weeks (item 4), so live and replay
are provably the same code path. Pure-function tests, no network/offline env needed.
"""
from __future__ import annotations

import pandas as pd

from tests.track_literal import _append_rolling_ledger, _ledger_row, rolling_stats


def test_ledger_row_computes_alpha_when_both_present():
    row = _ledger_row("2026-10-02", 3, 1.5, 1.2, 2, 0.5, source="live")
    assert row["alpha_close_to_close_pct"] == 1.0
    assert row["source"] == "live"


def test_ledger_row_alpha_is_none_when_benchmark_missing():
    row = _ledger_row("2026-10-02", 0, None, None, 0, None, source="live")
    assert row["alpha_close_to_close_pct"] is None


def test_append_rolling_ledger_is_idempotent_per_week(tmp_path):
    path = tmp_path / "rolling_ledger.csv"
    row1 = _ledger_row("2026-10-02", 2, 1.0, 0.8, 1, 0.2, source="live")
    df = _append_rolling_ledger(row1, ledger_path=path)
    assert len(df) == 1

    # Same week again, different numbers -- must NOT overwrite (append-only, HARNESS rule 4).
    row1_again = _ledger_row("2026-10-02", 2, 99.0, 99.0, 2, 0.2, source="live")
    df2 = _append_rolling_ledger(row1_again, ledger_path=path)
    assert len(df2) == 1
    assert df2.iloc[0]["basket_close_to_close_pct"] == 1.0

    row2 = _ledger_row("2026-10-09", 1, 2.0, 1.9, 1, -0.1, source="live")
    df3 = _append_rolling_ledger(row2, ledger_path=path)
    assert len(df3) == 2
    assert list(df3["signal_week"]) == ["2026-10-02", "2026-10-09"]


def test_rolling_stats_reports_true_n_weeks_below_window_size():
    ledger = pd.DataFrame([
        _ledger_row("2026-09-04", 2, 1.0, 0.9, 1, 0.1, source="live"),
        _ledger_row("2026-09-11", 2, -1.0, -1.1, 0, 0.2, source="live"),
    ])
    stats = rolling_stats(ledger, "2026-09-11", windows=(4, 13, 26))
    # Only 2 graded weeks exist -- every window reports n_weeks=2, not padded to 4/13/26.
    assert stats[4]["n_weeks"] == 2
    assert stats[13]["n_weeks"] == 2
    assert stats[26]["n_weeks"] == 2
    assert stats[4]["mean_close_to_close_pct"] == 0.0
    # mean of per-week win rates: week1 1/2=50%, week2 0/2=0% -> 25%, not a pooled count.
    assert stats[4]["win_rate_pct"] == 25.0


def test_rolling_stats_only_uses_weeks_up_to_as_of():
    ledger = pd.DataFrame([
        _ledger_row("2026-09-04", 1, 1.0, 1.0, 1, 0.0, source="live"),
        _ledger_row("2026-09-11", 1, 3.0, 3.0, 1, 0.0, source="live"),
        _ledger_row("2026-09-18", 1, 5.0, 5.0, 1, 0.0, source="live"),
    ])
    stats = rolling_stats(ledger, "2026-09-11", windows=(4,))
    assert stats[4]["n_weeks"] == 2
    assert stats[4]["mean_close_to_close_pct"] == 2.0  # (1.0 + 3.0) / 2, not the 09-18 week


def test_rolling_stats_empty_ledger_returns_none_per_window():
    stats = rolling_stats(pd.DataFrame(), "2026-09-11", windows=(4, 13))
    assert stats == {4: None, 13: None}
