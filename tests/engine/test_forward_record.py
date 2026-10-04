import json

import pandas as pd
import pytest

from engine.forward_record import write_record
from engine.schemas import ScreenSpec


def _spec():
    return ScreenSpec(spec_version=4, structure="literal", timeframe="1W", selection_point=None,
                       conditions=[], stop=None, risk_cap_pct=None, near_miss=None)


def test_writes_a_record_with_entered_picks_only(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.forward_record.OUT_DIR", tmp_path)
    entered = [{"ticker": "AAA.NS", "entry_price": 105.0, "sl": 95.0}]
    path = write_record(prompt_id=12, as_of=pd.Timestamp("2026-01-05"), entered=entered, spec=_spec())
    assert path is not None and path.exists()
    body = json.loads(path.read_text())
    assert body["prompt_id"] == 12
    assert body["picks"] == entered


def test_refuses_to_overwrite_an_existing_record(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.forward_record.OUT_DIR", tmp_path)
    entered_first = [{"ticker": "AAA.NS", "entry_price": 105.0, "sl": 95.0}]
    entered_second = [{"ticker": "BBB.NS", "entry_price": 200.0, "sl": 180.0}]  # Different data

    first = write_record(prompt_id=12, as_of=pd.Timestamp("2026-01-05"), entered=entered_first, spec=_spec())
    second = write_record(prompt_id=12, as_of=pd.Timestamp("2026-01-05"), entered=entered_second, spec=_spec())

    assert first is not None
    assert second is None
    # Prove byte-for-byte immutability: file contains first call's data, not second
    body = json.loads(first.read_text())
    assert body["picks"] == entered_first
    assert body["picks"] != entered_second


def test_rejects_a_row_without_entry_price(tmp_path, monkeypatch):
    monkeypatch.setattr("engine.forward_record.OUT_DIR", tmp_path)
    with pytest.raises(ValueError):
        write_record(prompt_id=12, as_of=pd.Timestamp("2026-01-05"),
                     entered=[{"ticker": "AAA.NS"}], spec=_spec())
