"""
Weekly feature-flag condition matrix: record / verify (Phase 1 of
docs/feature-flag-matrix-plan.md). Mirrors tests/track_forward.py's own
CLI conventions — same offline bootstrap (tests.offline.env), same
immutable-record-refuses-to-overwrite behaviour (HARNESS §4).

Phase 1 usage:
  python3 -m tests.track_flags preflight [--as-of auto|DATE]
  python3 -m tests.track_flags record --as-of auto|DATE
  python3 -m tests.track_flags verify DATE
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from src.flags import registry as registry_mod
from src.flags.checks import run_all
from src.flags.grade import append_ledger, grade_matrix
from src.flags.matrix import build_flag_matrix, csv_sha256
from src.flags.registry import countable_ids, load_registry
from src.flags.timing import monday_open_deadline, now_ist, resolve_mode, week_has_closed
from src.screen.engine import run_screen
from src.trade.builder import build_trades
from tests.offline import all_dates, env

OUT = Path(__file__).resolve().parents[1] / "results" / "feature_flags"
LEDGER_KEY = ("registry_version", "recording_mode", "signal_week", "ticker")


def _resolve_as_of(as_of_str: str, panels: dict) -> pd.Timestamp:
    if as_of_str in (None, "auto"):
        return all_dates(panels)[-1]
    return pd.Timestamp(as_of_str)


def preflight(as_of_str: str = "auto") -> int:
    rule_spec, adapter, uni, panels, shares = env()
    as_of = _resolve_as_of(as_of_str, panels)
    closed = week_has_closed(as_of)
    mode = resolve_mode(as_of)
    registry = load_registry()
    print(f"as_of={as_of.date()}  week_closed={closed}  mode={mode}")
    print(f"monday_open_deadline_ist={monday_open_deadline(as_of).isoformat()}  now_ist={now_ist().isoformat()}")
    print(f"registry_version={registry['registry_version']}  checksum={registry_mod.checksum(registry)}")
    if not closed:
        print("BLOCKER: week has not closed (G4) — refuse to record.")
        return 1
    return 0


def record(as_of_str: str = "auto"):
    rule_spec, adapter, uni, panels, shares = env()
    as_of = _resolve_as_of(as_of_str, panels)
    registry = load_registry()

    if not week_has_closed(as_of):
        print(f"REFUSING: week of {as_of.date()} has not closed yet (G4).")
        return None

    OUT.mkdir(parents=True, exist_ok=True)
    csv_path = OUT / f"flags_{as_of.date()}.csv"
    manifest_path = OUT / f"flags_{as_of.date()}.manifest.json"
    if csv_path.exists() or manifest_path.exists():
        print(f"REFUSING to overwrite an existing record: {csv_path}")
        print("A flag record is immutable, same rule as picks_*.json (HARNESS §4).")
        return None

    df, manifest = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares)

    t4_k = registry.get("t4", {}).get("k")
    if t4_k is not None and not df.empty:
        from src.flags.t4 import select_t4
        df = select_t4(df, t4_k, registry["t4"]["max_names"], registry["t4"]["tie_break"])
        manifest["t4"]["selected"] = sorted(df.loc[df["t4_selected"] == 1, "ticker"].tolist())

    control_res = run_screen(as_of, rule_spec, adapter, uni, panels, shares)
    control_survivors = set(control_res["survivors"]["ticker"]) if not control_res["survivors"].empty else set()
    trades = build_trades(control_res["survivors"], rule_spec)
    control_trades = set(trades["ticker"]) if not trades.empty else set()

    checks = run_all(df, manifest, manifest["funnel"], countable_ids(registry),
                      [f["id"] for f in registry["flags"]], control_survivors, control_trades,
                      registry_mod.checksum(registry), panels, as_of)
    manifest["checks"] = checks

    df.to_csv(csv_path, index=False)
    manifest["csv_sha256"] = csv_sha256(csv_path)
    manifest_path.write_text(json.dumps(manifest, indent=2, default=str))

    if not df.empty:
        ledger_rows = df[list(LEDGER_KEY) + [c for c in df.columns if c not in LEDGER_KEY]].to_dict("records")
        append_ledger(OUT / "flag_ledger_records.csv", ledger_rows, LEDGER_KEY)

    any_fail = any(c["status"] == "FAIL" for c in checks)
    print(f"recorded {len(df)} rows -> {csv_path} (mode={manifest['recording_mode']})")
    for c in checks:
        print(f"  {c['id']:4s} {c['status']:4s} {c['detail'][:150]}")
    if any_fail:
        print("\nCHECKS FAILED — see above. Record and manifest are kept (§8.5), not deleted or rewritten.")
    return df, manifest


def grade(date_str: str):
    csv_path = OUT / f"flags_{date_str}.csv"
    graded_path = OUT / f"flags_{date_str}_graded.csv"
    summary_path = OUT / f"flags_{date_str}_graded.summary.json"
    if not csv_path.exists():
        print(f"no record for {date_str} — nothing to grade.")
        return None
    if graded_path.exists():
        print(f"already graded: {graded_path} (skipped_already_done)")
        return None

    rule_spec, adapter, uni, panels, shares = env()
    as_of = pd.Timestamp(date_str)
    df = pd.read_csv(csv_path)
    graded_df, summary = grade_matrix(df, rule_spec, adapter, panels, as_of)

    if summary["n_missing_forward_bar"] and summary["n_missing_forward_bar"] == summary["n_rows"]:
        print(f"no forward bar yet for {date_str} — data not refreshed, or the holding week hasn't closed.")
        return None

    graded_df.to_csv(graded_path, index=False)
    summary_path.write_text(json.dumps(summary, indent=2, default=str))
    if not graded_df.empty:
        grade_rows = graded_df[list(LEDGER_KEY) + [c for c in graded_df.columns if c not in LEDGER_KEY]].to_dict("records")
        append_ledger(OUT / "flag_ledger_grades.csv", grade_rows, LEDGER_KEY)

    print(f"graded {date_str} -> {graded_path}")
    print(json.dumps(summary, indent=1, default=str))
    return graded_df, summary


def grade_all_pending():
    graded_any = False
    for p in sorted(OUT.glob("flags_*.csv")):
        if "_graded" in p.stem:
            continue
        date_str = p.stem.replace("flags_", "")
        graded_path = OUT / f"flags_{date_str}_graded.csv"
        if graded_path.exists():
            continue
        as_of = pd.Timestamp(date_str)
        if not week_has_closed(as_of + pd.Timedelta(weeks=1)):
            continue
        grade(date_str)
        graded_any = True
    if not graded_any:
        print("no pending records ready to grade.")


def verify(date_str: str) -> int:
    csv_path = OUT / f"flags_{date_str}.csv"
    manifest_path = OUT / f"flags_{date_str}.manifest.json"
    if not csv_path.exists() or not manifest_path.exists():
        print(f"no record for {date_str}")
        return 1
    df = pd.read_csv(csv_path)
    manifest = json.loads(manifest_path.read_text())

    a01_a03 = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1), "ticker"])
    a01_a03_a04 = set(df.loc[(df["A01_vstop_flip_up"] == 1) & (df["A03_rsi_in_band"] == 1)
                              & (df["A04_risk_cap_ok"] == 1), "ticker"])
    print(f"rows={len(df)}")
    print(f"A01&A03           = {sorted(a01_a03)}")
    print(f"A01&A03&A04       = {sorted(a01_a03_a04)}")
    print("\nchecks from record time:")
    any_fail = False
    for c in manifest.get("checks", []):
        print(f"  {c['id']:4s} {c['status']:4s} {c['detail'][:150]}")
        if c["status"] == "FAIL":
            any_fail = True
    return 1 if any_fail else 0


def replay(start_str: str, end_str: str):
    """§8.3: writes replay/flags_<wk>.csv + manifests + grades in one pass (future
    bars already exist in the cache). Calls the SAME build_flag_matrix() as the
    live path (G2/T-06) — never a parallel implementation. Each regeneration gets
    a new replay_run_id; replay files are not forward evidence and may be
    regenerated freely, but only under replay/."""
    rule_spec, adapter, uni, panels, shares = env()
    registry = load_registry()
    dates = [d for d in all_dates(panels)
             if pd.Timestamp(start_str) <= d <= pd.Timestamp(end_str)]

    replay_dir = OUT / "replay"
    replay_dir.mkdir(parents=True, exist_ok=True)
    replay_run_id = f"replay_{now_ist().isoformat(timespec='seconds')}"

    all_records, all_grades = [], []
    for as_of in dates:
        df, manifest = build_flag_matrix(as_of, rule_spec, registry, adapter, uni, panels, shares)
        if df.empty:
            continue
        df["recording_mode"] = "replay"
        manifest["recording_mode"] = "replay"
        manifest["replay_run_id"] = replay_run_id
        df.to_csv(replay_dir / f"flags_{as_of.date()}.csv", index=False)
        (replay_dir / f"flags_{as_of.date()}.manifest.json").write_text(json.dumps(manifest, indent=2, default=str))

        graded_df, summary = grade_matrix(df, rule_spec, adapter, panels, as_of)
        if not graded_df.empty:
            graded_df["recording_mode"] = "replay"
            graded_df.to_csv(replay_dir / f"flags_{as_of.date()}_graded.csv", index=False)
            all_grades.append(graded_df)
        all_records.append(df)

    if all_records:
        pd.concat(all_records, ignore_index=True).to_csv(replay_dir / "flag_ledger_records.csv", index=False)
    if all_grades:
        pd.concat(all_grades, ignore_index=True).to_csv(replay_dir / "flag_ledger_grades.csv", index=False)

    print(f"replay: {len(dates)} week(s), {len(all_grades)} graded -> {replay_dir} (run_id={replay_run_id})")
    return (pd.concat(all_records, ignore_index=True) if all_records else pd.DataFrame(),
            pd.concat(all_grades, ignore_index=True) if all_grades else pd.DataFrame())


def scorecard_cmd(mode: str = "forward"):
    from src.flags.scorecard import (
        flag_correlation_matrix, flag_scorecard, flags_met_bucket_table, flags_met_rank_ic, join_ledger,
    )

    if mode not in ("forward", "replay"):
        print("mode must be forward or replay")
        return None
    base = OUT if mode == "forward" else OUT / "replay"
    rec_path, grd_path = base / "flag_ledger_records.csv", base / "flag_ledger_grades.csv"
    if not rec_path.exists() or not grd_path.exists():
        print(f"no ledger data for mode={mode} yet.")
        return None

    records_df, grades_df = pd.read_csv(rec_path), pd.read_csv(grd_path)
    if mode == "forward":
        records_df = records_df[records_df["recording_mode"] == "forward"]
        grades_df = grades_df[grades_df["recording_mode"] == "forward"]

    merged = join_ledger(records_df, grades_df)
    registry = load_registry()
    ids = countable_ids(registry)
    card = flag_scorecard(merged, ids)
    ic = flags_met_rank_ic(merged)
    buckets = flags_met_bucket_table(merged)
    corr = flag_correlation_matrix(merged, ids)

    run_date = pd.Timestamp.now().date()
    card.to_csv(base / f"scorecard_{run_date}_{mode}.csv", index=False)
    corr.to_csv(base / f"scorecard_{run_date}_{mode}_correlation.csv")
    (base / "scorecard_latest.md").write_text(
        f"# Scorecard ({mode}), as of {run_date}\n\n"
        f"n_weeks in flags_met rank-IC: {ic['n_weeks']}, maturity={ic['maturity']}\n\n"
        "```\n" + card.to_string(index=False) + "\n```\n\n## flags_met buckets\n\n"
        "```\n" + buckets.to_string(index=False) + "\n```\n"
    )
    print(card.to_string(index=False))
    print(f"\nflags_met rank-IC: {json.dumps(ic, indent=1, default=str)}")
    print(f"\n{buckets.to_string(index=False)}")
    return card, ic, buckets, corr


def t4_calibrate_cmd():
    """§7.3 DEV/VALIDATE protocol against the replay ledger. Prints the result;
    does NOT write K -- that's a separate, deliberate registry-lock call once
    the result has been reviewed."""
    from src.flags.scorecard import join_ledger
    from src.flags.t4 import calibrate_k

    replay_dir = OUT / "replay"
    rec_path, grd_path = replay_dir / "flag_ledger_records.csv", replay_dir / "flag_ledger_grades.csv"
    if not rec_path.exists() or not grd_path.exists():
        print("no replay ledger yet -- run `replay --start ... --end ...` first.")
        return None

    records_df, grades_df = pd.read_csv(rec_path), pd.read_csv(grd_path)
    merged = join_ledger(records_df, grades_df)
    registry = load_registry()
    t4_cfg = registry["t4"]
    result = calibrate_k(merged, t4_cfg["k_grid"], t4_cfg["max_names"])
    print(json.dumps(result, indent=2, default=str))
    return result


def registry_lock_cmd(t4_k: str | None):
    k = int(t4_k) if t4_k is not None else None
    checksum = registry_mod.write_checksum(t4_k=k)
    print(f"registry locked: checksum={checksum}" + (f" t4.k={k}" if k is not None else ""))
    return checksum


LOCK_PATH = OUT / ".run.lock"
RUN_LOG_PATH = OUT / "run_log.jsonl"
STATUS_PATH = OUT / "run_status_latest.md"


def _write_run_log(run_id, trigger, picks_record_id, picks_created_utc, started_ist, as_of, mode,
                    stages, checks_summary, files_written, error):
    entry = {
        "run_id": run_id, "trigger": trigger, "picks_record_id": picks_record_id,
        "picks_created_utc": picks_created_utc, "started_ist": started_ist,
        "ended_ist": now_ist().isoformat(timespec="seconds"), "as_of": as_of, "mode": mode,
        "stages": stages, "checks_summary": checks_summary, "files_written": files_written, "error": error,
    }
    with open(RUN_LOG_PATH, "a") as f:
        f.write(json.dumps(entry, default=str) + "\n")
    return entry


def _write_status_md(as_of, mode, overall, eligible_count, top15, t4_picks, last_graded, maturity_line):
    from src.data.adapter import KNOWN_CAVEATS
    lines = [
        f"# Flag matrix status — {as_of}", "", f"mode: **{mode}**  overall: **{overall}**",
        f"eligible_count: {eligible_count}", "",
        "## Top 15 by flags_met", "",
    ]
    for r in top15:
        lines.append(f"- {r['ticker']}: flags_met={r['flags_met']}")
    lines.append("")
    lines.append("## T4 picks")
    lines.append("")
    if t4_picks:
        lines.append("**SHADOW — not for trading**")
        for t in t4_picks:
            lines.append(f"- {t}")
    else:
        lines.append("none (K not frozen for this registry version, or none qualified)")
    lines.append("")
    lines.append(f"## Last graded week: {last_graded}")
    lines.append("")
    lines.append(maturity_line)
    lines.append("")
    lines.append("## Caveats")
    for c in KNOWN_CAVEATS:
        lines.append(f"- {c}")
    STATUS_PATH.write_text("\n".join(lines) + "\n")


def on_selection(picks_path_str: str):
    """The trigger command (§11.1/§11.4): stages 0-6, keyed off the picks file
    Control's own record() just wrote. Never runs on its own clock."""
    picks_path = Path(picks_path_str)
    if not picks_path.exists():
        print(f"no selection run for this week: {picks_path} not found")
        sys.exit(3)
    picks = json.loads(picks_path.read_text())
    as_of_str = picks["signal_week_start"]
    as_of = pd.Timestamp(as_of_str)
    run_id = f"run_{now_ist().isoformat(timespec='seconds')}"
    started_ist = now_ist().isoformat(timespec="seconds")

    OUT.mkdir(parents=True, exist_ok=True)
    if LOCK_PATH.exists():
        print(f"lock held: {LOCK_PATH} -- another run in progress or a stale lock.")
        sys.exit(1)
    LOCK_PATH.write_text(run_id)
    stages, files_written = [], []
    try:
        t0 = time.time()
        closed = week_has_closed(as_of)
        stages.append({"name": "preflight", "status": "done" if closed else "blocked",
                        "seconds": round(time.time() - t0, 3), "detail": f"week_closed={closed}"})
        if not closed:
            _write_run_log(run_id, "selection_run", picks.get("record_id"), picks.get("created_utc"),
                            started_ist, as_of_str, "n/a", stages, {}, files_written, "week has not closed")
            print(f"BLOCKED: week of {as_of.date()} has not closed (G4).")
            sys.exit(3)

        stages.append({"name": "data", "status": "skipped_already_done", "seconds": 0.0,
                        "detail": "reuses the selection run's own cache — no second refresh"})

        t2 = time.time()
        grade_all_pending()
        stages.append({"name": "grade", "status": "done", "seconds": round(time.time() - t2, 3), "detail": "grade --all-pending"})

        csv_path = OUT / f"flags_{as_of.date()}.csv"
        manifest_path = OUT / f"flags_{as_of.date()}.manifest.json"
        t3 = time.time()
        if csv_path.exists():
            stages.append({"name": "record", "status": "skipped_already_done", "seconds": round(time.time() - t3, 3),
                            "detail": str(csv_path)})
            df = pd.read_csv(csv_path)
            manifest = json.loads(manifest_path.read_text())
        else:
            result = record(as_of_str)
            if result is None:
                stages.append({"name": "record", "status": "error", "seconds": round(time.time() - t3, 3),
                                "detail": "record() refused or failed"})
                _write_run_log(run_id, "selection_run", picks.get("record_id"), picks.get("created_utc"),
                                started_ist, as_of_str, "n/a", stages, {}, files_written, "record() failed")
                sys.exit(1)
            df, manifest = result
            files_written += [str(csv_path), str(manifest_path)]
            stages.append({"name": "record", "status": "done", "seconds": round(time.time() - t3, 3), "detail": str(csv_path)})

        stages.append({"name": "t4_picks", "status": "done" if manifest["t4"]["k"] is not None else "skipped_already_done",
                        "seconds": 0.0, "detail": f"t4.k={manifest['t4']['k']}"})
        stages.append({"name": "checks", "status": "done", "seconds": 0.0,
                        "detail": f"{sum(1 for c in manifest['checks'] if c['status'] == 'FAIL')} FAIL(s)"})
        stages.append({"name": "ledger", "status": "done", "seconds": 0.0, "detail": "flag_ledger_records.csv"})

        checks_summary = {"n_pass": sum(1 for c in manifest["checks"] if c["status"] == "PASS"),
                           "n_fail": sum(1 for c in manifest["checks"] if c["status"] == "FAIL"),
                           "n_warn": sum(1 for c in manifest["checks"] if c["status"] == "WARN")}
        overall = "FAILED" if checks_summary["n_fail"] else "PASS"

        top15 = df.sort_values("flags_met", ascending=False).head(15)[["ticker", "flags_met"]].to_dict("records") if not df.empty else []
        t4_picks = sorted(df.loc[df.get("t4_selected") == 1, "ticker"].tolist()) if "t4_selected" in df and df["t4_selected"].notna().any() else []
        graded_summary_path = OUT / f"flags_{as_of.date()}_graded.summary.json"
        last_graded = "none yet"
        if graded_summary_path.exists():
            s = json.loads(graded_summary_path.read_text())
            last_graded = f"{s.get('signal_week')} — control {s.get('control_basket_net_pct')}%"
        _write_status_md(as_of.date(), manifest["recording_mode"], overall, len(df), top15, t4_picks,
                          last_graded, "maturity: TOO_EARLY (first record for this registry version)")
        files_written.append(str(STATUS_PATH))

        _write_run_log(run_id, "selection_run", picks.get("record_id"), picks.get("created_utc"),
                        started_ist, as_of_str, manifest["recording_mode"], stages, checks_summary, files_written, None)
        print(f"on-selection complete for {as_of.date()}: {overall}")
    finally:
        LOCK_PATH.unlink(missing_ok=True)


def status():
    if not STATUS_PATH.exists():
        print("no run_status_latest.md yet.")
        return
    print(STATUS_PATH.read_text())


def audit_cmd(as_of_str: str, fmt: str) -> int:
    from src.flags.audit import AUDIT_DIR, render_markdown, run_audit

    result, code = run_audit(as_of_str)
    if code == 20:
        print(json.dumps(result, default=str))
        return 20

    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    (AUDIT_DIR / f"audit_{as_of_str}.json").write_text(json.dumps(result, indent=2, default=str))

    if fmt == "md":
        md = render_markdown(result)
        print(md)
    else:
        print(json.dumps(result, indent=2, default=str))
    return code


def findings_draft_cmd(as_of_str: str) -> int:
    from src.flags.findings import draft_findings

    text, code = draft_findings(as_of_str)
    print(text)
    return code


def findings_append_cmd(as_of_str: str) -> int:
    from src.flags.findings import append_findings

    return append_findings(as_of_str)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "record"
    args = sys.argv[2:]

    def _opt(name, default=None):
        if name in args:
            return args[args.index(name) + 1]
        return default

    if cmd == "preflight":
        sys.exit(preflight(_opt("--as-of", "auto")))
    elif cmd == "record":
        record(_opt("--as-of", "auto"))
    elif cmd == "verify":
        sys.exit(verify(args[0]))
    elif cmd == "grade":
        if args and args[0] == "--all-pending":
            grade_all_pending()
        elif args:
            grade(args[0])
        else:
            print("usage: track_flags grade <DATE> | --all-pending")
    elif cmd == "replay":
        replay(_opt("--start"), _opt("--end"))
    elif cmd == "scorecard":
        scorecard_cmd(_opt("--mode", "forward"))
    elif cmd == "t4-calibrate":
        t4_calibrate_cmd()
    elif cmd == "registry-lock":
        registry_lock_cmd(_opt("--t4-k"))
    elif cmd == "on-selection":
        on_selection(_opt("--picks"))
    elif cmd == "status":
        status()
    elif cmd == "audit":
        fmt = "md" if "--format" in args and _opt("--format") == "md" else "json"
        sys.exit(audit_cmd(_opt("--as-of"), fmt))
    elif cmd == "findings-draft":
        sys.exit(findings_draft_cmd(_opt("--as-of")))
    elif cmd == "findings-append":
        sys.exit(findings_append_cmd(_opt("--as-of")))
    else:
        print(__doc__)
