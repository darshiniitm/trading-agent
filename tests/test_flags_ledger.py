"""T-13: ledger append + duplicate-key raise."""
from __future__ import annotations

import pandas as pd
import pytest

from src.flags.grade import append_ledger

KEY = ("registry_version", "recording_mode", "signal_week", "ticker")


def test_append_creates_and_extends(tmp_path):
    path = tmp_path / "ledger.csv"
    append_ledger(path, [{"registry_version": 1, "recording_mode": "forward",
                           "signal_week": "2026-09-07", "ticker": "A.NS", "flags_met": 3}], KEY)
    assert path.exists()
    df = pd.read_csv(path)
    assert len(df) == 1

    append_ledger(path, [{"registry_version": 1, "recording_mode": "forward",
                           "signal_week": "2026-09-14", "ticker": "A.NS", "flags_met": 4}], KEY)
    df = pd.read_csv(path)
    assert len(df) == 2


def test_duplicate_key_raises(tmp_path):
    path = tmp_path / "ledger.csv"
    row = {"registry_version": 1, "recording_mode": "forward",
           "signal_week": "2026-09-07", "ticker": "A.NS", "flags_met": 3}
    append_ledger(path, [row], KEY)
    with pytest.raises(ValueError):
        append_ledger(path, [row], KEY)
    df = pd.read_csv(path)
    assert len(df) == 1, "a rejected duplicate write must not have partially applied"
