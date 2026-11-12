"""
Named data segments + a read ledger (docs/open-decisions-implementation-plan.md P2, A4).

A backtest or replay that reads RETURNS in a segment must call `assert_allowed()` with its dates
and `record_read()` once it has run. `holdout_ext` is one pass for at most two frozen finalists:
reading it needs `allow_holdout=True` AND an experiment id registered in config/experiments.yaml,
and every read is appended to results/evidence/segment_reads.csv (versioned).

Signal-week dates are Monday-dated weekly bars (signal = that week's Friday close).
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
READS = ROOT / "results" / "evidence" / "segment_reads.csv"

SEGMENTS = {
    # first signal week is set by data start + 30-bar warm-up; see findings 2026-09-16
    "holdout_ext": {"start": pd.Timestamp("2019-01-01"), "end": pd.Timestamp("2021-06-28"), "one_pass": True},
    # already read by the 104-week walk-forward, RSI study, flag replay and T4 calibration (2024-08..2026-08)
    "dev": {"start": pd.Timestamp("2021-07-05"), "end": pd.Timestamp("2026-08-31"), "one_pass": False},
    "forward": {"start": pd.Timestamp("2026-09-14"), "end": None, "one_pass": False},
}


def segment_of(as_of: pd.Timestamp) -> str:
    as_of = pd.Timestamp(as_of)
    for name, s in SEGMENTS.items():
        if as_of >= s["start"] and (s["end"] is None or as_of <= s["end"]):
            return name
    return "before_data"


def assert_allowed(dates, allow_holdout: bool = False, experiment_id: str | None = None) -> set[str]:
    segs = {segment_of(d) for d in dates}
    if "holdout_ext" in segs:
        if not allow_holdout:
            raise PermissionError("dates fall in holdout_ext — one pass for frozen finalists only; "
                                  "pass allow_holdout=True deliberately")
        from src.experiments.registry import get_experiment
        exp = get_experiment(experiment_id)
        if not exp.get("finalist"):
            raise PermissionError(f"{experiment_id} is not marked finalist: true in config/experiments.yaml")
        if holdout_reads(experiment_id):
            raise PermissionError(f"holdout_ext already read once for {experiment_id}; the answer stands")
    return segs


def holdout_reads(experiment_id: str | None = None) -> list[dict]:
    if not READS.exists():
        return []
    with open(READS) as f:
        rows = [r for r in csv.DictReader(f) if r["segment"] == "holdout_ext"]
    return [r for r in rows if experiment_id is None or r["experiment_id"] == experiment_id]


def record_read(experiment_id: str, segment: str, first_week, last_week, n_weeks: int, note: str = "") -> None:
    READS.parent.mkdir(parents=True, exist_ok=True)
    new = not READS.exists()
    with open(READS, "a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["read_utc", "experiment_id", "segment", "first_week", "last_week", "n_weeks", "note"])
        w.writerow([datetime.now(timezone.utc).isoformat(timespec="seconds"), experiment_id, segment,
                    str(pd.Timestamp(first_week).date()), str(pd.Timestamp(last_week).date()), n_weeks, note])
