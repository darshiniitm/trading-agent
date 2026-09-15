"""T-09: a second record for the same week refuses to overwrite (HARNESS §4, same
rule as picks_*.json)."""
from __future__ import annotations

import json

import tests.track_flags as tf


def test_second_record_refuses_to_overwrite(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(tf, "OUT", tmp_path)

    df1, manifest1 = tf.record("2026-09-07")
    csv_path = tmp_path / "flags_2026-09-07.csv"
    manifest_path = tmp_path / "flags_2026-09-07.manifest.json"
    assert csv_path.exists()
    original_bytes = csv_path.read_bytes()
    original_manifest = manifest_path.read_text()

    result = tf.record("2026-09-07")
    assert result is None
    out = capsys.readouterr().out
    assert "REFUSING" in out

    assert csv_path.read_bytes() == original_bytes, "record CSV bytes changed after a refused re-record"
    assert manifest_path.read_text() == original_manifest


def test_manifest_csv_sha_matches_actual_file(tmp_path, monkeypatch):
    monkeypatch.setattr(tf, "OUT", tmp_path)
    tf.record("2026-09-07")
    from src.flags.matrix import csv_sha256
    manifest = json.loads((tmp_path / "flags_2026-09-07.manifest.json").read_text())
    csv_path = tmp_path / "flags_2026-09-07.csv"
    assert manifest["csv_sha256"] == csv_sha256(csv_path)
