"""
Template-rendered findings draft + idempotent append (docs/feature-flag-matrix-plan.md
§11.3.1). No free text — everything comes from string.Template substitution
over the audit JSON, so two runs on the same inputs produce byte-identical
output (T-14/T-15).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "results" / "feature_flags"
AUDIT_DIR = OUT / "audit"
TEMPLATE_PATH = Path(__file__).resolve().parent / "templates" / "findings_entry.md.tmpl"
FINDINGS_LOG = ROOT / "docs" / "forward_test_findings.md"


def _render(audit: dict, draft_sha: str) -> str:
    facts = audit.get("facts", {})
    lg = facts.get("last_graded", {})
    last_graded_line = (
        f"Last graded week: {lg.get('signal_week')} — control {lg.get('control_net_pct')}%, "
        f"T4 {lg.get('t4_net_pct')}%, benchmark {lg.get('benchmark_pct')}%"
        if lg.get("signal_week") else "No graded week yet."
    )
    tmpl = Template(Path(TEMPLATE_PATH).read_text())
    return tmpl.safe_substitute(
        as_of=audit["as_of"], recording_mode=audit["recording_mode"], overall=audit["overall"],
        eligible_count=facts.get("eligible_count"), t4_picks=", ".join(facts.get("t4_picks", [])) or "none",
        control_trades=", ".join(facts.get("control_trades", [])) or "none",
        reasons=", ".join(audit.get("noteworthy", {}).get("reasons", [])) or "none",
        last_graded_line=last_graded_line, draft_sha=draft_sha,
    )


def draft_findings(as_of_str: str) -> tuple[str, int]:
    audit_path = AUDIT_DIR / f"audit_{as_of_str}.json"
    if not audit_path.exists():
        return f"no audit for {as_of_str} — run `track_flags audit --as-of {as_of_str} --json` first.", 20
    audit = json.loads(audit_path.read_text())
    unhashed = _render(audit, draft_sha="")
    draft_sha = hashlib.sha256(unhashed.encode("utf-8")).hexdigest()[:16]
    final = _render(audit, draft_sha)

    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    (AUDIT_DIR / f"findings_{as_of_str}.md").write_text(final)
    return final, 0


def append_findings(as_of_str: str) -> int:
    """Exit 0 appended / 3 not noteworthy / 4 already appended / 20 error."""
    audit_path = AUDIT_DIR / f"audit_{as_of_str}.json"
    draft_path = AUDIT_DIR / f"findings_{as_of_str}.md"
    if not audit_path.exists() or not draft_path.exists():
        return 20
    audit = json.loads(audit_path.read_text())
    if not audit.get("noteworthy", {}).get("any"):
        return 3

    draft = draft_path.read_text()
    marker_line = draft.splitlines()[0]  # "<!-- flags-audit:<wk>:<sha> -->"
    existing = FINDINGS_LOG.read_text() if FINDINGS_LOG.exists() else ""
    if marker_line in existing:
        return 4

    with open(FINDINGS_LOG, "a") as f:
        f.write("\n---\n\n" + draft)
    return 0
