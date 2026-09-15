"""T-15: findings-draft matches a golden file; findings-append exits 0 then 4;
exactly one entry is appended; a not-noteworthy fixture exits 3 and writes nothing."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import src.flags.findings as findings_mod

GOLDEN = Path(__file__).resolve().parent / "fixtures" / "flags_findings_golden.md"

NOTEWORTHY_AUDIT = {
    "as_of": "2026-09-07", "recording_mode": "late_backfill", "overall": "PASS",
    "facts": {"eligible_count": 264, "t4_picks": [], "control_trades": ["JUBLPHARMA.NS", "SPLPETRO.NS"],
              "last_graded": {}},
    "noteworthy": {"any": True, "reasons": ["recording_mode_late_backfill"]},
}
NOT_NOTEWORTHY_AUDIT = {
    "as_of": "2026-09-14", "recording_mode": "forward", "overall": "PASS",
    "facts": {"eligible_count": 100, "t4_picks": [], "control_trades": [], "last_graded": {}},
    "noteworthy": {"any": False, "reasons": []},
}


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    audit_dir = tmp_path / "audit"
    audit_dir.mkdir()
    findings_log = tmp_path / "forward_test_findings.md"
    monkeypatch.setattr(findings_mod, "AUDIT_DIR", audit_dir)
    monkeypatch.setattr(findings_mod, "FINDINGS_LOG", findings_log)
    return audit_dir, findings_log


def test_draft_matches_golden_file(isolated):
    audit_dir, _ = isolated
    (audit_dir / "audit_2026-09-07.json").write_text(json.dumps(NOTEWORTHY_AUDIT))
    text, code = findings_mod.draft_findings("2026-09-07")
    assert code == 0
    assert text == GOLDEN.read_text()


def test_append_then_duplicate_then_already_appended(isolated):
    audit_dir, findings_log = isolated
    (audit_dir / "audit_2026-09-07.json").write_text(json.dumps(NOTEWORTHY_AUDIT))
    findings_mod.draft_findings("2026-09-07")

    code1 = findings_mod.append_findings("2026-09-07")
    assert code1 == 0
    content_after_first = findings_log.read_text()
    assert content_after_first.count("<!-- flags-audit:2026-09-07:") == 1

    code2 = findings_mod.append_findings("2026-09-07")
    assert code2 == 4
    assert findings_log.read_text() == content_after_first, "a second append must not add a duplicate entry"


def test_not_noteworthy_exits_3_and_writes_nothing(isolated):
    audit_dir, findings_log = isolated
    (audit_dir / "audit_2026-09-14.json").write_text(json.dumps(NOT_NOTEWORTHY_AUDIT))
    findings_mod.draft_findings("2026-09-14")

    code = findings_mod.append_findings("2026-09-14")
    assert code == 3
    assert not findings_log.exists()


def test_missing_audit_is_error():
    code = findings_mod.append_findings("1999-01-01")
    assert code == 20
