"""
Threshold experiment (risk-cap sweep, shadow only): record / grade / summary / status.
Spec: docs/threshold-experiment-plan.md. Registry: config/threshold_experiment.yaml.

Everything is derived from Control's own weekly record — results/forward_test/picks_<wk>.json —
which already lists every survivor, including the ones the 15% cap rejected, and (after
`track_forward grade`) grades all of them. This CLI never screens, never reads prices and never
touches config/rules.yaml, run_screen() or build_trades().

usage:
  python3 -m tests.track_threshold record --picks results/forward_test/picks_<wk>.json
  python3 -m tests.track_threshold backfill               # record every picks file that has no threshold record
  python3 -m tests.track_threshold grade --all-pending    # grade every record whose picks file is graded
  python3 -m tests.track_threshold grade results/threshold_experiment/threshold_<wk>.json
  python3 -m tests.track_threshold summary [--mode forward|late_backfill|all]
  python3 -m tests.track_threshold status
  python3 -m tests.track_threshold registry-lock
"""
from __future__ import annotations

import glob
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from src.config import load_rule_spec
from src.experiments import threshold as tx
from src.flags.grade import append_ledger
from src.flags.timing import IST, monday_open_deadline, now_ist, resolve_mode

ROOT = Path(__file__).resolve().parents[1]
PICKS_DIR = ROOT / "results" / "forward_test"
OUT = ROOT / "results" / "threshold_experiment"
LEDGER = "threshold_ledger.csv"
LEDGER_KEY = ("experiment", "recording_mode", "signal_week", "arm")


def _registry() -> dict:
    return tx.load_registry(rule_spec=load_rule_spec(str(ROOT / "config" / "rules.yaml")))


def _is_control_picks(path: Path) -> bool:
    return path.name.startswith("picks_") and path.suffix == ".json" and not path.stem.endswith("_t1")


def _mode(picks: dict, as_of: pd.Timestamp, created_at: datetime) -> str:
    """forward only if BOTH Control's picks and this record were written before the holding
    week's Monday 09:15 IST open. Never passed in by a caller."""
    picks_created = datetime.fromisoformat(picks["created_utc"]).astimezone(IST)
    both_before = resolve_mode(as_of, picks_created) == "forward" and resolve_mode(as_of, created_at) == "forward"
    return "forward" if both_before else "late_backfill"


def record(picks_path_str: str, out_dir: Path = OUT, created_at: datetime | None = None) -> dict | None:
    picks_path = Path(picks_path_str)
    if not picks_path.exists():
        print(f"no Control picks file: {picks_path}")
        return None
    if not _is_control_picks(picks_path):
        print(f"not a Control picks file (T1 records are a different schema): {picks_path}")
        return None
    registry = _registry()
    picks = json.loads(picks_path.read_text())
    wk = picks["signal_week_start"]
    as_of = pd.Timestamp(wk)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"threshold_{wk}.json"
    if json_path.exists():
        print(f"REFUSING to overwrite an existing record: {json_path}")
        print("A threshold record is immutable, same rule as picks_*.json (HARNESS §4).")
        return None

    created_at = created_at or now_ist()
    rows, arms = tx.build_membership(picks.get("picks", []), registry)
    checks = tx.check_record(rows, arms, picks.get("picks", []), registry)
    rec = {
        "record_id": f"threshold_{wk}",
        "experiment": registry["experiment"],
        "registry_checksum": tx.checksum(registry),
        "caps_pct": registry["caps_pct"],
        "control_arm": tx.arm_name(registry["control_cap_pct"], registry["experiment"]),
        "created_utc": created_at.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "created_ist": created_at.astimezone(IST).isoformat(timespec="seconds"),
        "signal_week": wk,
        "holding_week": str((as_of + pd.Timedelta(weeks=1)).date()),
        "monday_open_deadline_ist": monday_open_deadline(as_of).isoformat(timespec="seconds"),
        "recording_mode": _mode(picks, as_of, created_at),
        "picks_file": str(picks_path.relative_to(ROOT)) if picks_path.is_relative_to(ROOT) else str(picks_path),
        "picks_record_id": picks.get("record_id"),
        "picks_created_utc": picks.get("created_utc"),
        "picks_fingerprint": tx.picks_fingerprint(picks),
        "rule": "SELECTED iff (signal_close - vstop_line_SL) / signal_close <= cap/100 (mirrors build_trades)",
        "n_survivors": len(rows),
        "arms": arms,
        "rows": rows,
        "checks": checks,
        "graded": None,
    }
    json_path.write_text(json.dumps(rec, indent=2, default=str))
    pd.DataFrame(rows).to_csv(out_dir / f"threshold_{wk}.csv", index=False)

    print(f"recorded {rec['record_id']} ({rec['recording_mode']}) -> {json_path}")
    for name, a in arms.items():
        print(f"  {name:<26} selected={len(a['selected'])} {a['selected']}  rejected={len(a['rejected'])}")
    for c in checks:
        print(f"  {c['id']} {c['status']} {c['detail'][:140]}")
    if any(c["status"] == "FAIL" for c in checks):
        print("CHECKS FAILED — record kept as written (not deleted or rewritten); investigate before grading.")
    return rec


def backfill(out_dir: Path = OUT, picks_dir: Path = PICKS_DIR) -> int:
    n = 0
    for p in sorted(picks_dir.glob("picks_*.json")):
        if not _is_control_picks(p):
            continue
        wk = json.loads(p.read_text())["signal_week_start"]
        if (out_dir / f"threshold_{wk}.json").exists():
            continue
        if record(str(p), out_dir) is not None:
            n += 1
    print(f"backfill: {n} new record(s)")
    return n


def grade(path_str: str, out_dir: Path = OUT) -> dict | None:
    path = Path(path_str)
    rec = json.loads(path.read_text())
    if rec.get("graded"):
        print(f"already graded: {path.name}")
        return rec["graded"]
    picks_path = ROOT / rec["picks_file"] if not Path(rec["picks_file"]).is_absolute() else Path(rec["picks_file"])
    picks = json.loads(picks_path.read_text())
    if not picks.get("graded"):
        print(f"Control record not graded yet ({picks_path.name}) — run `track_forward grade` first.")
        return None
    registry = _registry()
    block, ledger_rows, checks = tx.grade_record(rec, picks, registry)
    block["graded_utc"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rec["graded"] = block
    path.write_text(json.dumps(rec, indent=2, default=str))

    detail = {d["ticker"]: d for d in picks["graded"].get("detail", [])}
    graded_rows = [{**r, **{k: detail.get(r["ticker"], {}).get(k) for k in
                            ("EP_actual", "exit_reason", "exit_price", "ret_pct", "ret_pct_net", "r_multiple")}}
                   for r in rec["rows"]]
    pd.DataFrame(graded_rows).to_csv(out_dir / f"threshold_{rec['signal_week']}_graded.csv", index=False)
    if ledger_rows:
        append_ledger(out_dir / LEDGER, ledger_rows, LEDGER_KEY)

    print(f"=== GRADED {rec['record_id']} ({rec['recording_mode']}) ===")
    for name, v in block["per_arm"].items():
        print(f"  {name:<26} selected n={v['selected_n']:<2} net={v['selected_basket_net_pct']:>7}%  "
              f"rejected n={v['rejected_n']:<2} net={v['rejected_basket_net_pct']}%  "
              f"vs control={v['selected_minus_control_pct']:+}")
    for c in checks:
        print(f"  {c['id']} {c['status']} {c['detail'][:140]}")
    print("\n  One week is not evidence. Log it and move on.")
    return block


def grade_all_pending(out_dir: Path = OUT) -> int:
    n = 0
    for p in sorted(out_dir.glob("threshold_*.json")):
        rec = json.loads(p.read_text())
        if rec.get("graded"):
            continue
        if grade(str(p), out_dir) is not None:
            n += 1
    print(f"grade --all-pending: {n} graded")
    return n


def summary(mode: str = "forward", out_dir: Path = OUT) -> pd.DataFrame | None:
    registry = _registry()
    path = out_dir / LEDGER
    if not path.exists():
        print("No graded threshold weeks yet.")
        return None
    ledger = pd.read_csv(path)
    modes = ("forward", "late_backfill") if mode == "all" else (mode,)
    res = tx.summarize(ledger, registry, modes)
    stamp = now_ist().date()
    res.to_csv(out_dir / f"summary_{stamp}_{mode}.csv", index=False)

    def pct(v):
        return "—" if v is None or pd.isna(v) else f"{v:+.2f}%"

    lines = [f"# Threshold experiment — summary ({mode} weeks) — {stamp}", "",
             "Equal-weight 1-week net return per arm. SELECTED = survivors with R/EP <= cap; "
             "REJECTED = survivors above it. Weeks with no selected names count as 0.0%. "
             "Gate reads only at 26 forward weeks; nothing before 13 is a read.", "",
             "| arm | weeks | maturity | selected trades | hit rate | selected wk mean (CI95) | "
             "minus Control (CI95) | BH q | rejected trades | rejected wk mean (CI95) |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for _, r in res.iterrows():
        lines.append(
            f"| {r['arm']}{' (Control)' if r['is_control'] else ''} | {r['weeks']} | {r['maturity']} | "
            f"{r['selected_trades']} | {'—' if pd.isna(r['selected_hit_rate']) else r['selected_hit_rate']} | "
            f"{pct(r['selected_weekly_mean_pct'])} ({pct(r['selected_ci_lo'])}, {pct(r['selected_ci_hi'])}) | "
            f"{pct(r['minus_control_mean_pct'])} ({pct(r['minus_control_ci_lo'])}, {pct(r['minus_control_ci_hi'])}) | "
            f"{'—' if pd.isna(r['minus_control_q_bh']) else r['minus_control_q_bh']} | "
            f"{r['rejected_trades']} | {pct(r['rejected_weekly_mean_pct'])} "
            f"({pct(r['rejected_ci_lo'])}, {pct(r['rejected_ci_hi'])}) |")
    lines += ["", "Caveats: open-source data (no delisted names → returns biased upward; current share counts; "
              "yfinance adjustments unverified). See src/data/adapter.py KNOWN_CAVEATS."]
    md = "\n".join(lines) + "\n"
    (out_dir / "summary_latest.md").write_text(md)
    print(md)
    return res


def status(out_dir: Path = OUT) -> None:
    recs = sorted(out_dir.glob("threshold_*.json"))
    if not recs:
        print("no threshold records yet")
        return
    for p in recs:
        r = json.loads(p.read_text())
        fails = [c["id"] for c in r.get("checks", []) + (r.get("graded") or {}).get("checks", []) if c["status"] == "FAIL"]
        print(f"  {r['signal_week']}  mode={r['recording_mode']:<13} survivors={r['n_survivors']:<2} "
              f"graded={'yes' if r.get('graded') else 'no ':<3} fails={fails or '-'}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    args = sys.argv[2:]

    def _opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default

    if cmd == "record":
        sys.exit(0 if record(_opt("--picks")) is not None else 1)
    elif cmd == "backfill":
        backfill()
    elif cmd == "grade":
        if args and args[0] == "--all-pending":
            grade_all_pending()
        elif args:
            grade(args[0])
        else:
            print("usage: track_threshold grade <threshold_<wk>.json> | --all-pending")
    elif cmd == "summary":
        summary(_opt("--mode", "forward"))
    elif cmd == "status":
        status()
    elif cmd == "registry-lock":
        print(tx.write_checksum())
    else:
        print(__doc__)
