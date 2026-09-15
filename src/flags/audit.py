"""
Deterministic audit tools (docs/feature-flag-matrix-plan.md §11.3.1). Every
check here is fixed Python producing a fixed JSON schema — the
flag-run-auditor agent only calls these and relays their output verbatim
(G13: the LLM never computes or edits a number).
"""
from __future__ import annotations

import glob
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from src.data.adapter import KNOWN_CAVEATS
from src.flags import registry as registry_mod
from src.flags.checks import run_all as run_invariants
from src.flags.matrix import csv_sha256
from src.flags.registry import countable_ids, load_registry
from src.flags.timing import monday_open_deadline, resolve_mode
from tests.offline import env

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "results" / "feature_flags"
AUDIT_DIR = OUT / "audit"

CONTROL_FILES = ["config/rules.yaml", "src/screen/engine.py", "src/trade/builder.py"]
AUDIT_SCHEMA_VERSION = 1
NOTEWORTHY_REASONS = {
    "check_failed", "check_warn", "recording_mode_late_backfill", "first_record_for_registry_version",
    "forward_weeks_reached_13", "forward_weeks_reached_26", "flag_bh_significance_changed",
    "t4_k_locked_this_run", "t4_zero_picks_4_consecutive_weeks", "eligible_count_changed_gt_10pct",
}


def _file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _git(*args) -> tuple[int, str]:
    try:
        p = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=30)
        return p.returncode, (p.stdout + p.stderr).strip()
    except Exception as e:  # pragma: no cover - environment without git
        return 1, str(e)


def _check(id_, status, expected, actual):
    return {"id": id_, "status": status, "expected": expected, "actual": actual}


def _au01(df, manifest, funnel, ids, control_survivors, control_trades, checksum, panels, as_of):
    invariant_checks = run_invariants(df, manifest, funnel, ids, [f["id"] for f in load_registry()["flags"]],
                                       control_survivors, control_trades, checksum, panels, as_of)
    overall = "FAIL" if any(c["status"] == "FAIL" for c in invariant_checks) else "PASS"
    return _check("AU01", overall, "all I1-I10 PASS/WARN", json.dumps(invariant_checks, default=str)[:500])


def _au02(manifest):
    recomputed = resolve_mode(pd.Timestamp(manifest["signal_week"]))
    ok = recomputed == manifest["recording_mode"]
    return _check("AU02", "PASS" if ok else "FAIL", recomputed, manifest["recording_mode"])


def _au03(prev_audit: dict | None):
    current_hashes = {f: _file_sha256(ROOT / f) for f in CONTROL_FILES}
    rc, out = _git("diff", "--quiet", "HEAD", "--", "config/rules.yaml", "src/trade/builder.py")
    git_clean = rc == 0
    if prev_audit is None:
        status = "PASS" if git_clean else "WARN"
        return _check("AU03", status, "no working-tree diff on Control files",
                       f"git_clean={git_clean}; no previous audit to compare hashes against")
    prev_hashes = prev_audit.get("facts", {}).get("control_file_hashes", {})
    changed = [f for f in CONTROL_FILES if prev_hashes.get(f) != current_hashes.get(f)]
    if not changed and git_clean:
        return _check("AU03", "PASS", "unchanged", "unchanged")
    engine_only = changed == ["src/screen/engine.py"]
    status = "WARN" if engine_only else ("FAIL" if changed or not git_clean else "PASS")
    return _check("AU03", status, "no Control-file hash/diff changes",
                   f"changed={changed} git_clean={git_clean}")


def _au04(csv_path: Path, manifest):
    actual = csv_sha256(csv_path) if csv_path.exists() else None
    ok = actual == manifest.get("csv_sha256")
    rc, out = _git("status", "--porcelain", "--", "results/forward_test", "results/feature_flags")
    bad_lines = [ln for ln in out.splitlines() if ln[:2].strip() in ("M", "D")
                 and ("picks_" in ln or "flags_" in ln)]
    ok2 = not bad_lines
    status = "PASS" if ok and ok2 else "FAIL"
    return _check("AU04", status, f"csv_sha256 matches; no M/D on picks_*/flags_*",
                   f"sha_match={ok} bad_git_lines={bad_lines}")


def _au05(manifest, picks_path: Path):
    if not picks_path.exists():
        return _check("AU05", "WARN", "picks file exists", f"missing: {picks_path}")
    picks = json.loads(picks_path.read_text())
    ok = picks.get("signal_week_start") == manifest["signal_week"]
    return _check("AU05", "PASS" if ok else "FAIL",
                   manifest["signal_week"], picks.get("signal_week_start"))


def _au06(manifest, status_md: Path):
    ok_manifest = manifest.get("caveats") == KNOWN_CAVEATS
    ok_status = True
    if status_md.exists():
        text = status_md.read_text()
        ok_status = any(c in text for c in KNOWN_CAVEATS) or not KNOWN_CAVEATS
    status = "PASS" if ok_manifest and ok_status else "FAIL"
    return _check("AU06", status, "caveats present in manifest and status md",
                   f"manifest_ok={ok_manifest} status_md_ok={ok_status}")


def _au07(df, status_md: Path):
    has_t4 = bool((df["t4_selected"] == 1).any()) if "t4_selected" in df.columns and df["t4_selected"].notna().any() else False
    if not has_t4:
        return _check("AU07", "PASS", "n/a (no T4 picks this week)", "no T4 picks")
    text = status_md.read_text() if status_md.exists() else ""
    ok = "SHADOW — not for trading" in text
    return _check("AU07", "PASS" if ok else "FAIL", "'SHADOW — not for trading' present", ok)


def _au08(as_of: pd.Timestamp, df):
    ledger_path = OUT / "flag_ledger_records.csv"
    if not ledger_path.exists():
        return _check("AU08", "WARN", "ledger exists", "no ledger file yet")
    ledger = pd.read_csv(ledger_path)
    key = ["registry_version", "recording_mode", "signal_week", "ticker"]
    dup = ledger.duplicated(subset=key).sum()
    week_rows = ledger[ledger["signal_week"] == str(as_of.date())]
    ok = dup == 0 and len(week_rows) == len(df)
    return _check("AU08", "PASS" if ok else "FAIL",
                   f"no dup keys; week rows == {len(df)}", f"dup={dup} week_rows={len(week_rows)}")


def _au09(as_of: pd.Timestamp):
    graded_path = OUT / f"flags_{as_of.date()}_graded.csv"
    if not graded_path.exists():
        return _check("AU09", "PASS", "n/a (not graded yet)", "not graded yet")
    g = pd.read_csv(graded_path)
    bad = g[(g["exit_reason"] == "gap_stop_at_open") & (g["exit_price"] != g["EP_actual"])]
    ok = bad.empty
    return _check("AU09", "PASS" if ok else "FAIL", "gap-stop rows have exit_price==EP_actual",
                   f"bad_rows={list(bad.get('ticker', []))}")


def _au10(as_of: pd.Timestamp):
    log_path = OUT / "run_log.jsonl"
    if not log_path.exists():
        return _check("AU10", "WARN", "run_log.jsonl exists", "no run log yet")
    lines = [json.loads(l) for l in log_path.read_text().splitlines() if l.strip()]
    week_lines = [l for l in lines if l.get("as_of") == str(as_of.date())]
    if not week_lines:
        return _check("AU10", "WARN", "a run_log entry for this week", "none found")
    last = week_lines[-1]
    ok = all(s.get("status") in ("done", "skipped_already_done") for s in last.get("stages", []))
    return _check("AU10", "PASS" if ok else "FAIL", "all stages done/skipped_already_done",
                   [s.get("status") for s in last.get("stages", [])])


def _prior_audit(as_of: pd.Timestamp) -> dict | None:
    prior = sorted(p for p in glob.glob(str(AUDIT_DIR / "audit_*.json"))
                    if Path(p).stem.replace("audit_", "") < str(as_of.date()))
    if not prior:
        return None
    return json.loads(Path(prior[-1]).read_text())


def run_audit(as_of_str: str) -> tuple[dict, int]:
    as_of = pd.Timestamp(as_of_str)
    csv_path = OUT / f"flags_{as_of.date()}.csv"
    manifest_path = OUT / f"flags_{as_of.date()}.manifest.json"
    if not csv_path.exists() or not manifest_path.exists():
        return {"error": f"no record for {as_of.date()}"}, 20

    try:
        df = pd.read_csv(csv_path)
        manifest = json.loads(manifest_path.read_text())
        registry = load_registry()
        rule_spec, adapter, uni, panels, shares = env()

        from src.screen.engine import run_screen
        from src.trade.builder import build_trades
        control_res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
        control_survivors = set(control_res["survivors"]["ticker"]) if not control_res["survivors"].empty else set()
        trades = build_trades(control_res["survivors"], rule_spec)
        control_trades = set(trades["ticker"]) if not trades.empty else set()

        prev_audit = _prior_audit(as_of)
        picks_path = ROOT / "results" / "forward_test" / f"picks_{as_of.date()}.json"
        status_md = OUT / "run_status_latest.md"

        checks = [
            _au01(df, manifest, manifest["funnel"], countable_ids(registry), control_survivors, control_trades,
                  registry_mod.checksum(registry), panels, as_of),
            _au02(manifest),
            _au03(prev_audit),
            _au04(csv_path, manifest),
            _au05(manifest, picks_path),
            _au06(manifest, status_md),
            _au07(df, status_md),
            _au08(as_of, df),
            _au09(as_of),
            _au10(as_of),
        ]
    except Exception as e:  # pragma: no cover
        return {"error": str(e)}, 20

    overall = "FAIL" if any(c["status"] == "FAIL" for c in checks) else "PASS"

    graded_path = OUT / f"flags_{as_of.date()}_graded.csv"
    last_graded = {"signal_week": None, "eligible_mean_pct": None, "control_net_pct": None,
                   "t4_net_pct": None, "benchmark_pct": None}
    summary_path = OUT / f"flags_{as_of.date()}_graded.summary.json"
    if summary_path.exists():
        s = json.loads(summary_path.read_text())
        last_graded = {"signal_week": s.get("signal_week"), "eligible_mean_pct": s.get("eligible_mean_fwd_ret_oc_net_pct"),
                       "control_net_pct": s.get("control_basket_net_pct"), "t4_net_pct": s.get("t4_basket_net_pct"),
                       "benchmark_pct": s.get("benchmark_week_pct")}

    reasons = []
    if any(c["status"] == "FAIL" for c in checks):
        reasons.append("check_failed")
    if any(c["status"] == "WARN" for c in checks):
        reasons.append("check_warn")
    if manifest["recording_mode"] == "late_backfill":
        reasons.append("recording_mode_late_backfill")
    if prev_audit is None:
        reasons.append("first_record_for_registry_version")

    result = {
        "audit_schema_version": AUDIT_SCHEMA_VERSION,
        "as_of": str(as_of.date()),
        "recording_mode": manifest["recording_mode"],
        "overall": overall,
        "checks": checks,
        "facts": {
            "eligible_count": len(df),
            "flags_met_histogram": manifest.get("counts", {}).get("flags_met_histogram", {}),
            "t4_picks": sorted(df.loc[df.get("t4_selected") == 1, "ticker"].tolist()) if "t4_selected" in df else [],
            "control_trades": sorted(control_trades),
            "forward_weeks_graded": 0,
            "maturity": "TOO_EARLY",
            "last_graded": last_graded,
            "control_file_hashes": {f: _file_sha256(ROOT / f) for f in CONTROL_FILES},
        },
        "noteworthy": {"any": bool(reasons), "reasons": reasons},
        "inputs_sha256": {
            "flags_csv": csv_sha256(csv_path),
            "manifest": "sha256:" + hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        },
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    exit_code = 0 if overall == "PASS" else 10
    return result, exit_code


def render_markdown(result: dict) -> str:
    lines = [f"# Flag audit {result.get('as_of')}", "", f"overall: **{result.get('overall')}**", "",
             "| id | status | expected | actual |", "|---|---|---|---|"]
    for c in result.get("checks", []):
        lines.append(f"| {c['id']} | {c['status']} | {str(c['expected'])[:80]} | {str(c['actual'])[:80]} |")
    return "\n".join(lines) + "\n"
