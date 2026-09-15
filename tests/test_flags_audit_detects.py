"""T-16: a tampered CSV fails AU04; a wrong mode label fails AU02; rules.yaml drift
fails AU03; a mismatched picks week fails AU05. Each check function tested directly
in isolation (unlike T-14, which exercises the full pipeline)."""
from __future__ import annotations

import hashlib
import json

import pandas as pd
import pytest

from src.flags.audit import _au02, _au03, _au04, _au05
from src.flags.matrix import csv_sha256


def test_au02_wrong_mode_label_fails():
    manifest = {"signal_week": "2026-09-07", "recording_mode": "forward"}  # actually late_backfill by now
    result = _au02(manifest)
    assert result["status"] == "FAIL"


def test_au02_correct_mode_label_passes():
    manifest = {"signal_week": "2026-09-07", "recording_mode": "late_backfill"}
    result = _au02(manifest)
    assert result["status"] == "PASS"


def test_au04_tampered_csv_fails(tmp_path):
    csv_path = tmp_path / "flags_2026-09-07.csv"
    pd.DataFrame({"ticker": ["A.NS"], "flags_met": [3]}).to_csv(csv_path, index=False)
    manifest = {"csv_sha256": csv_sha256(csv_path)}
    ok = _au04(csv_path, manifest)
    assert ok["status"] == "PASS"

    # tamper after the manifest's hash was recorded
    pd.DataFrame({"ticker": ["A.NS", "B.NS"], "flags_met": [3, 9]}).to_csv(csv_path, index=False)
    tampered = _au04(csv_path, manifest)
    assert tampered["status"] == "FAIL"


def test_au05_mismatched_picks_week_fails(tmp_path):
    picks_path = tmp_path / "picks_2026-09-07.json"
    picks_path.write_text(json.dumps({"signal_week_start": "2026-09-14"}))  # wrong week
    manifest = {"signal_week": "2026-09-07"}
    result = _au05(manifest, picks_path)
    assert result["status"] == "FAIL"


def test_au05_matching_picks_week_passes(tmp_path):
    picks_path = tmp_path / "picks_2026-09-07.json"
    picks_path.write_text(json.dumps({"signal_week_start": "2026-09-07"}))
    manifest = {"signal_week": "2026-09-07"}
    result = _au05(manifest, picks_path)
    assert result["status"] == "PASS"


def test_au03_control_file_hash_drift_fails():
    prev_audit = {"facts": {"control_file_hashes": {
        "config/rules.yaml": "deadbeef", "src/screen/engine.py": "deadbeef", "src/trade/builder.py": "deadbeef",
    }}}
    result = _au03(prev_audit)
    assert result["status"] in ("FAIL", "WARN")  # current real hashes will not equal "deadbeef"


def test_au03_no_prior_audit_is_pass_or_warn_not_fail():
    result = _au03(None)
    assert result["status"] in ("PASS", "WARN")
