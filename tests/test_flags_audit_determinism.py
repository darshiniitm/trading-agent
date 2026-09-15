"""T-14: two audit runs on the same fixture give byte-identical JSON (modulo the
run's own created_utc timestamp); noteworthy reasons are always in the closed set."""
from __future__ import annotations

from src.flags.audit import NOTEWORTHY_REASONS, run_audit


def _strip_volatile(result: dict) -> dict:
    d = dict(result)
    d.pop("created_utc", None)
    return d


def test_two_audit_runs_are_identical_except_timestamp():
    r1, code1 = run_audit("2026-09-07")
    r2, code2 = run_audit("2026-09-07")
    assert code1 == code2
    assert _strip_volatile(r1) == _strip_volatile(r2)


def test_noteworthy_reasons_are_in_closed_set():
    result, code = run_audit("2026-09-07")
    for reason in result["noteworthy"]["reasons"]:
        assert reason in NOTEWORTHY_REASONS


def test_missing_record_is_a_tool_error():
    result, code = run_audit("1999-01-01")
    assert code == 20
    assert "error" in result
